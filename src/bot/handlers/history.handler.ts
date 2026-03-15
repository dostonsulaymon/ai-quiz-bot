import { InlineKeyboard, type Bot } from "grammy";
import type { BotContext } from "../types.js";
import { TestSessionRepository } from "../../db/repositories/test-session.repository.js";
import type { Question } from "../../shared/types/index.js";

const HISTORY_PAGE_SIZE = 10;
const HISTORY_PAGE_CALLBACK_PREFIX = "history:page:";
const HISTORY_DETAILS_CALLBACK_PREFIX = "history:details:";
const HISTORY_BACK_CALLBACK_PREFIX = "history:back:";
const HISTORY_NOOP_CALLBACK = "history:noop";

const testSessionRepository = new TestSessionRepository();

const formatDate = (value: Date | string | undefined): string =>
  value
    ? new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric"
      }).format(new Date(value))
    : "Unknown date";

const buildPaginationRow = (page: number, totalPages: number, prefix: string): InlineKeyboard =>
  new InlineKeyboard()
    .text("◀", `${prefix}${Math.max(1, page - 1)}`)
    .text(`Page ${page}/${totalPages}`, HISTORY_NOOP_CALLBACK)
    .text("▶", `${prefix}${Math.min(totalPages, page + 1)}`);

const renderHistoryPage = async (userId: string, page: number): Promise<{ text: string; keyboard: InlineKeyboard }> => {
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
      `${index + 1}. 📝 ${test?.title?.trim() || "Untitled"} — Score: ${session.score}% (${session.correctCount}/${session.totalQuestions})`,
      `📅 ${formatDate(session.completedAt ?? session.startedAt)}  •  ${session.totalQuestions} questions`,
      ""
    ];
  });

  const text = ["Your Recent Test Sessions", "", ...lines].join("\n").trim();
  const keyboard = new InlineKeyboard();

  sessions.forEach((session, index) => {
    keyboard.text(`View Details ${index + 1}`, `${HISTORY_DETAILS_CALLBACK_PREFIX}${String(session._id)}:${currentPage}`).row();
  });

  keyboard.append(buildPaginationRow(currentPage, totalPages, HISTORY_PAGE_CALLBACK_PREFIX));

  return { text, keyboard };
};

const renderHistoryDetails = async (
  sessionId: string,
  page: number
): Promise<{ text: string; keyboard: InlineKeyboard }> => {
  const session = await testSessionRepository.findByIdWithTest(sessionId);
  if (!session) {
    return {
      text: "That test session could not be found.",
      keyboard: new InlineKeyboard().text("◀ Back", `${HISTORY_BACK_CALLBACK_PREFIX}${page}`)
    };
  }

  const test = session.testId as {
    title?: string;
    questions?: Question[];
  } | null;
  const questions = test?.questions ?? [];

  const breakdown = questions.map((question, index) => {
    const answer = session.answers.find((item) => item.questionId === question.id);
    const status = answer?.isCorrect ? "✅" : "❌";
    const userAnswer = answer?.userAnswer ?? "No answer";

    return [
      `${index + 1}. ${status} ${question.question}`,
      `Your answer: ${userAnswer}`,
      `Correct: ${question.correctAnswer}`
    ].join("\n");
  });

  return {
    text: [
      `📝 ${test?.title?.trim() || "Untitled"}`,
      `Score: ${session.score}% (${session.correctCount}/${session.totalQuestions})`,
      `📅 ${formatDate(session.completedAt ?? session.startedAt)}`,
      "",
      ...breakdown
    ].join("\n\n"),
    keyboard: new InlineKeyboard().text("◀ Back", `${HISTORY_BACK_CALLBACK_PREFIX}${page}`)
  };
};

export const registerHistoryHandler = (bot: Bot<BotContext>): void => {
  bot.command("history", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("I couldn't load your account right now.");
      return;
    }

    const totalItems = await testSessionRepository.countByUser(ctx.user._id);
    if (totalItems === 0) {
      await ctx.reply("You haven't taken any tests yet. Use /newtest to create one!");
      return;
    }

    const { text, keyboard } = await renderHistoryPage(String(ctx.user._id), 1);
    await ctx.reply(text, { reply_markup: keyboard });
  });

  bot.callbackQuery(new RegExp(`^${HISTORY_PAGE_CALLBACK_PREFIX}`), async (ctx) => {
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: "User session missing.", show_alert: false });
      return;
    }

    const page = Number(ctx.callbackQuery.data.slice(HISTORY_PAGE_CALLBACK_PREFIX.length));
    const { text, keyboard } = await renderHistoryPage(String(ctx.user._id), page);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, { reply_markup: keyboard });
  });

  bot.callbackQuery(new RegExp(`^${HISTORY_DETAILS_CALLBACK_PREFIX}`), async (ctx) => {
    const payload = ctx.callbackQuery.data.slice(HISTORY_DETAILS_CALLBACK_PREFIX.length);
    const [sessionId, pageValue] = payload.split(":");
    const page = Number(pageValue ?? "1");

    const { text, keyboard } = await renderHistoryDetails(sessionId ?? "", page);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, { reply_markup: keyboard });
  });

  bot.callbackQuery(new RegExp(`^${HISTORY_BACK_CALLBACK_PREFIX}`), async (ctx) => {
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: "User session missing.", show_alert: false });
      return;
    }

    const page = Number(ctx.callbackQuery.data.slice(HISTORY_BACK_CALLBACK_PREFIX.length));
    const { text, keyboard } = await renderHistoryPage(String(ctx.user._id), page);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, { reply_markup: keyboard });
  });

  bot.callbackQuery(HISTORY_NOOP_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery();
  });
};
