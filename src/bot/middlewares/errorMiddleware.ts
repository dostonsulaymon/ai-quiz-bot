import { InlineKeyboard, type BotError, type Bot as GrammyBot } from "grammy";
import { AppError } from "../../shared/errors/AppError.js";
import { logger } from "../../shared/logger.js";
import type { BotContext } from "../types.js";

const RETRY_CALLBACK = "error:retry";

const toAppError = (error: unknown): AppError => {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError("Unhandled application error", {
    statusCode: 500,
    code: "UNEXPECTED_ERROR",
    userMessage: "Something went wrong on my side. Please try again in a moment.",
    isRetryable: false,
    details: error
  });
};

export const registerErrorMiddleware = (bot: GrammyBot<BotContext>): void => {
  bot.catch(async (error: BotError<BotContext>) => {
    const appError = toAppError(error.error);
    logger.error("Unhandled bot error", {
      code: appError.code,
      userId: error.ctx.from?.id,
      updateType: Object.keys(error.ctx.update)[0] ?? "unknown",
      stack: error.error instanceof Error ? error.error.stack : undefined,
      details: appError.details
    });

    try {
      const keyboard = appError.isRetryable
        ? new InlineKeyboard().text("🔄 Try Again", RETRY_CALLBACK)
        : undefined;

      await error.ctx.reply(appError.userMessage, {
        reply_markup: keyboard
      });
    } catch (replyError) {
      logger.error("Failed to send error reply", {
        userId: error.ctx.from?.id,
        stack: replyError instanceof Error ? replyError.stack : undefined
      });
    }
  });
};
