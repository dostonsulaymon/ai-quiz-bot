import { InlineKeyboard, type Bot } from "grammy";
import { TestRepository } from "../../db/repositories/test.repository.js";
import { GroupSessionRepository } from "../../db/repositories/group-session.repository.js";
import { LeaderboardRepository } from "../../db/repositories/leaderboard.repository.js";
import { UserRepository } from "../../db/repositories/user.repository.js";
import type { BotContext } from "../types.js";
import type { TestDocument } from "../../db/models/test.model.js";
import type { GroupSessionDocument } from "../../db/models/group-session.model.js";
import type { Question } from "../../shared/types/index.js";
import { t, type Language } from "../../shared/i18n/index.js";
import { safeEditMessage, safeEditMessageViaApi } from "../utils/telegram.js";
import { formatQuestionDisplay, formatOptionDisplay } from "../utils/format.js";
import { ValidationError } from "../../shared/errors/ValidationError.js";
import { logger } from "../../shared/logger.js";

const GROUP_ANSWER_PREFIX = "group:answer:";
const GROUP_NEXT_PREFIX = "group:next:";
const GROUP_AGAIN_PREFIX = "group:again:";

const testRepository = new TestRepository();
const groupSessionRepository = new GroupSessionRepository();
const leaderboardRepository = new LeaderboardRepository();
const userRepository = new UserRepository();

// ---------------------------------------------------------------------------
// Per-chat timer map for auto-advance (feature: timer in group mode)
// ---------------------------------------------------------------------------

type GroupTimerEntry = { main: ReturnType<typeof setTimeout>; intervals: ReturnType<typeof setTimeout>[] };
const groupTimers = new Map<string, GroupTimerEntry>();

const cancelGroupTimer = (chatId: string): void => {
  const existing = groupTimers.get(chatId);
  if (existing !== undefined) {
    clearTimeout(existing.main);
    existing.intervals.forEach(clearTimeout);
    groupTimers.delete(chatId);
  }
};

const buildQuestionText = (question: Question, index: number, total: number, lang: Language): string => {
  const header = t(lang, "group.question.header", { n: index + 1, total });
  const { display: questionDisplay, truncated } = formatQuestionDisplay(question.question);
  const lines: string[] = [header, "", questionDisplay];
  if (truncated) lines.push(t(lang, "question.truncated_note"));

  if (question.type === "mcq" && question.options) {
    lines.push(
      "",
      `A) ${formatOptionDisplay(question.options.A)}`,
      `B) ${formatOptionDisplay(question.options.B)}`,
      `C) ${formatOptionDisplay(question.options.C)}`,
      `D) ${formatOptionDisplay(question.options.D)}`
    );
  } else if (question.type === "short" || question.type === "fill") {
    lines.push("", t(lang, "group.answer_type_hint"));
  }

  return lines.join("\n");
};

const buildFullQuestionText = (
  question: Question,
  index: number,
  total: number,
  lang: Language,
  timeLimitSeconds: number,
  answeredCount: number,
  remaining?: number
): string => {
  let text = buildQuestionText(question, index, total, lang);
  if (timeLimitSeconds > 0) {
    if (remaining !== undefined) {
      const timerKey = remaining > 30 ? "test.timer_remaining" : remaining > 10 ? "test.timer_warning" : "test.timer_urgent";
      text += `\n${t(lang, timerKey, { seconds: remaining })}`;
    } else {
      text += `\n${t(lang, "test.timer_label", { seconds: timeLimitSeconds })}`;
    }
  }
  text += `\n${t(lang, "group.answered_count", { count: answeredCount })}`;
  return text;
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

// ---------------------------------------------------------------------------
// Api-only helpers (used by auto-advance timer — no ctx available)
// ---------------------------------------------------------------------------

/** Build and send the completion card using bare api (timer path). */
const sendGroupCompletionViaApi = async (
  api: BotContext["api"],
  chatId: string,
  session: GroupSessionDocument,
  test: TestDocument,
  lang: Language
): Promise<void> => {
  const { questions } = test;
  const testId = String(session.testId);

  const userMap = new Map<string, { firstName: string; username?: string; correct: number }>();
  for (const ans of session.answers as Array<{ questionId: string; userId: string; firstName: string; username?: string; isCorrect: boolean }>) {
    if (!userMap.has(ans.userId)) userMap.set(ans.userId, { firstName: ans.firstName, username: ans.username, correct: 0 });
    if (ans.isCorrect) userMap.get(ans.userId)!.correct += 1;
  }

  await Promise.allSettled(
    Array.from(userMap.entries()).map(async ([telegramUserId, data]) => {
      try {
        const user = await userRepository.findByTelegramId(Number(telegramUserId));
        if (!user) return;
        const score = questions.length > 0 ? Math.round((data.correct / questions.length) * 100) : 0;
        await leaderboardRepository.upsertEntry({ testId, userId: user._id, firstName: data.firstName, username: data.username, score, correctCount: data.correct, totalQuestions: questions.length, timeTakenSeconds: 0 });
      } catch (error) {
        logger.error("Leaderboard write failed for group participant", {
          event: "leaderboard.write.failed",
          userId: telegramUserId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })
  );

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

  const keyboard = new InlineKeyboard()
    .text(t(lang, "group.btn.play_again"), `${GROUP_AGAIN_PREFIX}${testId}`)
    .row()
    .text(t(lang, "leaderboard.btn"), `leaderboard:${testId}`);
  await api.sendMessage(chatId, lines.join("\n"), { reply_markup: keyboard });
};

/** Send a question using bare api (timer path). Schedules the next timer if needed. */
const sendGroupQuestionViaApi = async (
  api: BotContext["api"],
  chatId: string,
  session: GroupSessionDocument,
  test: TestDocument,
  lang: Language
): Promise<void> => {
  const idx = session.currentQuestionIndex;
  const { questions } = test;

  if (idx >= questions.length) {
    const completed = await groupSessionRepository.complete(session._id);
    if (completed) await sendGroupCompletionViaApi(api, chatId, completed, test, lang);
    return;
  }

  const question = questions[idx]! as unknown as Question;
  const answeredCount = (session.answers as Array<{ questionId: string }>).filter((a) => a.questionId === question.id).length;

  const text = buildFullQuestionText(question, idx, questions.length, lang, test.timeLimitSeconds, answeredCount);
  const keyboard = buildQuestionKeyboard(String(session._id), question, idx, lang, answeredCount);

  const msg = await api.sendMessage(chatId, text, { reply_markup: keyboard });
  await groupSessionRepository.setQuestionMessageId(session._id, msg.message_id);
  await groupSessionRepository.setQuestionSentAt(session._id, new Date());

  if (test.timeLimitSeconds > 0) {
    const sessionId = String(session._id);
    const messageId = msg.message_id;
    cancelGroupTimer(chatId);

    const intervals: ReturnType<typeof setTimeout>[] = [];
    const intervalCount = Math.floor(test.timeLimitSeconds / 5);
    for (let i = 1; i < intervalCount; i++) {
      const remaining = test.timeLimitSeconds - i * 5;
      intervals.push(setTimeout(async () => {
        const fresh = await groupSessionRepository.findActiveByChat(chatId);
        if (!fresh || String(fresh._id) !== sessionId || fresh.currentQuestionIndex !== idx) return;
        const freshCount = (fresh.answers as Array<{ questionId: string }>).filter((a) => a.questionId === question.id).length;
        await safeEditMessageViaApi(api, chatId, messageId, buildFullQuestionText(question, idx, questions.length, lang, test.timeLimitSeconds, freshCount, remaining));
      }, i * 5 * 1000));
    }

    const main = setTimeout(() => {
      groupTimers.delete(chatId);
      void runGroupAutoAdvance(api, chatId, sessionId, idx, test, lang);
    }, test.timeLimitSeconds * 1000);
    groupTimers.set(chatId, { main, intervals });
  }
};

/** Called when a question timer fires OR on startup for expired sessions. Shows results then advances. */
export const runGroupAutoAdvance = async (
  api: BotContext["api"],
  chatId: string,
  sessionId: string,
  qIdx: number,
  test: TestDocument,
  lang: Language
): Promise<void> => {
  const session = await groupSessionRepository.findActiveByChat(chatId);
  if (!session || String(session._id) !== sessionId || session.currentQuestionIndex !== qIdx) return;

  const question = test.questions[qIdx]! as unknown as Question;
  const allAnswers = session.answers as Array<{ questionId: string; userId: string; firstName: string; isCorrect: boolean }>;
  const qAnswers = allAnswers.filter((a) => a.questionId === question.id);
  const correct = qAnswers.filter((a) => a.isCorrect);
  const wrong = qAnswers.filter((a) => !a.isCorrect);

  const resultLines: string[] = [
    t(lang, "group.results.header", { n: qIdx + 1 }),
    t(lang, "group.results.correct_answer", { answer: question.correctAnswer })
  ];
  if (qAnswers.length === 0) {
    resultLines.push(t(lang, "group.results.no_answers"));
  } else {
    if (correct.length > 0) resultLines.push(t(lang, "group.results.correct", { count: correct.length, names: correct.map((a) => a.firstName).join(", ") }));
    if (wrong.length > 0) resultLines.push(t(lang, "group.results.wrong", { count: wrong.length, names: wrong.map((a) => a.firstName).join(", ") }));
  }

  if (session.questionMessageId) {
    await safeEditMessageViaApi(api, chatId, session.questionMessageId, resultLines.join("\n"), { reply_markup: new InlineKeyboard() });
  }

  await new Promise<void>((resolve) => setTimeout(resolve, 3000));

  // Re-check: handleGroupNext might have advanced during the 3s delay
  const rechecked = await groupSessionRepository.findActiveByChat(chatId);
  if (!rechecked || String(rechecked._id) !== sessionId || rechecked.currentQuestionIndex !== qIdx) return;

  const isLast = qIdx >= test.questions.length - 1;
  if (isLast) {
    const completed = await groupSessionRepository.complete(rechecked._id);
    if (completed) await sendGroupCompletionViaApi(api, chatId, completed, test, lang);
  } else {
    const advanced = await groupSessionRepository.advance(rechecked._id);
    if (advanced) await sendGroupQuestionViaApi(api, chatId, advanced, test, lang);
  }
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

  const text = buildFullQuestionText(question, idx, questions.length, lang, test.timeLimitSeconds, answeredCount);
  const keyboard = buildQuestionKeyboard(String(session._id), question, idx, lang, answeredCount);

  const msg = await ctx.reply(text, { reply_markup: keyboard });
  await groupSessionRepository.setQuestionMessageId(session._id, msg.message_id);
  await groupSessionRepository.setQuestionSentAt(session._id, new Date());

  if (test.timeLimitSeconds > 0) {
    const chatId = String(ctx.chat!.id);
    const api = ctx.api;
    const sessionId = String(session._id);
    const messageId = msg.message_id;
    cancelGroupTimer(chatId);

    const intervals: ReturnType<typeof setTimeout>[] = [];
    const intervalCount = Math.floor(test.timeLimitSeconds / 5);
    for (let i = 1; i < intervalCount; i++) {
      const remaining = test.timeLimitSeconds - i * 5;
      intervals.push(setTimeout(async () => {
        const fresh = await groupSessionRepository.findActiveByChat(chatId);
        if (!fresh || String(fresh._id) !== sessionId || fresh.currentQuestionIndex !== idx) return;
        const freshCount = (fresh.answers as Array<{ questionId: string }>).filter((a) => a.questionId === question.id).length;
        await safeEditMessageViaApi(api, chatId, messageId, buildFullQuestionText(question, idx, questions.length, lang, test.timeLimitSeconds, freshCount, remaining));
      }, i * 5 * 1000));
    }

    const main = setTimeout(() => {
      groupTimers.delete(chatId);
      void runGroupAutoAdvance(api, chatId, sessionId, idx, test, lang);
    }, test.timeLimitSeconds * 1000);
    groupTimers.set(chatId, { main, intervals });
  }
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
  const userMap = new Map<string, { firstName: string; username?: string; correct: number }>();
  for (const ans of session.answers as Array<{ questionId: string; userId: string; firstName: string; username?: string; isCorrect: boolean }>) {
    if (!userMap.has(ans.userId)) {
      userMap.set(ans.userId, { firstName: ans.firstName, username: ans.username, correct: 0 });
    }
    if (ans.isCorrect) {
      userMap.get(ans.userId)!.correct += 1;
    }
  }

  // Upsert all participants to leaderboard (look up MongoDB _id from Telegram userId)
  await Promise.allSettled(
    Array.from(userMap.entries()).map(async ([telegramUserId, data]) => {
      try {
        const user = await userRepository.findByTelegramId(Number(telegramUserId));
        if (!user) return;
        const score = questions.length > 0 ? Math.round((data.correct / questions.length) * 100) : 0;
        await leaderboardRepository.upsertEntry({
          testId,
          userId: user._id,
          firstName: data.firstName,
          username: data.username,
          score,
          correctCount: data.correct,
          totalQuestions: questions.length,
          timeTakenSeconds: 0
        });
      } catch (error) {
        logger.error("Leaderboard write failed for group participant", {
          event: "leaderboard.write.failed",
          userId: telegramUserId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
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

  const keyboard = new InlineKeyboard()
    .text(t(lang, "group.btn.play_again"), `${GROUP_AGAIN_PREFIX}${testId}`)
    .row()
    .text(t(lang, "leaderboard.btn"), `leaderboard:${testId}`);
  await ctx.reply(lines.join("\n"), { reply_markup: keyboard });
};

export const startGroupQuiz = async (ctx: BotContext, testId: string): Promise<void> => {
  const lang = (ctx.user?.language ?? "en") as Language;
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

  let session;
  try {
    session = await groupSessionRepository.create({ chatId, testId, startedBy, hostLanguage: lang });
  } catch (error) {
    if (error instanceof ValidationError && error.code === "GROUP_SESSION_ACTIVE") {
      await ctx.reply(t(lang, "group.active_session"));
      return;
    }
    throw error;
  }

  const title = test.title?.trim() || t(lang, "common.untitledTest");
  const timerText = (test.timeLimitSeconds ?? 0) > 0
    ? t(lang, "group.timer_info", { seconds: test.timeLimitSeconds ?? 0 })
    : t(lang, "group.no_timer");
  await ctx.reply(t(lang, "group.started_detail", { title, count: test.questions.length, timer: timerText }));

  const countdownMsg = await ctx.reply("3️⃣");
  await new Promise<void>((r) => setTimeout(r, 1000));
  await safeEditMessageViaApi(ctx.api, ctx.chat!.id, countdownMsg.message_id, "2️⃣");
  await new Promise<void>((r) => setTimeout(r, 1000));
  await safeEditMessageViaApi(ctx.api, ctx.chat!.id, countdownMsg.message_id, "1️⃣");
  await new Promise<void>((r) => setTimeout(r, 1000));
  await safeEditMessageViaApi(ctx.api, ctx.chat!.id, countdownMsg.message_id, `🚀 ${t(lang, "group.lets_go")}`);
  await new Promise<void>((r) => setTimeout(r, 500));

  await sendGroupQuestion(ctx, session, test, lang);
};

export const cancelGroupQuiz = async (chatId: string): Promise<void> => {
  cancelGroupTimer(chatId);
  await groupSessionRepository.completeByChat(chatId);
};

export const stopGroupQuiz = async (ctx: BotContext): Promise<void> => {
  const userLang = (ctx.user?.language ?? "en") as Language;
  const chatId = String(ctx.chat!.id);

  const session = await groupSessionRepository.findActiveByChat(chatId);
  if (!session) {
    await ctx.reply(t(userLang, "group.stop_none"));
    return;
  }

  if (String(ctx.from?.id) !== session.startedBy) {
    await ctx.reply(t(userLang, "group.stop_host_only"));
    return;
  }

  const hostLang = (session.hostLanguage ?? "en") as Language;
  cancelGroupTimer(chatId);
  const test = await testRepository.findById(String(session.testId));
  const completed = await groupSessionRepository.complete(session._id);
  if (completed && test) {
    await completeGroupSession(ctx, completed, test, hostLang);
  } else {
    await groupSessionRepository.completeByChat(chatId);
    await ctx.reply(t(hostLang, "group.stop_success"));
  }
};

const handleGroupAnswer = async (ctx: BotContext): Promise<void> => {
  const userLang = (ctx.user?.language ?? "en") as Language;
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
    await ctx.answerCallbackQuery({ text: t(userLang, "group.stale_question"), show_alert: false });
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

  // Timestamp-based timer check: reject late answers even if the bot restarted mid-question.
  if (test.timeLimitSeconds > 0 && session.questionSentAt) {
    const elapsed = Math.floor((Date.now() - session.questionSentAt.getTime()) / 1000);
    if (elapsed > test.timeLimitSeconds) {
      await ctx.answerCallbackQuery({ text: t(userLang, "test.timeout", { answer: question.correctAnswer }), show_alert: true });
      void runGroupAutoAdvance(ctx.api, String(ctx.chat!.id), sessionId, qIdx, test, (session.hostLanguage ?? "en") as Language);
      return;
    }
  }

  const userId = String(ctx.from!.id);
  const firstName = ctx.from!.first_name ?? "User";
  const username = ctx.from?.username;
  const isCorrect = answer.toLowerCase() === question.correctAnswer.toLowerCase();

  const recorded = await groupSessionRepository.addAnswer(session._id, question.id, userId, firstName, answer, isCorrect, username);

  if (!recorded) {
    await ctx.answerCallbackQuery({ text: t(userLang, "group.already_answered"), show_alert: true });
    return;
  }

  if (isCorrect) {
    await ctx.answerCallbackQuery({ text: t(userLang, "group.answer_correct"), show_alert: true });
  } else {
    await ctx.answerCallbackQuery({
      text: t(userLang, "group.answer_wrong", { answer: question.correctAnswer }),
      show_alert: true
    });
  }

  // Refresh the answer count on both the message text and keyboard
  const hostLang = (session.hostLanguage ?? "en") as Language;
  const updatedSession = await groupSessionRepository.findActiveByChat(String(ctx.chat!.id));
  if (updatedSession && updatedSession.questionMessageId !== undefined && ctx.callbackQuery?.message?.message_id === updatedSession.questionMessageId) {
    const answeredCount = (updatedSession.answers as Array<{ questionId: string }>).filter(
      (a) => a.questionId === question.id
    ).length;
    const keyboard = buildQuestionKeyboard(sessionId, question as unknown as Question, qIdx, hostLang, answeredCount);
    const updatedText = buildFullQuestionText(question as unknown as Question, qIdx, test.questions.length, hostLang, test.timeLimitSeconds, answeredCount);
    await safeEditMessageViaApi(ctx.api, ctx.chat!.id, updatedSession.questionMessageId, updatedText, { reply_markup: keyboard });
  }
};

const handleGroupNext = async (ctx: BotContext): Promise<void> => {
  const userLang = (ctx.user?.language ?? "en") as Language;
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
    await ctx.answerCallbackQuery({ text: t(userLang, "group.stale_question"), show_alert: false });
    return;
  }

  if (String(ctx.from?.id) !== session.startedBy) {
    await ctx.answerCallbackQuery({ text: t(userLang, "group.host_only"), show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery();
  cancelGroupTimer(String(ctx.chat!.id));

  const hostLang = (session.hostLanguage ?? "en") as Language;
  const test = await testRepository.findById(String(session.testId));
  if (!test) return;

  const question = test.questions[qIdx]! as unknown as Question;
  const allAnswers = session.answers as Array<{ questionId: string; userId: string; firstName: string; isCorrect: boolean }>;
  const qAnswers = allAnswers.filter((a) => a.questionId === question.id);
  const correct = qAnswers.filter((a) => a.isCorrect);
  const wrong = qAnswers.filter((a) => !a.isCorrect);

  // Build results text
  const resultLines: string[] = [
    t(hostLang, "group.results.header", { n: qIdx + 1 }),
    t(hostLang, "group.results.correct_answer", { answer: question.correctAnswer })
  ];

  if (qAnswers.length === 0) {
    resultLines.push(t(hostLang, "group.results.no_answers"));
  } else {
    if (correct.length > 0) {
      resultLines.push(t(hostLang, "group.results.correct", { count: correct.length, names: correct.map((a) => a.firstName).join(", ") }));
    }
    if (wrong.length > 0) {
      resultLines.push(t(hostLang, "group.results.wrong", { count: wrong.length, names: wrong.map((a) => a.firstName).join(", ") }));
    }
  }

  // Replace the question message with results
  if (ctx.callbackQuery?.message) {
    await safeEditMessage(ctx, resultLines.join("\n"), { reply_markup: new InlineKeyboard() });
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 3000));

  const isLastQuestion = qIdx >= test.questions.length - 1;

  if (isLastQuestion) {
    const completed = await groupSessionRepository.complete(session._id);
    if (completed) {
      await completeGroupSession(ctx, completed, test, hostLang);
    }
  } else {
    const advanced = await groupSessionRepository.advance(session._id);
    if (advanced) {
      await sendGroupQuestion(ctx, advanced, test, hostLang);
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

  const userLang = (ctx.user?.language ?? "en") as Language;
  const answer = ctx.message.text.trim();

  // Timestamp-based timer check: silently trigger auto-advance on expired questions.
  if (test.timeLimitSeconds > 0 && session.questionSentAt) {
    const elapsed = Math.floor((Date.now() - session.questionSentAt.getTime()) / 1000);
    if (elapsed > test.timeLimitSeconds) {
      void runGroupAutoAdvance(ctx.api, chatId, String(session._id), session.currentQuestionIndex, test, (session.hostLanguage ?? "en") as Language);
      return;
    }
  }

  const userId = String(ctx.from!.id);
  const firstName = ctx.from!.first_name ?? "User";
  const username = ctx.from?.username;
  const isCorrect = answer.toLowerCase() === question.correctAnswer.toLowerCase();

  const recorded = await groupSessionRepository.addAnswer(session._id, question.id, userId, firstName, answer, isCorrect, username);

  if (!recorded) {
    // User already answered — notify privately then delete after 3 s
    const feedbackMsg = await ctx.reply(t(userLang, "group.already_answered"), {
      reply_to_message_id: ctx.message.message_id
    });
    setTimeout(() => {
      void ctx.api.deleteMessage(chatId, feedbackMsg.message_id).catch(() => undefined);
    }, 3000);
    return;
  }

  // Send private-style feedback — correct answer is NOT revealed yet
  const feedbackMsg = await ctx.reply(
    isCorrect ? t(userLang, "group.answer_correct") : t(userLang, "group.answer_wrong_private"),
    { reply_to_message_id: ctx.message.message_id }
  );
  setTimeout(() => {
    void safeEditMessageViaApi(ctx.api, chatId, feedbackMsg.message_id, isCorrect ? "✅" : "❌");
  }, 3000);

  // Refresh answered count on the question message
  const hostLang = (session.hostLanguage ?? "en") as Language;
  const updatedSession = await groupSessionRepository.findActiveByChat(chatId);
  if (updatedSession?.questionMessageId != null) {
    const answeredCount = (updatedSession.answers as Array<{ questionId: string }>).filter(
      (a) => a.questionId === question.id
    ).length;
    const updatedText = buildFullQuestionText(
      question as unknown as Question,
      session.currentQuestionIndex,
      test.questions.length,
      hostLang,
      test.timeLimitSeconds,
      answeredCount
    );
    await safeEditMessageViaApi(ctx.api, chatId, updatedSession.questionMessageId, updatedText);
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
