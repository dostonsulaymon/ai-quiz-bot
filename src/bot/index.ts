import { Bot, session } from "grammy";
import type { Redis } from "ioredis";
import { config } from "../config/index.js";
import { registerCommandHandlers } from "./handlers/commands.js";
import { registerErrorMiddleware } from "./middlewares/errorMiddleware.js";
import { userMiddleware } from "./middlewares/userMiddleware.js";
import { RedisSessionStorage } from "./storage/redis-session.storage.js";
import type { BotContext, BotSession } from "./types.js";
import { createInitialSession } from "./types.js";
import { stateRouter } from "./router.js";
import { logger } from "../shared/logger.js";
import { t } from "../shared/i18n/index.js";

export const createBot = async (redis: Redis): Promise<Bot<BotContext>> => {
  const bot = new Bot<BotContext>(config.BOT_TOKEN);

  const attachRedis = (ctx: BotContext, next: () => Promise<void>) => {
    ctx.redis = redis;
    return next();
  };

  const sessionMiddleware = session({
    initial: createInitialSession,
    getSessionKey: (ctx) => {
      if (!ctx.from || !ctx.chat) {
        return undefined;
      }

      return `${ctx.from.id}:${ctx.chat.id}`;
    },
    storage: new RedisSessionStorage<BotSession>(redis, config.SESSION_TTL_SECONDS, (): BotSession => ({
      ...createInitialSession(),
      sessionRecovered: true
    }))
  });

  bot.use(attachRedis);
  bot.use(sessionMiddleware);

  // Set a default lang() before userMiddleware runs so any middleware that fires
  // before user detection has a safe fallback. userMiddleware overwrites it with
  // the real detected language.
  bot.use((ctx, next) => {
    ctx.lang = () => "en";
    return next();
  });

  // userMiddleware detects language and overwrites ctx.lang with the real value.
  bot.use(userMiddleware);

  // Session recovery reply now runs after userMiddleware so it can use ctx.lang().
  bot.use(async (ctx, next) => {
    if (ctx.session.sessionRecovered) {
      ctx.session.sessionRecovered = false;
      await ctx.reply(t(ctx.lang(), "error.generic"));
    }

    await next();
  });

  bot.use(async (ctx, next) => {
    logger.info("update received", {
      updateType: Object.keys(ctx.update).find((k) => k !== "update_id") ?? "unknown",
      callbackData: ctx.callbackQuery?.data ?? null,
      sessionState: ctx.session.state,
      chatId: ctx.chat?.id,
      lang: ctx.lang()
    });
    await next();
  });

  bot.use(stateRouter);

  bot.callbackQuery("error:retry", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(t(ctx.lang(), "commands.cancelled"));
  });

  await registerCommandHandlers(bot);
  registerErrorMiddleware(bot);

  logger.info("Bot middleware initialized");

  return bot;
};
