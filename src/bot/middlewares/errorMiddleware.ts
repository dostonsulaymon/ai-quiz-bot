import type { BotError, Bot as GrammyBot } from "grammy";
import type { BotContext } from "../types.js";

export const registerErrorMiddleware = (bot: GrammyBot<BotContext>): void => {
  bot.catch(async (error: BotError<BotContext>) => {
    console.error("[bot] Unhandled error", error.error);

    try {
      await error.ctx.reply("Something went wrong on my side. Please try again in a moment.");
    } catch (replyError) {
      console.error("[bot] Failed to send error reply", replyError);
    }
  });
};
