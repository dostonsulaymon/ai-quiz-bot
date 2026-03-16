import * as Sentry from "@sentry/node";
import { createServer } from "node:http";
import mongoose from "mongoose";
import { createBot } from "./bot/index.js";
import { config } from "./config/index.js";
import { connectToDatabase } from "./db/connection.js";
import { createRedisClient } from "./redis/index.js";
import { GroupSessionRepository } from "./db/repositories/group-session.repository.js";
import { TestSessionRepository } from "./db/repositories/test-session.repository.js";
import { TestRepository } from "./db/repositories/test.repository.js";
import { runGroupAutoAdvance } from "./bot/handlers/group.handler.js";
import { logger } from "./shared/logger.js";
import { getMetrics } from "./shared/metrics.js";
import type { BotSession } from "./bot/types.js";
import type { Language } from "./shared/i18n/index.js";

if (config.SENTRY_DSN) {
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    tracesSampleRate: 0.1
  });
  logger.info("Sentry error tracking initialized");
}

const SESSION_KEY_PREFIX = "quiz-bot:session:";

const runSessionCleanup = async (
  groupSessionRepo: GroupSessionRepository,
  testSessionRepo: TestSessionRepository
): Promise<{ abandonedGroups: number; abandonedTests: number }> => {
  const [abandonedGroups, abandonedTests] = await Promise.all([
    groupSessionRepo.abandonStaleSessions(config.STALE_GROUP_SESSION_TTL_MS),
    testSessionRepo.abandonStaleSessions(config.ABANDONED_SESSION_TTL_MS)
  ]);

  return { abandonedGroups, abandonedTests };
};

/** Mark expired private-test timers in Redis so the next user interaction auto-advances. */
const recoverExpiredPrivateTimers = async (redis: Awaited<ReturnType<typeof createRedisClient>>): Promise<void> => {
  const keys = await redis.keys(`${SESSION_KEY_PREFIX}*`);
  let recovered = 0;

  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;

    let session: BotSession;
    try {
      session = JSON.parse(raw) as BotSession;
    } catch {
      continue;
    }

    if (
      session.state !== "testing" ||
      !(session.timeLimitSeconds ?? 0) ||
      !session.questionStartedAt ||
      !session.testQuestionMessageId
    ) continue;

    const elapsed = (Date.now() - session.questionStartedAt) / 1000;
    if (elapsed > session.timeLimitSeconds!) {
      // Clear the timestamp — handleAnswering will detect this sentinel and auto-advance.
      session.questionStartedAt = undefined;
      await redis.set(key, JSON.stringify(session), "KEEPTTL");
      recovered++;
    }
  }

  if (recovered > 0) {
    logger.info("Cleared expired private test timers on startup", { event: "startup.private_timer.recovered", recovered });
  }
};

/** Trigger auto-advance for group sessions whose question timer expired while the bot was offline. */
const recoverExpiredGroupTimers = async (
  groupSessionRepo: GroupSessionRepository,
  testRepo: TestRepository,
  botApi: Awaited<ReturnType<typeof createBot>>["api"]
): Promise<void> => {
  const activeSessions = await groupSessionRepo.findAllActive();
  let recovered = 0;

  await Promise.all(
    activeSessions.map(async (session) => {
      if (!session.questionSentAt) return;

      const test = await testRepo.findById(String(session.testId));
      if (!test || test.timeLimitSeconds <= 0) return;

      const elapsed = (Date.now() - session.questionSentAt.getTime()) / 1000;
      if (elapsed > test.timeLimitSeconds) {
        recovered++;
        const lang = (session.hostLanguage ?? "en") as Language;
        await runGroupAutoAdvance(botApi, session.chatId, String(session._id), session.currentQuestionIndex, test, lang);
      }
    })
  );

  if (recovered > 0) {
    logger.info("Triggered auto-advance for expired group timers on startup", { event: "startup.group_timer.recovered", recovered });
  }
};

const bootstrap = async (): Promise<void> => {
  const monitoringPort = Number(process.env.PORT) || config.HEALTH_CHECK_PORT;
  const monitoringServer = createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/metrics" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getMetrics()));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  await new Promise<void>((resolve, reject) => {
    monitoringServer.once("error", reject);
    monitoringServer.listen(monitoringPort, () => {
      monitoringServer.off("error", reject);
      logger.info("Monitoring HTTP server started", {
        event: "monitoring.server.started",
        port: monitoringPort
      });
      resolve();
    });
  });

  const redis = createRedisClient();
  await redis.connect();
  await connectToDatabase();

  const groupSessionRepo = new GroupSessionRepository();
  const testSessionRepo = new TestSessionRepository();
  const testRepo = new TestRepository();

  const { abandonedGroups, abandonedTests } = await runSessionCleanup(groupSessionRepo, testSessionRepo);
  if (abandonedGroups > 0) {
    logger.info("Cleaned up orphaned group sessions on startup", {
      event: "startup.group_sessions.cleanup",
      abandonedGroups
    });
  }
  if (abandonedTests > 0) {
    logger.info("Cleaned up abandoned test sessions on startup", {
      event: "startup.test_sessions.cleanup",
      abandonedTests
    });
  }

  await recoverExpiredPrivateTimers(redis);

  const bot = await createBot(redis);

  await recoverExpiredGroupTimers(groupSessionRepo, testRepo, bot.api);

  await bot.start({
    allowed_updates: ["message", "callback_query"],
    onStart: () => {
      console.info(`[bot] Quiz Bot started in ${config.NODE_ENV} mode`);
    }
  });

  const cleanupInterval = setInterval(() => {
    void (async () => {
      try {
        const { abandonedGroups: groups, abandonedTests: tests } = await runSessionCleanup(groupSessionRepo, testSessionRepo);
        if (groups > 0 || tests > 0) {
          logger.info("Hourly session cleanup completed", {
            event: "startup.session_cleanup.hourly",
            groups,
            tests
          });
        }
      } catch (error) {
        logger.error("Hourly session cleanup failed", {
          event: "startup.session_cleanup.hourly_failed",
          error: error instanceof Error ? error.message : String(error)
        });
        if (config.SENTRY_DSN) {
          Sentry.captureException(error);
        }
      }
    })();
  }, 60 * 60 * 1000);
  cleanupInterval.unref();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.info(`[app] Received ${signal}, shutting down gracefully`);

    await bot.stop();
    await Promise.allSettled([
      new Promise<void>((resolve, reject) => {
        monitoringServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
      mongoose.disconnect(),
      redis.quit()
    ]);

    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
};

void bootstrap().catch(async (error: unknown) => {
  console.error("[app] Failed to start application", error);
  if (config.SENTRY_DSN) {
    Sentry.captureException(error);
    await Sentry.flush(2_000).catch(() => undefined);
  }
  process.exit(1);
});
