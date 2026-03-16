import mongoose from "mongoose";
import { createBot } from "./bot/index.js";
import { config } from "./config/index.js";
import { connectToDatabase } from "./db/connection.js";
import { createRedisClient } from "./redis/index.js";

const bootstrap = async (): Promise<void> => {
  const redis = createRedisClient();
  await redis.connect();
  await connectToDatabase();

  const bot = await createBot(redis);
  await bot.start({
    allowed_updates: ["message", "callback_query"],
    onStart: () => {
      console.info(`[bot] Quiz Bot started in ${config.NODE_ENV} mode`);
    }
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.info(`[app] Received ${signal}, shutting down gracefully`);

    await bot.stop();
    await Promise.allSettled([mongoose.disconnect(), redis.quit()]);

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
  process.exit(1);
});
