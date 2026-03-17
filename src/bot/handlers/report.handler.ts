import type { BotContext } from "../types.js";
import { t } from "../../shared/i18n/index.js";
import { logger } from "../../shared/logger.js";

export const handleReportQuestion = async (ctx: BotContext, questionId: string): Promise<void> => {
  const lang = ctx.lang();
  
  logger.warn("Question reported by user", {
    event: "question.reported",
    userId: ctx.from?.id,
    questionId
  });

  await ctx.reply(t(lang, "test.reported_thanks"));
};
