import { Bot, session } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";
import type { Redis } from "ioredis";
import { config } from "../config/index.js";
import { registerCommandHandlers } from "./handlers/commands.js";
import { registerErrorMiddleware } from "./middlewares/errorMiddleware.js";
import { userMiddleware } from "./middlewares/userMiddleware.js";
import { reviewScene, REVIEW_CONVERSATION_NAME } from "./scenes/review.scene.js";
import { testScene, TEST_CONVERSATION_NAME } from "./scenes/test.scene.js";
import { uploadScene, UPLOAD_CONVERSATION_NAME } from "./scenes/upload.scene.js";
import { RedisSessionStorage } from "./storage/redis-session.storage.js";
import type { BotContext, BotSession } from "./types.js";
import { createInitialSession } from "./types.js";
import { logger } from "../shared/logger.js";

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
    storage: new RedisSessionStorage<BotSession>(redis, undefined, (): BotSession => ({
      ...createInitialSession(),
      sessionRecovered: true
    }))
  });

  bot.use(attachRedis);
  bot.use(sessionMiddleware);

  bot.use(async (ctx, next) => {
    if (ctx.session.sessionRecovered) {
      ctx.session.sessionRecovered = false;
      await ctx.reply("Something went wrong with your session. Starting fresh! 🔄");
    }

    await next();
  });

  // userMiddleware must run before conversations so that ctx.user is populated
  // inside conversation bodies (conversations intercept the update and never
  // pass it further down the middleware chain).
  bot.use(userMiddleware);

  bot.use(
    conversations({
      plugins: [attachRedis]
    })
  );
  bot.use(createConversation(uploadScene, UPLOAD_CONVERSATION_NAME));
  bot.use(createConversation(reviewScene, REVIEW_CONVERSATION_NAME));
  bot.use(createConversation(testScene, TEST_CONVERSATION_NAME));
  bot.use(async (ctx, next) => {
    await next();

    // Only auto-restore a suspended conversation when no conversation is
    // currently active for this update.  Checking AFTER next() means the
    // conversations middleware has already had a chance to resume an existing
    // conversation; if none was active we may need to re-enter one whose state
    // was persisted across a bot restart.
    if (Object.keys(ctx.conversation.active()).length > 0) {
      return;
    }

    if (ctx.session.state === "reviewing" && (ctx.session.draftQuestions?.length ?? 0) > 0) {
      await ctx.conversation.enter(REVIEW_CONVERSATION_NAME);
      return;
    }

    if (ctx.session.state === "testing" && ctx.session.activeTestId) {
      await ctx.conversation.enter(TEST_CONVERSATION_NAME);
    }
  });

  bot.callbackQuery("error:retry", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Please retry the last step when you’re ready.");
  });

  await registerCommandHandlers(bot);
  registerErrorMiddleware(bot);

  logger.info("Bot middleware initialized");

  return bot;
};
