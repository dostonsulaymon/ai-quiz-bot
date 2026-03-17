import * as Sentry from "@sentry/node";
import { InlineKeyboard, type BotError, type Bot as GrammyBot } from "grammy";
import { config } from "../../config/index.js";
import { AppError } from "../../shared/errors/AppError.js";
import { logger } from "../../shared/logger.js";
import { recordError } from "../../shared/metrics.js";
import type { BotContext } from "../types.js";
import { t } from "../../shared/i18n/index.js";
import { NAV_MAIN_MENU_CALLBACK } from "../handlers/commands.js";

const RETRY_CALLBACK = "error:retry";

const toAppError = (error: unknown): AppError => {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError("Unhandled application error", {
    statusCode: 500,
    code: "UNEXPECTED_ERROR",
    userMessage: "GENERIC",
    isRetryable: false,
    details: error
  });
};

export const registerErrorMiddleware = (bot: GrammyBot<BotContext>): void => {
  bot.catch(async (error: BotError<BotContext>) => {
    const lang = error.ctx.lang();
    const appError = toAppError(error.error);
    const updateType = Object.keys(error.ctx.update).find(k => k !== "update_id") ?? "unknown";
    recordError();
    logger.error("Unhandled bot error", {
      code: appError.code,
      userId: error.ctx.from?.id,
      updateType,
      stack: error.error instanceof Error ? error.error.stack : undefined,
      details: appError.details
    });

    if (config.SENTRY_DSN) {
      Sentry.captureException(error.error, {
        extra: {
          userId: error.ctx.from?.id,
          updateType,
          sessionState: (error.ctx.from && error.ctx.chat) ? error.ctx.session?.state : "N/A"
        }
      });
    }

    try {
      const keyboard = appError.isRetryable
        ? new InlineKeyboard()
            .text(t(lang, "error.btn.tryAgain"), RETRY_CALLBACK)
            .text(t(lang, "deadend.btn.main_menu"), NAV_MAIN_MENU_CALLBACK)
        : new InlineKeyboard().text(t(lang, "deadend.btn.main_menu"), NAV_MAIN_MENU_CALLBACK);

      const message =
        appError.code === "UNEXPECTED_ERROR" || appError.userMessage === "GENERIC"
          ? t(lang, "error.generic")
          : t(lang, appError.userMessage as any, appError.details as Record<string, string | number>);

      if (error.ctx.chatId) {
        await error.ctx.reply(message, {
          reply_markup: keyboard
        });
      }
    } catch (replyError) {
      logger.error("Failed to send error reply", {
        userId: error.ctx.from?.id,
        stack: replyError instanceof Error ? replyError.stack : undefined
      });
    }
  });
};
