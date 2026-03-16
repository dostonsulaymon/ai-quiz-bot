import { InlineKeyboard, type Bot } from "grammy";
import type { BotContext } from "../types.js";
import { TestSessionRepository } from "../../db/repositories/test-session.repository.js";
import type { Question } from "../../shared/types/index.js";
import { t, type Language } from "../../shared/i18n/index.js";
import { formatDate } from "../utils/format.js";

const HISTORY_PAGE_SIZE = 10;
const HISTORY_PAGE_CALLBACK_PREFIX = "history:page:";
const HISTORY_DETAILS_CALLBACK_PREFIX = "history:details:";
const HISTORY_BACK_CALLBACK_PREFIX = "history:back:";
const HISTORY_NOOP_CALLBACK = "history:noop";

const testSessionRepository = new TestSessionRepository();

const buildPaginationRow = (page: number, totalPages: number, prefix: string, lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text("◀", `${prefix}${Math.max(1, page - 1)}:${page}`)
    .text(t(lang, "pagination.page", { page, total: totalPages }), HISTORY_NOOP_CALLBACK)
    .text("▶", `${prefix}${Math.min(totalPages, page + 1)}:${page}`);

const renderHistoryPage = async (userId: string, page: number, lang: Language): Promise<{ text: string; keyboard: InlineKeyboard }> => {
  const totalItems = await testSessionRepository.countByUser(userId);
  const totalPages = Math.max(1, Math.ceil(totalItems / HISTORY_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const sessions = await testSessionRepository.findByUserPaginated(userId, currentPage, HISTORY_PAGE_SIZE);

  const lines = sessions.flatMap((session, index) => {
    const test = session.testId as {
      title?: string;
      shareCode?: string;
      questionCount?: number;
    } | null;

    return [
      t(lang, "history.sessionRow", {
        n: index + 1,
        title: test?.title?.trim() || t(lang, "common.untitled"),
        score: session.score,
        correct: session.correctCount,
        total: session.totalQuestions
      }),
      t(lang, "history.sessionMeta", {
        date: formatDate(session.completedAt ?? session.startedAt, true, lang),
        total: session.totalQuestions
      }),
      ""
    ];
  });

  const text = [t(lang, "history.header"), "", ...lines].join("\n").trim();
  const keyboard = new InlineKeyboard();

  sessions.forEach((session, index) => {
    keyboard.text(t(lang, "history.btn.viewDetails", { n: index + 1 }), `${HISTORY_DETAILS_CALLBACK_PREFIX}${String(session._id)}:${currentPage}`).row();
  });

  keyboard.append(buildPaginationRow(currentPage, totalPages, HISTORY_PAGE_CALLBACK_PREFIX, lang));

  return { text, keyboard };
};

const renderHistoryDetails = async (
  sessionId: string,
  page: number,
  lang: Language,
  userId: import("mongoose").Types.ObjectId
): Promise<{ text: string; keyboard: InlineKeyboard } | null> => {
  const session = await testSessionRepository.findByIdAndUser(sessionId, userId);
  if (!session) {
    return {
      text: t(lang, "history.sessionNotFound"),
      keyboard: new InlineKeyboard().text(t(lang, "history.btn.back"), `${HISTORY_BACK_CALLBACK_PREFIX}${page}`)
    };
  }

  const test = session.testId as {
    title?: string;
    questions?: Question[];
  } | null;

  if (!test) {
    return null;
  }

  const questions = test?.questions ?? [];

  const breakdown = questions.map((question, index) => {
    const answer = session.answers.find((item) => item.questionId === question.id);
    const status = answer?.isCorrect ? "✅" : "❌";
    const userAnswer = answer?.userAnswer ?? t(lang, "history.noAnswer");

    return [
      t(lang, "history.detail.questionRow", { n: index + 1, status, question: question.question }),
      t(lang, "history.detail.yourAnswer", { answer: userAnswer }),
      t(lang, "history.detail.correctAnswer", { answer: question.correctAnswer })
    ].join("\n");
  });

  return {
    text: [
      `📝 ${test?.title?.trim() || t(lang, "common.untitled")}`,
      t(lang, "history.detail.score", { score: session.score, correct: session.correctCount, total: session.totalQuestions }),
      `📅 ${formatDate(session.completedAt ?? session.startedAt, true, lang)}`,
      "",
      ...breakdown
    ].join("\n\n"),
    keyboard: new InlineKeyboard().text(t(lang, "history.btn.back"), `${HISTORY_BACK_CALLBACK_PREFIX}${page}`)
  };
};

export const registerHistoryHandler = (bot: Bot<BotContext>): void => {
  bot.command("history", async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.reply(t(lang, "error.userLoad"));
      return;
    }

    const totalItems = await testSessionRepository.countByUser(ctx.user._id);
    if (totalItems === 0) {
      await ctx.reply(t(lang, "history.noSessions"));
      return;
    }

    const { text, keyboard } = await renderHistoryPage(String(ctx.user._id), 1, lang);
    await ctx.reply(text, { reply_markup: keyboard });
  });

  bot.callbackQuery(new RegExp(`^${HISTORY_PAGE_CALLBACK_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }

    const payload = ctx.callbackQuery.data.slice(HISTORY_PAGE_CALLBACK_PREFIX.length);
    const [pageStr, currentPageStr] = payload.split(":");
    const page = Number(pageStr);
    const currentPage = Number(currentPageStr ?? pageStr);

    if (page === currentPage) {
      await ctx.answerCallbackQuery({
        text: t(lang, page <= 1 ? "pagination.already_first" : "pagination.already_last")
      });
      return;
    }

    const { text, keyboard } = await renderHistoryPage(String(ctx.user._id), page, lang);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, { reply_markup: keyboard });
  });

  bot.callbackQuery(new RegExp(`^${HISTORY_DETAILS_CALLBACK_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery();
      return;
    }

    const payload = ctx.callbackQuery.data.slice(HISTORY_DETAILS_CALLBACK_PREFIX.length);
    const [sessionId, pageValue] = payload.split(":");
    const page = Number(pageValue ?? "1");

    const result = await renderHistoryDetails(sessionId ?? "", page, lang, ctx.user._id);
    if (!result) {
      await ctx.answerCallbackQuery();
      await ctx.reply(t(lang, "error.test_deleted"));
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(result.text, { reply_markup: result.keyboard });
  });

  bot.callbackQuery(new RegExp(`^${HISTORY_BACK_CALLBACK_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }

    const page = Number(ctx.callbackQuery.data.slice(HISTORY_BACK_CALLBACK_PREFIX.length));
    const { text, keyboard } = await renderHistoryPage(String(ctx.user._id), page, lang);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, { reply_markup: keyboard });
  });

  bot.callbackQuery(HISTORY_NOOP_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery();
  });
};
