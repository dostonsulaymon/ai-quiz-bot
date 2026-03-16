import { InlineKeyboard, type Api } from "grammy";
import type { Redis } from "ioredis";
import { UserRepository } from "../../db/repositories/user.repository.js";
import { TestRepository } from "../../db/repositories/test.repository.js";
import { TestSessionRepository } from "../../db/repositories/test-session.repository.js";
import { AppError } from "../../shared/errors/AppError.js";
import { logger } from "../../shared/logger.js";
import { NotFoundError } from "../../shared/errors/NotFoundError.js";
import { ValidationError } from "../../shared/errors/ValidationError.js";
import type { Question, QuestionAnswer } from "../../shared/types/index.js";
import type { BotContext, BotSession } from "../types.js";
import { resetSession } from "../types.js";
import { transitionTo } from "../state-machine.js";
import { acquireActiveTestSessionSlot, releaseActiveTestSessionSlot } from "../middlewares/rateLimitMiddleware.js";
import { t, type Language } from "../../shared/i18n/index.js";
import { LeaderboardRepository } from "../../db/repositories/leaderboard.repository.js";
import { RedisSessionStorage } from "../storage/redis-session.storage.js";
import { config } from "../../config/index.js";
import { safeEditMessageViaApi } from "../utils/telegram.js";
import { formatQuestionDisplay, formatOptionDisplay } from "../utils/format.js";

const ANSWER_CALLBACK_PREFIX = "test:answer:";
const SELF_GRADE_CALLBACK_PREFIX = "test:self:";
const SHARE_CALLBACK = "test:share";
const RETAKE_CALLBACK = "test:retake";
const MAIN_MENU_CALLBACK = "test:menu";
const REVIEW_ANSWERS_CALLBACK = "test:review_answers";
const REVIEW_ANSWERS_PAGE_PREFIX = "test:review_answers:";
const REVIEW_BACK_CALLBACK = "test:review_back";
const REVIEW_PAGE_SIZE = 5;
export const LEADERBOARD_CALLBACK_PREFIX = "leaderboard:";

const testRepository = new TestRepository();
const testSessionRepository = new TestSessionRepository();
const userRepository = new UserRepository();
const leaderboardRepository = new LeaderboardRepository();

// ---------------------------------------------------------------------------
// Per-question timer infrastructure
// ---------------------------------------------------------------------------

type TimerEntry = {
  main: ReturnType<typeof setTimeout>;
  intervals: ReturnType<typeof setTimeout>[];
};

/** Keyed by String(chatId) — one pending timer entry per chat at most. */
const questionTimeouts = new Map<string, TimerEntry>();

type AutoAdvanceParams = {
  api: Api;
  redis: Redis;
  chatId: number;
  sessionKey: string;
  messageId: number;
  question: Question;
  questionIndex: number;
  totalQuestions: number;
  lang: Language;
  timeLimitSeconds: number;
};

const cancelQuestionTimeout = (chatId: number): void => {
  const key = String(chatId);
  const existing = questionTimeouts.get(key);
  if (existing !== undefined) {
    clearTimeout(existing.main);
    existing.intervals.forEach(clearTimeout);
    questionTimeouts.delete(key);
  }
};

const scheduleAutoAdvance = (params: AutoAdvanceParams): void => {
  cancelQuestionTimeout(params.chatId);

  const key = String(params.chatId);
  const intervals: ReturnType<typeof setTimeout>[] = [];

  // Schedule a countdown edit every 5 seconds until the question expires.
  // intervalCount = number of complete 5-second blocks; we fire at 5, 10, ..., (n-1)*5 s.
  const intervalCount = Math.floor(params.timeLimitSeconds / 5);
  for (let i = 1; i < intervalCount; i++) {
    const remaining = params.timeLimitSeconds - i * 5;
    const intervalTimer = setTimeout(() => {
      void (async () => {
        const storage = new RedisSessionStorage<BotSession>(params.redis, config.SESSION_TTL_SECONDS);
        const session = await storage.read(params.sessionKey);
        if (!session || session.currentQuestionIndex !== params.questionIndex || session.questionStartedAt === undefined) {
          return;
        }
        const updatedText = formatQuestionText(params.question, params.questionIndex, params.totalQuestions, params.lang, params.timeLimitSeconds, remaining);
        try {
          // Omitting reply_markup preserves the existing keyboard on Telegram's end
          await safeEditMessageViaApi(params.api, params.chatId, params.messageId, updatedText);
        } catch {
          // Ignore — message may have been answered or deleted
        }
      })();
    }, i * 5 * 1000);
    intervals.push(intervalTimer);
  }

  const main = setTimeout(() => {
    questionTimeouts.delete(key);
    void runAutoAdvance(params);
  }, params.timeLimitSeconds * 1000);

  questionTimeouts.set(key, { main, intervals });
};

const runAutoAdvance = async (params: AutoAdvanceParams): Promise<void> => {
  const { api, redis, chatId, sessionKey, messageId, question, questionIndex, totalQuestions, lang } = params;
  const storage = new RedisSessionStorage<BotSession>(redis, config.SESSION_TTL_SECONDS);
  const session = await storage.read(sessionKey);

  // Bail if the question was already answered (index moved on or timer cleared)
  if (!session || session.currentQuestionIndex !== questionIndex || session.questionStartedAt === undefined) {
    return;
  }

  // Edit the question message to show timeout and strip the answer keyboard
  const timedOutText = `${formatQuestionText(question, questionIndex, totalQuestions, lang)}\n\n${t(lang, "test.timeout_auto")}`;
  try {
    await safeEditMessageViaApi(api, chatId, messageId, timedOutText, { reply_markup: new InlineKeyboard() });
  } catch {
    // Ignore — message may have already been edited by a concurrent answer
  }

  // Record wrong answer
  if (session.sessionId) {
    await testSessionRepository.updateAnswer(session.sessionId, {
      questionId: question.id,
      userAnswer: "",
      isCorrect: false
    } as QuestionAnswer);
  }

  const nextIndex = questionIndex + 1;

  if (nextIndex >= totalQuestions) {
    // Last question — complete the test
    const correctCount = session.testCorrectCount ?? 0;
    const score = Math.round((correctCount / totalQuestions) * 100);

    if (session.sessionId) {
      await testSessionRepository.complete(session.sessionId, { score, correctCount, totalQuestions, completedAt: new Date() });
    }

    logger.info("Test auto-completed on timeout", { event: "test.timeout.complete", chatId, correctCount, totalQuestions });

    const wrongCount = totalQuestions - correctCount;
    const lines = [
      t(lang, "test.timeout_auto"),
      t(lang, "test.complete.title"),
      t(lang, "test.complete.separator"),
      t(lang, "test.complete.score", { correct: correctCount, total: totalQuestions, pct: score }),
      t(lang, "test.complete.correctCount", { n: correctCount }),
      t(lang, "test.complete.wrongCount", { n: wrongCount })
    ];
    await api.sendMessage(chatId, lines.join("\n"));

    session.currentQuestionIndex = totalQuestions;
    session.questionStartedAt = undefined;
    session.testQuestionMessageId = undefined;
    session.testSubState = "completed";
    session.testStartedAt = undefined;
    await storage.write(sessionKey, session);
    return;
  }

  // Not the last question — advance and send the next one
  const nextQuestion = (session.testQuestions ?? [])[nextIndex] as Question | undefined;
  if (!nextQuestion) {
    session.currentQuestionIndex = nextIndex;
    session.questionStartedAt = undefined;
    session.testQuestionMessageId = undefined;
    await storage.write(sessionKey, session);
    return;
  }

  const nextText = formatQuestionText(nextQuestion, nextIndex, totalQuestions, lang, params.timeLimitSeconds);
  const nextKeyboard: InlineKeyboard | undefined =
    nextQuestion.type === "mcq"
      ? buildMcqKeyboard()
      : nextQuestion.type === "truefalse"
        ? buildTrueFalseKeyboard(lang)
        : undefined;

  const nextMsg = await api.sendMessage(chatId, nextText, nextKeyboard ? { reply_markup: nextKeyboard } : {});

  session.currentQuestionIndex = nextIndex;
  session.testQuestionMessageId = nextMsg.message_id;
  session.questionStartedAt = Date.now();
  session.testSubState = "answering";
  await storage.write(sessionKey, session);

  scheduleAutoAdvance({ ...params, messageId: nextMsg.message_id, question: nextQuestion, questionIndex: nextIndex });
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const buildProgressBar = (current: number, total: number): string => {
  const slots = 10;
  const filled = Math.max(0, Math.min(slots, Math.round((current / total) * slots)));
  return `${"█".repeat(filled)}${"░".repeat(slots - filled)}`;
};

const buildStars = (score: number): string => {
  const totalStars = 10;
  const filled = Math.max(0, Math.min(totalStars, Math.round(score / 10)));
  return `${"⭐".repeat(filled)}${"☆".repeat(totalStars - filled)}`;
};

const formatQuestionHeader = (index: number, total: number, lang: Language): string => {
  const current = index + 1;
  const percentage = Math.round((current / total) * 100);
  return t(lang, "test.header", { n: current, total, bar: buildProgressBar(current, total), pct: percentage });
};

const formatQuestionText = (question: Question, index: number, total: number, lang: Language, timeLimitSeconds = 0, remaining?: number): string => {
  const lines = [formatQuestionHeader(index, total, lang)];

  if (timeLimitSeconds > 0) {
    if (remaining !== undefined) {
      const timerLine =
        remaining > 30
          ? t(lang, "test.timer_remaining", { seconds: remaining })
          : remaining > 10
            ? t(lang, "test.timer_warning", { seconds: remaining })
            : t(lang, "test.timer_urgent", { seconds: remaining });
      lines.push(timerLine);
    } else {
      lines.push(t(lang, "test.timer_label", { seconds: timeLimitSeconds }));
    }
  }

  const { display: questionDisplay, truncated } = formatQuestionDisplay(question.question);
  lines.push("", questionDisplay);
  if (truncated) lines.push(t(lang, "question.truncated_note"));

  if (question.type === "mcq" && question.options) {
    lines.push(
      "",
      `A. ${formatOptionDisplay(question.options.A)}`,
      `B. ${formatOptionDisplay(question.options.B)}`,
      `C. ${formatOptionDisplay(question.options.C)}`,
      `D. ${formatOptionDisplay(question.options.D)}`
    );
  } else if (question.type === "short" || question.type === "fill") {
    lines.push("", t(lang, "test.typeAnswer"));
  }

  return lines.join("\n");
};

const buildMcqKeyboard = (): InlineKeyboard =>
  new InlineKeyboard()
    .text("A", `${ANSWER_CALLBACK_PREFIX}A`)
    .text("B", `${ANSWER_CALLBACK_PREFIX}B`)
    .text("C", `${ANSWER_CALLBACK_PREFIX}C`)
    .text("D", `${ANSWER_CALLBACK_PREFIX}D`);

const buildTrueFalseKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "test.btn.true"), `${ANSWER_CALLBACK_PREFIX}True`)
    .text(t(lang, "test.btn.false"), `${ANSWER_CALLBACK_PREFIX}False`);

const buildSelfGradeKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "test.btn.selfGradeCorrect"), `${SELF_GRADE_CALLBACK_PREFIX}correct`)
    .text(t(lang, "test.btn.selfGradeWrong"), `${SELF_GRADE_CALLBACK_PREFIX}wrong`);

const buildCompletionKeyboard = (lang: Language, testId?: string, showLeaderboard = false): InlineKeyboard => {
  const kb = new InlineKeyboard()
    .text(t(lang, "test.btn.review_answers"), REVIEW_ANSWERS_CALLBACK)
    .row()
    .text(t(lang, "test.btn.share"), SHARE_CALLBACK)
    .text(t(lang, "test.btn.retake"), RETAKE_CALLBACK)
    .text(t(lang, "test.btn.mainMenu"), MAIN_MENU_CALLBACK);

  if (showLeaderboard && testId) {
    kb.row().text(t(lang, "leaderboard.btn"), `${LEADERBOARD_CALLBACK_PREFIX}${testId}`);
  }

  return kb;
};

const buildShareKeyboard = (link: string, lang: Language): InlineKeyboard =>
  new InlineKeyboard().url(t(lang, "test.btn.copyLink"), link);

// ---------------------------------------------------------------------------
// Shuffle helpers
// ---------------------------------------------------------------------------

const fisherYates = <T>(arr: T[]): T[] => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
};

const shuffleQuestionOptions = (question: Question): Question => {
  if (question.type !== "mcq" || !question.options) return question;

  const opts = question.options;
  const values = fisherYates([opts.A, opts.B, opts.C, opts.D]);
  const newOptions = { A: values[0]!, B: values[1]!, C: values[2]!, D: values[3]! };

  const originalCorrectValue = opts[question.correctAnswer as keyof typeof opts];
  const newCorrectIdx = values.indexOf(originalCorrectValue ?? "");
  const keys = ["A", "B", "C", "D"] as const;
  const newCorrectKey = newCorrectIdx >= 0 ? keys[newCorrectIdx]! : question.correctAnswer;

  return { ...question, options: newOptions, correctAnswer: newCorrectKey };
};

// ---------------------------------------------------------------------------
// Question cache helpers
// ---------------------------------------------------------------------------

/**
 * Returns the cached question list from session, falling back to a DB fetch
 * for sessions created before the caching was introduced.
 */
const resolveQuestions = async (ctx: BotContext): Promise<Question[]> => {
  if (ctx.session.testQuestions?.length) {
    return ctx.session.testQuestions;
  }

  const activeTestId = ctx.session.activeTestId;
  if (!activeTestId) throw new ValidationError("Active test is missing from session", "ACTIVE_TEST_MISSING");

  const test = await testRepository.findById(activeTestId);
  if (!test) throw new NotFoundError("The requested test could not be found", "TEST_NOT_FOUND");

  const questions = test.questions as Question[];
  ctx.session.testQuestions = questions;
  return questions;
};

// ---------------------------------------------------------------------------
// Enter test flow
// ---------------------------------------------------------------------------

export const enterTestFlow = async (ctx: BotContext, testId: string): Promise<void> => {
  // Fetch test once and cache questions in session — eliminates repeated DB
  // round-trips on every answer (P3).
  const test = await testRepository.findById(testId);
  if (!test) throw new NotFoundError("The requested test could not be found", "TEST_NOT_FOUND");

  ctx.session.activeTestId = testId;

  let questions: Question[] = test.questions as Question[];
  if (test.shuffleQuestions) {
    questions = fisherYates([...questions]);
  }
  if (test.shuffleOptions) {
    questions = questions.map(shuffleQuestionOptions);
  }
  ctx.session.testQuestions = questions;
  transitionTo(ctx.session, "testing", "enterTestFlow");
  ctx.session.testSubState = "answering";
  ctx.session.testCorrectCount = 0;
  ctx.session.currentQuestionIndex = 0;
  ctx.session.sessionId = undefined;
  ctx.session.testQuestionMessageId = undefined;
  ctx.session.testSelfGradePromptMessageId = undefined;
  ctx.session.testPendingTextAnswer = undefined;
  ctx.session.timeLimitSeconds = test.timeLimitSeconds ?? 0;
  ctx.session.questionStartedAt = undefined;

  await sendCurrentQuestion(ctx);
};

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

export const testRouter = async (ctx: BotContext): Promise<void> => {
  const subState = ctx.session.testSubState ?? "answering";

  if (subState === "completed") {
    await handleCompleted(ctx);
    return;
  }

  if (subState === "self_grading") {
    await handleSelfGrading(ctx);
    return;
  }

  // "answering"
  await handleAnswering(ctx);
};

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const ensureSession = async (ctx: BotContext, totalQuestions: number): Promise<string> => {
  if (ctx.session.sessionId) {
    return ctx.session.sessionId;
  }

  const activeTestId = ctx.session.activeTestId;
  if (!activeTestId) throw new ValidationError("Active test is missing from session", "ACTIVE_TEST_MISSING");

  await acquireActiveTestSessionSlot(ctx);

  if (!ctx.user) throw new AppError("User context is missing for test session creation", { statusCode: 500, code: "USER_CONTEXT_MISSING" });

  const testSession = await testSessionRepository.create({
    testId: activeTestId,
    userId: ctx.user._id,
    totalQuestions,
    status: "in_progress"
  });

  ctx.session.sessionId = String(testSession._id);
  return ctx.session.sessionId;
};

// ---------------------------------------------------------------------------
// Send question
// ---------------------------------------------------------------------------

const sendCurrentQuestion = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();

  if (!ctx.session.activeTestId) {
    await ctx.reply(t(lang, "test.noActiveTest"));
    return;
  }

  const questions = await resolveQuestions(ctx);
  if (questions.length === 0) throw new ValidationError("This test does not contain any questions", "TEST_EMPTY");

  const index = ctx.session.currentQuestionIndex ?? 0;

  await ensureSession(ctx, questions.length);

  if (index >= questions.length) {
    await completeTest(ctx, questions.length);
    return;
  }

  const question = questions[index]!;
  const replyMarkup =
    question.type === "mcq"
      ? buildMcqKeyboard()
      : question.type === "truefalse"
        ? buildTrueFalseKeyboard(lang)
        : undefined;

  logger.info("Test scene entered", { event: "test.scene.enter", userId: ctx.from?.id, testId: ctx.session.activeTestId, questionIndex: index });

  if (index === 0 && !ctx.session.testStartedAt) {
    ctx.session.testStartedAt = Date.now();
  }

  const timeLimitSeconds = ctx.session.timeLimitSeconds ?? 0;
  const message = await ctx.reply(formatQuestionText(question, index, questions.length, lang, timeLimitSeconds), { reply_markup: replyMarkup });
  ctx.session.testQuestionMessageId = message.message_id;
  ctx.session.questionStartedAt = Date.now();
  ctx.session.testSubState = "answering";

  if (timeLimitSeconds > 0 && ctx.chat && ctx.from) {
    scheduleAutoAdvance({
      api: ctx.api,
      redis: ctx.redis,
      chatId: ctx.chat.id,
      sessionKey: `${ctx.from.id}:${ctx.chat.id}`,
      messageId: message.message_id,
      question,
      questionIndex: index,
      totalQuestions: questions.length,
      lang,
      timeLimitSeconds
    });
  }
};

// ---------------------------------------------------------------------------
// Timer-expiry helper (handles both restart-recovery and normal timeout path)
// ---------------------------------------------------------------------------

/**
 * Called when the per-question timer has already expired before the user answered.
 * Marks the question wrong, edits the message, and advances to the next question.
 */
const handleTimedOutQuestion = async (ctx: BotContext, question: Question, index: number, questions: Question[]): Promise<void> => {
  const lang = ctx.lang();

  // Cancel any residual visual-countdown timers (best-effort)
  if (ctx.chat) cancelQuestionTimeout(ctx.chat.id);

  // Answer the callback query if this was triggered by a button press
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: t(lang, "test.timeout_auto"), show_alert: false }).catch(() => undefined);
  }

  const sessionId = ctx.session.sessionId;
  if (sessionId) {
    await testSessionRepository.updateAnswer(sessionId, {
      questionId: question.id,
      userAnswer: "",
      isCorrect: false
    } as QuestionAnswer);
  }

  const messageId = ctx.session.testQuestionMessageId;
  if (messageId) {
    const timedOutText = `${formatQuestionText(question, index, questions.length, lang)}\n\n${t(lang, "test.timeout_auto")}`;
    await safeEditMessageViaApi(ctx.api, ctx.chatId!, messageId, timedOutText, { reply_markup: new InlineKeyboard() });
  }

  ctx.session.currentQuestionIndex = index + 1;
  ctx.session.questionStartedAt = undefined;
  ctx.session.testQuestionMessageId = undefined;
  await sendCurrentQuestion(ctx);
};

// ---------------------------------------------------------------------------
// Answering sub-state
// ---------------------------------------------------------------------------

const handleAnswering = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();

  if (!ctx.session.activeTestId) {
    await ctx.reply(t(lang, "test.noActiveTest"));
    return;
  }

  const questions = await resolveQuestions(ctx);
  const index = ctx.session.currentQuestionIndex ?? 0;
  const question = questions[index] as Question | undefined;

  if (!question) {
    await completeTest(ctx, questions.length);
    return;
  }

  // Restart-recovery: startup scan cleared questionStartedAt for already-expired timers.
  // The sentinel is: testQuestionMessageId set (question was in-flight) but questionStartedAt cleared.
  const timeLimitSeconds = ctx.session.timeLimitSeconds ?? 0;
  if (timeLimitSeconds > 0 && ctx.session.testQuestionMessageId !== undefined && ctx.session.questionStartedAt === undefined) {
    await handleTimedOutQuestion(ctx, question, index, questions);
    return;
  }

  const sessionId = ctx.session.sessionId;
  if (!sessionId) {
    await sendCurrentQuestion(ctx);
    return;
  }

  if (question.type === "mcq" || question.type === "truefalse") {
    await handleChoiceAnswer(ctx, question, index, questions.length, sessionId);
  } else {
    await handleTextAnswer(ctx, question, index, sessionId);
  }
};

const handleChoiceAnswer = async (
  ctx: BotContext,
  question: Question,
  index: number,
  total: number,
  sessionId: string
): Promise<void> => {
  const lang = ctx.lang();
  const answer = ctx.callbackQuery?.data;

  if (!answer?.startsWith(ANSWER_CALLBACK_PREFIX)) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: t(lang, "test.chooseAnswerToast"), show_alert: false });
    } else {
      await ctx.reply(t(lang, "test.useAnswerButtons"));
    }
    return;
  }

  // Cancel any pending auto-advance for this question
  if (ctx.chat) cancelQuestionTimeout(ctx.chat.id);

  const userAnswer = answer.slice(ANSWER_CALLBACK_PREFIX.length);

  // Check if the per-question timer has expired
  const timeLimitSeconds = ctx.session.timeLimitSeconds ?? 0;
  const elapsed = Math.floor((Date.now() - (ctx.session.questionStartedAt ?? Date.now())) / 1000);
  const timedOut = timeLimitSeconds > 0 && elapsed > timeLimitSeconds;

  const isCorrect = !timedOut && userAnswer === question.correctAnswer;

  await testSessionRepository.updateAnswer(sessionId, {
    questionId: question.id,
    userAnswer,
    isCorrect
  } as QuestionAnswer);

  logger.info("Test answer submitted", { event: "test.answer.submitted", userId: ctx.from?.id, questionIndex: index, type: question.type, isCorrect, timedOut });

  const feedback = timedOut
    ? t(lang, "test.timeout", { answer: question.correctAnswer })
    : isCorrect
      ? t(lang, "test.correct")
      : t(lang, "test.wrong", { answer: question.correctAnswer });

  await ctx.answerCallbackQuery({ text: isCorrect ? t(lang, "test.correctToast") : t(lang, "test.recordedToast"), show_alert: false });

  const messageId = ctx.session.testQuestionMessageId;
  if (messageId) {
    await safeEditMessageViaApi(ctx.api, ctx.chatId!, messageId, `${formatQuestionText(question, index, total, lang)}\n\n${feedback}`);
  }

  if (isCorrect) {
    ctx.session.testCorrectCount = (ctx.session.testCorrectCount ?? 0) + 1;
  }

  ctx.session.currentQuestionIndex = index + 1;
  ctx.session.questionStartedAt = undefined;
  ctx.session.testQuestionMessageId = undefined;
  await sendCurrentQuestion(ctx);
};

const handleTextAnswer = async (
  ctx: BotContext,
  question: Question,
  index: number,
  sessionId: string
): Promise<void> => {
  const lang = ctx.lang();
  const userAnswer = ctx.msg?.text?.trim();

  if (!userAnswer) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: t(lang, "test.typeAnswerToast"), show_alert: false });
    } else {
      await ctx.reply(t(lang, "test.typeAnswerChat"));
    }
    return;
  }

  // Cancel any pending auto-advance for this question
  if (ctx.chat) cancelQuestionTimeout(ctx.chat.id);

  // Check if the per-question timer has expired
  const timeLimitSeconds = ctx.session.timeLimitSeconds ?? 0;
  const elapsed = Math.floor((Date.now() - (ctx.session.questionStartedAt ?? Date.now())) / 1000);
  const timedOut = timeLimitSeconds > 0 && elapsed > timeLimitSeconds;

  if (timedOut) {
    await testSessionRepository.updateAnswer(sessionId, {
      questionId: question.id,
      userAnswer,
      isCorrect: false
    } as QuestionAnswer);

    logger.info("Test answer submitted", { event: "test.answer.submitted", userId: ctx.from?.id, questionIndex: index, type: question.type, isCorrect: false, timedOut: true });

    const questions = await resolveQuestions(ctx);
    const messageId = ctx.session.testQuestionMessageId;
    if (messageId) {
      const feedback = t(lang, "test.timeout", { answer: question.correctAnswer });
      await safeEditMessageViaApi(ctx.api, ctx.chatId!, messageId, `${formatQuestionText(question, index, questions.length, lang)}\n\n${feedback}`);
    }

    ctx.session.currentQuestionIndex = index + 1;
    ctx.session.questionStartedAt = undefined;
    ctx.session.testQuestionMessageId = undefined;
    await sendCurrentQuestion(ctx);
    return;
  }

  ctx.session.testPendingTextAnswer = userAnswer;
  ctx.session.testSubState = "self_grading";

  const prompt = await ctx.reply(
    t(lang, "test.selfGradePrompt", { answer: question.correctAnswer }),
    { reply_markup: buildSelfGradeKeyboard(lang) }
  );
  ctx.session.testSelfGradePromptMessageId = prompt.message_id;
};

// ---------------------------------------------------------------------------
// Self-grading sub-state
// ---------------------------------------------------------------------------

const handleSelfGrading = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const data = ctx.callbackQuery?.data;

  if (!data?.startsWith(SELF_GRADE_CALLBACK_PREFIX)) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: t(lang, "test.useGradeButtonsToast"), show_alert: false });
    } else {
      await ctx.reply(t(lang, "test.tapGradeButtons"));
    }
    return;
  }

  const isCorrect = data.slice(SELF_GRADE_CALLBACK_PREFIX.length) === "correct";
  const userAnswer = ctx.session.testPendingTextAnswer ?? "";
  const sessionId = ctx.session.sessionId;

  if (!sessionId) {
    await ctx.answerCallbackQuery();
    await ctx.reply(t(lang, "test.sessionError"));
    return;
  }

  const questions = await resolveQuestions(ctx);
  const index = ctx.session.currentQuestionIndex ?? 0;
  const question = questions[index] as Question | undefined;

  if (!question) {
    await ctx.answerCallbackQuery();
    await completeTest(ctx, questions.length);
    return;
  }

  await testSessionRepository.updateAnswer(sessionId, {
    questionId: question.id,
    userAnswer,
    isCorrect,
    selfGraded: true
  } as QuestionAnswer);

  logger.info("Test answer self-graded", { event: "test.answer.selfgraded", userId: ctx.from?.id, questionIndex: index, markedCorrect: isCorrect });

  await ctx.answerCallbackQuery({ text: t(lang, "test.answerRecordedToast"), show_alert: false });

  const promptMessageId = ctx.session.testSelfGradePromptMessageId;
  if (promptMessageId) {
    await ctx.api.editMessageReplyMarkup(ctx.chatId!, promptMessageId, { reply_markup: undefined });
  }

  if (isCorrect) {
    ctx.session.testCorrectCount = (ctx.session.testCorrectCount ?? 0) + 1;
  }

  ctx.session.currentQuestionIndex = index + 1;
  ctx.session.questionStartedAt = undefined;
  ctx.session.testPendingTextAnswer = undefined;
  ctx.session.testSelfGradePromptMessageId = undefined;
  ctx.session.testSubState = "answering";
  await sendCurrentQuestion(ctx);
};

// ---------------------------------------------------------------------------
// Complete test
// ---------------------------------------------------------------------------

const completeTest = async (ctx: BotContext, totalQuestions: number): Promise<void> => {
  const lang = ctx.lang();
  const sessionId = ctx.session.sessionId;
  const correctCount = ctx.session.testCorrectCount ?? 0;

  if (!sessionId) throw new AppError("Cannot complete test without an active session", { statusCode: 500, code: "TEST_SESSION_COMPLETE_FAILED" });

  if (!ctx.user) {
    resetSession(ctx.session);
    await ctx.reply(t(lang, "error.session_corrupted"));
    return;
  }

  const score = Math.round((correctCount / totalQuestions) * 100);

  const [completed] = await Promise.all([
    testSessionRepository.complete(sessionId, { score, correctCount, totalQuestions, completedAt: new Date() }),
    userRepository.incrementTotalTestsTaken(ctx.user._id)
  ]);

  if (!completed) {
    resetSession(ctx.session);
    await ctx.reply(t(lang, "error.session_corrupted"));
    return;
  }

  try {
    await releaseActiveTestSessionSlot(ctx);
  } catch (error) {
    logger.error("Failed to release test session slot", { event: "test.slot.release.failed", error: error instanceof Error ? error.message : String(error) });
  }

  const activeTestId = ctx.session.activeTestId;
  const timeTakenSeconds = Math.floor((Date.now() - (ctx.session.testStartedAt ?? Date.now())) / 1000);

  logger.info("Test completed", { event: "test.completed", userId: ctx.from?.id, testId: activeTestId, score, correctCount, totalQuestions, timeTakenSeconds });

  // Upsert leaderboard entry and get user rank
  let rankLine: string | undefined;
  let hintLine: string | undefined;
  let showLeaderboard = false;
  if (activeTestId) {
    try {
      await leaderboardRepository.upsertEntry({
        testId: activeTestId,
        userId: ctx.user._id,
        firstName: ctx.from?.first_name ?? ctx.user.firstName ?? "User",
        username: ctx.from?.username,
        score,
        correctCount,
        totalQuestions,
        timeTakenSeconds
      });

      const { rank, totalParticipants } = await leaderboardRepository.getUserRank(activeTestId, ctx.user._id);
      if (totalParticipants >= 2) {
        rankLine = t(lang, "leaderboard.rank", { rank, total: totalParticipants });
        showLeaderboard = true;
      } else {
        hintLine = t(lang, "leaderboard.hint_unlock");
      }
    } catch (error) {
      logger.error("Leaderboard write failed after test completion — score card will still be shown", {
        event: "leaderboard.write.failed",
        userId: ctx.user._id,
        error: error instanceof Error ? error.message : String(error)
      });
      // rank and totalParticipants stay at defaults — score card is always shown below
    }
  }

  const wrongCount = totalQuestions - correctCount;
  const lines = [
    t(lang, "test.complete.title"),
    t(lang, "test.complete.separator"),
    t(lang, "test.complete.score", { correct: correctCount, total: totalQuestions, pct: score }),
    buildStars(score),
    "",
    t(lang, "test.complete.correctCount", { n: correctCount }),
    t(lang, "test.complete.wrongCount", { n: wrongCount })
  ];

  if (rankLine) {
    lines.push("", rankLine);
  } else if (hintLine) {
    lines.push("", hintLine);
  }

  await ctx.reply(lines.join("\n"), { reply_markup: buildCompletionKeyboard(lang, activeTestId, showLeaderboard) });

  ctx.session.testStartedAt = undefined;
  ctx.session.testSubState = "completed";
};

// ---------------------------------------------------------------------------
// Completed sub-state (score card buttons)
// ---------------------------------------------------------------------------

const handleCompleted = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const data = ctx.callbackQuery?.data;

  if (!data) {
    await ctx.reply(t(lang, "test.useScoreCardButtons"));
    return;
  }

  if (data === SHARE_CALLBACK) {
    await ctx.answerCallbackQuery();
    await showShareCard(ctx);
    return;
  }

  if (data === RETAKE_CALLBACK) {
    await ctx.answerCallbackQuery();
    const testId = ctx.session.activeTestId!;
    await enterTestFlow(ctx, testId);
    await ctx.reply(t(lang, "test.retakeStarting"));
    return;
  }

  if (data === MAIN_MENU_CALLBACK) {
    await ctx.answerCallbackQuery();
    resetSession(ctx.session);
    await ctx.reply(t(lang, "test.mainMenu"));
    return;
  }

  if (data === REVIEW_ANSWERS_CALLBACK || data.startsWith(REVIEW_ANSWERS_PAGE_PREFIX)) {
    await ctx.answerCallbackQuery();
    const page = data.startsWith(REVIEW_ANSWERS_PAGE_PREFIX)
      ? (parseInt(data.slice(REVIEW_ANSWERS_PAGE_PREFIX.length), 10) || 0)
      : 0;
    const review = await buildAnswerReviewPage(ctx, lang, page);
    if (!review) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.session_not_found"), show_alert: true });
      return;
    }
    if (data === REVIEW_ANSWERS_CALLBACK) {
      // First open: send as new message
      await ctx.reply(review.text, { reply_markup: review.keyboard });
    } else {
      // Navigation: edit the current review message
      await ctx.editMessageText(review.text, { reply_markup: review.keyboard }).catch(() => undefined);
    }
    return;
  }

  if (data === REVIEW_BACK_CALLBACK) {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => undefined);
    return;
  }

  if (data.startsWith(LEADERBOARD_CALLBACK_PREFIX)) {
    await ctx.answerCallbackQuery();
    const testId = data.slice(LEADERBOARD_CALLBACK_PREFIX.length);
    const { renderLeaderboard } = await import("./leaderboard.handler.js");
    const result = await renderLeaderboard(testId, ctx.user?._id ? String(ctx.user._id) : undefined, lang);
    await ctx.reply(result.text);
    return;
  }

  await ctx.answerCallbackQuery({ text: t(lang, "test.useScoreCardButtonsToast"), show_alert: false });
};

const showShareCard = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const activeTestId = ctx.session.activeTestId;
  if (!activeTestId) throw new ValidationError("Active test is missing, so the share link cannot be created", "ACTIVE_TEST_MISSING");

  const [test, participantCount] = await Promise.all([
    testRepository.ensureShareCode(activeTestId),
    leaderboardRepository.getParticipantCount(activeTestId).catch(() => 0)
  ]);
  if (!test) throw new NotFoundError("Test not found for sharing", "TEST_NOT_FOUND");

  const shareCode = `TEST-${test.shareCode}`;
  const username = ctx.me.username ?? "your_bot";
  const link = `https://t.me/${username}?start=${shareCode}`;

  const challengeLine =
    participantCount === 0
      ? t(lang, "share.challenge_first")
      : participantCount === 1
      ? t(lang, "share.challenge_one")
      : t(lang, "share.challenge_many", { count: participantCount });

  logger.info("Test share code generated", { event: "test.share.generated", userId: ctx.from?.id, testId: activeTestId, shareCode });

  const instructions = t(lang, "share.instructions", { code: shareCode, link });
  await ctx.reply(
    `${t(lang, "test.shareCard", { instructions })}\n\n${challengeLine}`,
    { reply_markup: buildShareKeyboard(link, lang) }
  );
};

// ---------------------------------------------------------------------------
// Answer review
// ---------------------------------------------------------------------------

type AnswerReviewPage = { text: string; keyboard: InlineKeyboard };

const buildAnswerReviewPage = async (
  ctx: BotContext,
  lang: Language,
  page: number
): Promise<AnswerReviewPage | null> => {
  const sessionId = ctx.session.sessionId;
  const activeTestId = ctx.session.activeTestId;

  if (!sessionId || !activeTestId) return null;

  const [session, test] = await Promise.all([
    testSessionRepository.findByIdWithTest(sessionId),
    testRepository.findById(activeTestId)
  ]);

  if (!session || !test) return null;

  const answers = session.answers as Array<{ questionId: string; userAnswer: string; isCorrect: boolean; selfGraded?: boolean }>;
  const questions = test.questions as Array<{ id: string; question: string; correctAnswer: string; type: string }>;

  // Build a lookup from questionId → question
  const questionMap = new Map(questions.map((q) => [q.id, q]));

  // Pair answers with their questions in order
  const pairs = answers.map((a) => ({ answer: a, question: questionMap.get(a.questionId) }));

  const totalPages = Math.max(1, Math.ceil(pairs.length / REVIEW_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = pairs.slice(safePage * REVIEW_PAGE_SIZE, (safePage + 1) * REVIEW_PAGE_SIZE);

  const SEP = "━━━━━━━━━━━━━━━━";
  const correctCount = answers.filter((a) => a.isCorrect).length;
  const lines: string[] = [t(lang, "test.review.title", { correct: correctCount, total: answers.length })];

  for (let i = 0; i < slice.length; i++) {
    const { answer, question } = slice[i]!;
    const globalN = safePage * REVIEW_PAGE_SIZE + i + 1;
    const qText = question ? (question.question.length > 100 ? `${question.question.slice(0, 100)}…` : question.question) : `[Q${globalN}]`;

    let statusLine: string;
    if (answer.selfGraded !== undefined) {
      statusLine = answer.isCorrect ? t(lang, "test.review.self_correct") : t(lang, "test.review.self_wrong");
    } else if (answer.isCorrect) {
      statusLine = t(lang, "test.review.correct", { answer: answer.userAnswer });
    } else {
      const correct = question?.correctAnswer ?? "?";
      statusLine = t(lang, "test.review.wrong", { answer: answer.userAnswer, correct });
    }

    lines.push("", SEP, `Q${globalN}: ${qText}`, statusLine);
  }
  lines.push(SEP);

  const kb = new InlineKeyboard();
  if (safePage > 0) kb.text("◀", `${REVIEW_ANSWERS_PAGE_PREFIX}${safePage - 1}`);
  if (totalPages > 1) kb.text(`${safePage + 1}/${totalPages}`, REVIEW_ANSWERS_CALLBACK);
  if (safePage < totalPages - 1) kb.text("▶", `${REVIEW_ANSWERS_PAGE_PREFIX}${safePage + 1}`);
  kb.row().text(t(lang, "test.review.btn.back"), REVIEW_BACK_CALLBACK);

  return { text: lines.join("\n"), keyboard: kb };
};
