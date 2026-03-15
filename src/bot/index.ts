import { Bot, session } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";
import type { Redis } from "ioredis";
import { config } from "../config/index.js";
import { registerCommandHandlers } from "./handlers/commands.js";
import { rateLimitMiddleware } from "./middlewares/rateLimitMiddleware.js";
import { registerErrorMiddleware } from "./middlewares/errorMiddleware.js";
import { userMiddleware } from "./middlewares/userMiddleware.js";
import { reviewScene, REVIEW_CONVERSATION_NAME } from "./scenes/review.scene.js";
import { testScene, TEST_CONVERSATION_NAME } from "./scenes/test.scene.js";
import { uploadScene, UPLOAD_CONVERSATION_NAME } from "./scenes/upload.scene.js";
import { RedisSessionStorage } from "./storage/redis-session.storage.js";
import type { BotContext } from "./types.js";
import { createInitialSession } from "./types.js";

export const createBot = async (redis: Redis): Promise<Bot<BotContext>> => {
  const bot = new Bot<BotContext>(config.BOT_TOKEN);

  bot.use((ctx, next) => {
    ctx.redis = redis;
    return next();
  });

  bot.use(
    session({
      initial: createInitialSession,
      getSessionKey: (ctx) => {
        if (!ctx.from || !ctx.chat) {
          return undefined;
        }

        return `${ctx.from.id}:${ctx.chat.id}`;
      },
      storage: new RedisSessionStorage(redis)
    })
  );

  bot.use(conversations());
  bot.use(createConversation(uploadScene, UPLOAD_CONVERSATION_NAME));
  bot.use(createConversation(reviewScene, REVIEW_CONVERSATION_NAME));
  bot.use(createConversation(testScene, TEST_CONVERSATION_NAME));
  bot.use(userMiddleware);
  bot.use(rateLimitMiddleware);

  await registerCommandHandlers(bot);
  registerErrorMiddleware(bot);

  return bot;
};
