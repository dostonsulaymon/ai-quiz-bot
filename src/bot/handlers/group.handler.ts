import { InlineKeyboard, type Bot } from "grammy";
import { TestRepository } from "../../db/repositories/test.repository.js";
import { GroupSessionRepository } from "../../db/repositories/group-session.repository.js";
import { LeaderboardRepository } from "../../db/repositories/leaderboard.repository.js";
import type { BotContext } from "../types.js";
import type { TestDocument } from "../../db/models/test.model.js";
import type { GroupSessionDocument } from "../../db/models/group-session.model.js";
import type { Question } from "../../shared/types/index.js";
import { t, type Language } from "../../shared/i18n/index.js";

const GROUP_ANSWER_PREFIX = "group:answer:";
const GROUP_NEXT_PREFIX = "group:next:";
const GROUP_AGAIN_PREFIX = "group:again:";

const testRepository = new TestRepository();
const groupSessionRepository = new GroupSessionRepository();
const leaderboardRepository = new LeaderboardRepository();

const buildQuestionText = (question: Question, index: number, total: number, lang: Language): string => {
  const header = t(lang, "group.question.header", { n: index + 1, total });
  const lines: string[] = [header, "", question.question];

  if (question.type === "mcq" && question.options) {
    lines.push("", `A) ${question.options.A}`, `B) ${question.options.B}`, `C) ${question.options.C}`, `D) ${question.options.D}`);
  } else if (question.type === "short" || question.type === "fill") {
    lines.push("", t(lang, "group.open_answer_hint"));
  }

  return lines.join("\n");
};

const buildQuestionKeyboard = (
  sessionId: string,
  question: Question,
  qIdx: number,
  lang: Language,
  answeredCount: number
): InlineKeyboard => {
  const kb = new InlineKeyboard();
  const answerBase = `${GROUP_ANSWER_PREFIX}${sessionId}:${qIdx}:`;

  if (question.type === "mcq") {
    kb.text("A", `${answerBase}A`).text("B", `${answerBase}B`).text("C", `${answerBase}C`).text("D", `${answerBase}D`).row();
  } else if (question.type === "truefalse") {
    kb.text(t(lang, "test.btn.true"), `${answerBase}True`).text(t(lang, "test.btn.false"), `${answerBase}False`).row();
  }

  kb.text(t(lang, "group.btn.next", { answered: answeredCount }), `${GROUP_NEXT_PREFIX}${sessionId}:${qIdx}`);
  return kb;
};

const sendGroupQuestion = async (
  ctx: BotContext,
  session: GroupSessionDocument,
  test: TestDocument,
  lang: Language
): Promise<void> => {
  const { questions } = test;
  const idx = session.currentQuestionIndex;

  if (idx >= questions.length) {
    await completeGroupSession(ctx, session, test, lang);
    return;
  }

  const question = questions[idx]! as unknown as Question;
  const answeredCount = (session.answers as Array<{ questionId: string }>).filter(
    (a) => a.questionId === question.id
  ).length;

  const text = buildQuestionText(question, idx, questions.length, lang);
  const keyboard = buildQuestionKeyboard(String(session._id), question, idx, lang, answeredCount);

  const msg = await ctx.reply(text, { reply_markup: keyboard });
  await groupSessionRepository.setQuestionMessageId(session._id, msg.message_id);
};

const completeGroupSession = async (
  ctx: BotContext,
  session: GroupSessionDocument,
  test: TestDocument,
  lang: Language
): Promise<void> => {
  const { questions } = test;
  const testId = String(session.testId);

  // Build per-user score map
  const userMap = new Map<string, { firstName: string; correct: number }>();
  for (const ans of session.answers as Array<{ questionId: string; userId: string; firstName: string; isCorrect: boolean }>) {
    if (!userMap.has(ans.userId)) {
      userMap.set(ans.userId, { firstName: ans.firstName, correct: 0 });
    }
    if (ans.isCorrect) {
      userMap.get(ans.userId)!.correct += 1;
    }
  }

  // Upsert all participants to leaderboard
  await Promise.all(
    Array.from(userMap.entries()).map(([userId, data]) => {
      const score = questions.length > 0 ? Math.round((data.correct / questions.length) * 100) : 0;
      return leaderboardRepository.upsertEntry({
        testId,
        userId,
        firstName: data.firstName,
        score,
        correctCount: data.correct,
        totalQuestions: questions.length,
        timeTakenSeconds: 0
      });
    })
  );

  // Build final scoreboard sorted by score descending
  const sorted = Array.from(userMap.entries()).sort(([, a], [, b]) => b.correct - a.correct);

  const lines: string[] = [t(lang, "group.completed"), ""];
  if (sorted.length === 0) {
    lines.push(t(lang, "group.no_participants"));
  } else {
    sorted.forEach(([, data], i) => {
      const pct = questions.length > 0 ? Math.round((data.correct / questions.length) * 100) : 0;
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
      lines.push(t(lang, "group.final.score", { medal, name: data.firstName, correct: data.correct, total: questions.length, pct }));
    });
  }

  const keyboard = new InlineKeyboard().text(t(lang, "group.btn.play_again"), `${GROUP_AGAIN_PREFIX}${testId}`);
  await ctx.reply(lines.join("\n"), { reply_markup: keyboard });
};

export const startGroupQuiz = async (ctx: BotContext, testId: string): Promise<void> => {
  const lang = ctx.lang();
  const chatId = String(ctx.chat!.id);

  const existing = await groupSessionRepository.findActiveByChat(chatId);
  if (existing) {
    await ctx.reply(t(lang, "group.active_session"));
    return;
  }

  const test = await testRepository.findById(testId);
  if (!test || !test.isActive) {
    await ctx.reply(t(lang, "commands.testLinkInvalid"));
    return;
  }

  const startedBy = String(ctx.from!.id);
  const session = await groupSessionRepository.create({ chatId, testId, startedBy });

  const title = test.title?.trim() || t(lang, "common.untitledTest");
  await ctx.reply(t(lang, "group.started", { title, n: test.questions.length }));
  await sendGroupQuestion(ctx, session, test, lang);
};

export const cancelGroupQuiz = async (chatId: string): Promise<void> => {
  await groupSessionRepository.completeByChat(chatId);
};

const handleGroupAnswer = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const data = ctx.callbackQuery?.data;
  if (!data) {
    await ctx.answerCallbackQuery();
    return;
  }
  const payload = data.slice(GROUP_ANSWER_PREFIX.length);

  // Format: <sessionId>:<qIdx>:<answer>
  const colonIdx1 = payload.indexOf(":");
  const colonIdx2 = payload.indexOf(":", colonIdx1 + 1);
  if (colonIdx1 === -1 || colonIdx2 === -1) {
    await ctx.answerCallbackQuery();
    return;
  }

  const sessionId = payload.slice(0, colonIdx1);
  const qIdx = Number(payload.slice(colonIdx1 + 1, colonIdx2));
  const answer = payload.slice(colonIdx2 + 1);

  const session = await groupSessionRepository.findActiveByChat(String(ctx.chat!.id));
  if (!session || String(session._id) !== sessionId || session.currentQuestionIndex !== qIdx) {
    await ctx.answerCallbackQuery({ text: t(lang, "group.stale_question"), show_alert: false });
    return;
  }

  const test = await testRepository.findById(String(session.testId));
  if (!test) {
    await ctx.answerCallbackQuery();
    return;
  }

  const question = test.questions[qIdx];
  if (!question) {
    await ctx.answerCallbackQuery();
    return;
  }

  const userId = String(ctx.from!.id);
  const firstName = ctx.from!.first_name ?? "User";
  const isCorrect = answer.toLowerCase() === question.correctAnswer.toLowerCase();

  const recorded = await groupSessionRepository.addAnswer(session._id, question.id, userId, firstName, answer, isCorrect);

  if (!recorded) {
    await ctx.answerCallbackQuery({ text: t(lang, "group.already_answered"), show_alert: true });
    return;
  }

  if (isCorrect) {
    await ctx.answerCallbackQuery({ text: t(lang, "group.answer_correct"), show_alert: true });
  } else {
    await ctx.answerCallbackQuery({
      text: t(lang, "group.answer_wrong", { answer: question.correctAnswer }),
      show_alert: true
    });
  }

  // Refresh the answer count on the keyboard
  const updatedSession = await groupSessionRepository.findActiveByChat(String(ctx.chat!.id));
  if (updatedSession && ctx.callbackQuery?.message?.message_id === updatedSession.questionMessageId) {
    const answeredCount = (updatedSession.answers as Array<{ questionId: string }>).filter(
      (a) => a.questionId === question.id
    ).length;
    const keyboard = buildQuestionKeyboard(sessionId, question as unknown as Question, qIdx, lang, answeredCount);
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
    } catch {
      // Ignore — message not modified or already edited
    }
  }
};

const handleGroupNext = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const data = ctx.callbackQuery?.data;
  if (!data) {
    await ctx.answerCallbackQuery();
    return;
  }
  const payload = data.slice(GROUP_NEXT_PREFIX.length);

  const [sessionId, qIdxStr] = payload.split(":");
  const qIdx = Number(qIdxStr);

  const session = await groupSessionRepository.findActiveByChat(String(ctx.chat!.id));
  if (!session || String(session._id) !== sessionId || session.currentQuestionIndex !== qIdx) {
    await ctx.answerCallbackQuery({ text: t(lang, "group.stale_question"), show_alert: false });
    return;
  }

  await ctx.answerCallbackQuery();

  const test = await testRepository.findById(String(session.testId));
  if (!test) return;

  const question = test.questions[qIdx]! as unknown as Question;
  const allAnswers = session.answers as Array<{ questionId: string; userId: string; firstName: string; isCorrect: boolean }>;
  const qAnswers = allAnswers.filter((a) => a.questionId === question.id);
  const correct = qAnswers.filter((a) => a.isCorrect);
  const wrong = qAnswers.filter((a) => !a.isCorrect);

  // Build results text
  const resultLines: string[] = [
    t(lang, "group.results.header", { n: qIdx + 1 }),
    t(lang, "group.results.correct_answer", { answer: question.correctAnswer })
  ];

  if (qAnswers.length === 0) {
    resultLines.push(t(lang, "group.results.no_answers"));
  } else {
    if (correct.length > 0) {
      resultLines.push(t(lang, "group.results.correct", { count: correct.length, names: correct.map((a) => a.firstName).join(", ") }));
    }
    if (wrong.length > 0) {
      resultLines.push(t(lang, "group.results.wrong", { count: wrong.length, names: wrong.map((a) => a.firstName).join(", ") }));
    }
  }

  // Replace the question message with results
  try {
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(resultLines.join("\n"), { reply_markup: new InlineKeyboard() });
    }
  } catch {
    // Ignore edit failures
  }

  const isLastQuestion = qIdx >= test.questions.length - 1;

  if (isLastQuestion) {
    const completed = await groupSessionRepository.complete(session._id);
    if (completed) {
      await completeGroupSession(ctx, completed, test, lang);
    }
  } else {
    const advanced = await groupSessionRepository.advance(session._id);
    if (advanced) {
      await sendGroupQuestion(ctx, advanced, test, lang);
    }
  }
};

/** Handle open-ended text answers typed in the group chat. */
export const handleGroupTextAnswer = async (ctx: BotContext): Promise<void> => {
  const chatType = ctx.chat?.type;
  if (chatType !== "group" && chatType !== "supergroup") return;
  if (!ctx.message?.text) return;

  const chatId = String(ctx.chat!.id);
  const session = await groupSessionRepository.findActiveByChat(chatId);
  if (!session) return;

  const test = await testRepository.findById(String(session.testId));
  if (!test) return;

  const question = test.questions[session.currentQuestionIndex];
  if (!question) return;
  if (question.type !== "short" && question.type !== "fill") return;

  const userId = String(ctx.from!.id);
  const firstName = ctx.from!.first_name ?? "User";
  const answer = ctx.message.text.trim();
  const isCorrect = answer.toLowerCase() === question.correctAnswer.toLowerCase();

  const recorded = await groupSessionRepository.addAnswer(session._id, question.id, userId, firstName, answer, isCorrect);
  if (!recorded) return;

  if (isCorrect) {
    const lang = ctx.lang();
    await ctx.reply(t(lang, "group.answer_correct"), { reply_to_message_id: ctx.message.message_id });
  }
};

export const registerGroupHandlers = (bot: Bot<BotContext>): void => {
  bot.callbackQuery(new RegExp(`^${GROUP_ANSWER_PREFIX}`), async (ctx) => {
    await handleGroupAnswer(ctx);
  });

  bot.callbackQuery(new RegExp(`^${GROUP_NEXT_PREFIX}`), async (ctx) => {
    await handleGroupNext(ctx);
  });

  bot.callbackQuery(new RegExp(`^${GROUP_AGAIN_PREFIX}`), async (ctx) => {
    const testId = ctx.callbackQuery.data.slice(GROUP_AGAIN_PREFIX.length);
    await ctx.answerCallbackQuery();
    await startGroupQuiz(ctx, testId);
  });

  bot.on("message:text", async (ctx, next) => {
    const chatType = ctx.chat?.type;
    if (chatType === "group" || chatType === "supergroup") {
      await handleGroupTextAnswer(ctx);
    }
    await next();
  });
};
