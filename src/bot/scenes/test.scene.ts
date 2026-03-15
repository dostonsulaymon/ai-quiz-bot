import { Conversation } from "@grammyjs/conversations";
import { InlineKeyboard } from "grammy";
import { UserRepository } from "../../db/repositories/user.repository.js";
import { TestRepository } from "../../db/repositories/test.repository.js";
import { TestSessionRepository } from "../../db/repositories/test-session.repository.js";
import { AppError } from "../../shared/errors/AppError.js";
import { logger } from "../../shared/logger.js";
import { NotFoundError } from "../../shared/errors/NotFoundError.js";
import { ValidationError } from "../../shared/errors/ValidationError.js";
import type { Question, QuestionAnswer } from "../../shared/types/index.js";
import type { BotContext } from "../types.js";
import { resetSession } from "../types.js";
import { acquireActiveTestSessionSlot, releaseActiveTestSessionSlot } from "../middlewares/rateLimitMiddleware.js";

export const TEST_CONVERSATION_NAME = "test";

const ANSWER_CALLBACK_PREFIX = "test:answer:";
const SELF_GRADE_CALLBACK_PREFIX = "test:self:";
const SHARE_CALLBACK = "test:share";
const RETAKE_CALLBACK = "test:retake";
const MAIN_MENU_CALLBACK = "test:menu";
const CANCELLED = Symbol("test-cancelled");

const testRepository = new TestRepository();
const testSessionRepository = new TestSessionRepository();
const userRepository = new UserRepository();

const isCancelMessage = (ctx: BotContext): boolean => ctx.msg?.text?.trim() === "/cancel";

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

const formatQuestionHeader = (index: number, total: number): string => {
  const current = index + 1;
  const percentage = Math.round((current / total) * 100);
  return `Question ${current} of ${total}  [${buildProgressBar(current, total)}] ${percentage}%`;
};

const formatQuestionText = (question: Question, index: number, total: number): string => {
  const lines = [formatQuestionHeader(index, total), "", question.question];

  if (question.type === "mcq" && question.options) {
    lines.push("");
    lines.push(`A. ${question.options.A}`);
    lines.push(`B. ${question.options.B}`);
    lines.push(`C. ${question.options.C}`);
    lines.push(`D. ${question.options.D}`);
  } else if (question.type === "short" || question.type === "fill") {
    lines.push("");
    lines.push("Type your answer:");
  }

  return lines.join("\n");
};

const buildMcqKeyboard = (): InlineKeyboard =>
  new InlineKeyboard().text("A", `${ANSWER_CALLBACK_PREFIX}A`).text("B", `${ANSWER_CALLBACK_PREFIX}B`).text("C", `${ANSWER_CALLBACK_PREFIX}C`).text("D", `${ANSWER_CALLBACK_PREFIX}D`);

const buildTrueFalseKeyboard = (): InlineKeyboard =>
  new InlineKeyboard().text("✅ True", `${ANSWER_CALLBACK_PREFIX}True`).text("❌ False", `${ANSWER_CALLBACK_PREFIX}False`);

const buildSelfGradeKeyboard = (): InlineKeyboard =>
  new InlineKeyboard()
    .text("✅ Yes, I got it", `${SELF_GRADE_CALLBACK_PREFIX}correct`)
    .text("❌ No, I missed it", `${SELF_GRADE_CALLBACK_PREFIX}wrong`);

const buildCompletionKeyboard = (): InlineKeyboard =>
  new InlineKeyboard()
    .text("📤 Share this test", SHARE_CALLBACK)
    .text("🔄 Retake", RETAKE_CALLBACK)
    .text("🏠 Main menu", MAIN_MENU_CALLBACK);

const buildShareKeyboard = (link: string): InlineKeyboard => new InlineKeyboard().url("📋 Copy link", link);

const waitForUpdate = async (
  conversation: Conversation<BotContext, BotContext>
): Promise<BotContext | typeof CANCELLED> => {
  const ctx = await conversation.wait();

  if (isCancelMessage(ctx)) {
    // Session writes inside a conversation must go through external() so they
    // are skipped on replay instead of being re-applied and corrupting state.
    await conversation.external((liveCtx) => { resetSession(liveCtx.session); });
    await ctx.reply("Your current flow has been cancelled and your session is back to idle.");
    return CANCELLED;
  }

  return ctx;
};

const delay = async (conversation: Conversation<BotContext, BotContext>, ms: number): Promise<void> => {
  await conversation.external(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
};

const createOrReuseSession = async (
  conversation: Conversation<BotContext, BotContext>,
  ctx: BotContext,
  totalQuestions: number
): Promise<string> => {
  const existingSessionId = await conversation.external((ctx) => ctx.session.sessionId);
  if (existingSessionId) {
    return existingSessionId;
  }

  const activeTestId = await conversation.external((ctx) => ctx.session.activeTestId);
  if (!activeTestId) {
    throw new ValidationError("Active test is missing from session", "ACTIVE_TEST_MISSING");
  }

  // Rule 3: Redis-backed active-session limits must run outside replay.
  await conversation.external((ctx) => acquireActiveTestSessionSlot(ctx));
  const user = await conversation.external(async () => {
    if (!ctx.from?.id) {
      throw new AppError("User context is missing for test session creation", {
        statusCode: 500,
        code: "USER_CONTEXT_MISSING"
      });
    }

    return userRepository.findOrCreate(ctx.from.id);
  });
  const testSession = await conversation.external(async () =>
    testSessionRepository.create({
      testId: activeTestId,
      userId: user._id,
      totalQuestions,
      status: "in_progress"
    })
  );

  await conversation.external((ctx) => {
    // Rule 1: session writes in conversations must go through external.
    ctx.session.sessionId = String(testSession._id);
  });
  return String(testSession._id);
};

const recordAnswer = async (
  conversation: Conversation<BotContext, BotContext>,
  sessionId: string,
  answer: QuestionAnswer
): Promise<void> => {
  await conversation.external(async () => {
    await testSessionRepository.updateAnswer(sessionId, answer);
  });
};

const completeSession = async (
  conversation: Conversation<BotContext, BotContext>,
  ctx: BotContext,
  correctCount: number,
  totalQuestions: number
): Promise<number> => {
  const { sessionId } = await conversation.external((ctx) => ({
    sessionId: ctx.session.sessionId
  }));
  if (!sessionId) {
    throw new AppError("Cannot complete test without an active session and user", {
      statusCode: 500,
      code: "TEST_SESSION_COMPLETE_FAILED"
    });
  }

  const score = Math.round((correctCount / totalQuestions) * 100);
  const user = await conversation.external(async () => {
    if (!ctx.from?.id) {
      throw new AppError("User context is missing for test completion", {
        statusCode: 500,
        code: "USER_CONTEXT_MISSING"
      });
    }

    return userRepository.findOrCreate(ctx.from.id);
  });

  await conversation.external(async () => {
    await Promise.all([
      testSessionRepository.complete(sessionId, {
        score,
        correctCount,
        totalQuestions,
        completedAt: new Date()
      }),
      userRepository.incrementTotalTestsTaken(user._id)
    ]);
  });

  // Rule 3: Redis-backed active-session limits must run outside replay.
  await conversation.external((ctx) => releaseActiveTestSessionSlot(ctx));

  return score;
};

const sendQuestion = async (
  ctx: BotContext,
  question: Question,
  index: number,
  total: number
): Promise<number> => {
  const replyMarkup =
    question.type === "mcq" ? buildMcqKeyboard() : question.type === "truefalse" ? buildTrueFalseKeyboard() : undefined;

  const message = await ctx.reply(formatQuestionText(question, index, total), {
    reply_markup: replyMarkup
  });

  return message.message_id;
};

const handleChoiceQuestion = async (
  conversation: Conversation<BotContext, BotContext>,
  ctx: BotContext,
  messageId: number,
  question: Question,
  index: number,
  total: number,
  sessionId: string
): Promise<boolean | typeof CANCELLED> => {
  while (true) {
    const nextCtx = await waitForUpdate(conversation);
    if (nextCtx === CANCELLED) {
      return CANCELLED;
    }
    const answer = nextCtx.callbackQuery?.data;

    if (!answer?.startsWith(ANSWER_CALLBACK_PREFIX)) {
      if (nextCtx.callbackQuery) {
        await nextCtx.answerCallbackQuery({ text: "Choose one of the answer buttons below.", show_alert: false });
      } else {
        await nextCtx.reply("Use the answer buttons below this question.");
      }
      continue;
    }

    const userAnswer = answer.slice(ANSWER_CALLBACK_PREFIX.length);
    const isCorrect = userAnswer === question.correctAnswer;

    await recordAnswer(conversation, sessionId, {
      questionId: question.id,
      userAnswer,
      isCorrect
    });
    logger.info("Test answer submitted", {
      event: "test.answer.submitted",
      userId: nextCtx.from?.id,
      questionIndex: index,
      type: question.type,
      isCorrect
    });

    const feedback = isCorrect
      ? "✅ Correct!"
      : `❌ Wrong — correct answer was ${question.correctAnswer}`;

    await nextCtx.answerCallbackQuery({ text: isCorrect ? "Correct!" : "Recorded", show_alert: false });
    await nextCtx.api.editMessageText(
      nextCtx.chatId!,
      messageId,
      `${formatQuestionText(question, index, total)}\n\n${feedback}`
    );

    await delay(conversation, 1500);
    return isCorrect;
  }
};

const handleTextQuestion = async (
  conversation: Conversation<BotContext, BotContext>,
  question: Question,
  index: number,
  sessionId: string
): Promise<boolean | typeof CANCELLED> => {
  while (true) {
    const answerCtx = await waitForUpdate(conversation);
    if (answerCtx === CANCELLED) {
      return CANCELLED;
    }
    const userAnswer = answerCtx.msg?.text?.trim();

    if (!userAnswer) {
      if (answerCtx.callbackQuery) {
        await answerCtx.answerCallbackQuery({ text: "Type your answer in chat.", show_alert: false });
      } else {
        await answerCtx.reply("Please type your answer in chat.");
      }
      continue;
    }

    const prompt = await answerCtx.reply(
      `📖 Correct answer: ${question.correctAnswer}\nDid you get it right?`,
      { reply_markup: buildSelfGradeKeyboard() }
    );

    while (true) {
      const gradeCtx = await waitForUpdate(conversation);
      if (gradeCtx === CANCELLED) {
        return CANCELLED;
      }
      const data = gradeCtx.callbackQuery?.data;

      if (!data?.startsWith(SELF_GRADE_CALLBACK_PREFIX)) {
        if (gradeCtx.callbackQuery) {
          await gradeCtx.answerCallbackQuery({ text: "Use the yes/no buttons to grade yourself.", show_alert: false });
        } else {
          await gradeCtx.reply("Tap one of the self-grading buttons to continue.");
        }
        continue;
      }

      const isCorrect = data.slice(SELF_GRADE_CALLBACK_PREFIX.length) === "correct";

      await recordAnswer(conversation, sessionId, {
        questionId: question.id,
        userAnswer,
        isCorrect,
        selfGraded: true
      });
      logger.info("Test answer self-graded", {
        event: "test.answer.selfgraded",
        userId: gradeCtx.from?.id,
        questionIndex: index,
        markedCorrect: isCorrect
      });

      await gradeCtx.answerCallbackQuery({ text: "Answer recorded", show_alert: false });
      await gradeCtx.api.editMessageReplyMarkup(gradeCtx.chatId!, prompt.message_id, { reply_markup: undefined });
      return isCorrect;
    }
  }
};

const showCompletionCard = async (
  ctx: BotContext,
  correctCount: number,
  totalQuestions: number,
  score: number
): Promise<void> => {
  const wrongCount = totalQuestions - correctCount;

  await ctx.reply(
    [
      "🎉 Test Complete!",
      "━━━━━━━━━━━━━━━━",
      `Score: ${correctCount}/${totalQuestions}  (${score}%)`,
      buildStars(score),
      "",
      `✅ Correct: ${correctCount}`,
      `❌ Wrong: ${wrongCount}`
    ].join("\n"),
    { reply_markup: buildCompletionKeyboard() }
  );
};

const showShareCard = async (
  conversation: Conversation<BotContext, BotContext>,
  ctx: BotContext
): Promise<void> => {
  const activeTestId = await conversation.external((ctx) => ctx.session.activeTestId);
  if (!activeTestId) {
    throw new ValidationError("Active test is missing, so the share link cannot be created", "ACTIVE_TEST_MISSING");
  }

  const test = await conversation.external(async () => testRepository.ensureShareCode(activeTestId));
  if (!test) {
    throw new NotFoundError("Test not found for sharing", "TEST_NOT_FOUND");
  }

  const shareCode = `TEST-${test.shareCode}`;
  logger.info("Test share code generated", {
    event: "test.share.generated",
    userId: ctx.from?.id,
    testId: activeTestId,
    shareCode
  });
  const username = ctx.me.username ?? "your_bot";
  const link = `https://t.me/${username}?start=${shareCode}`;

  await ctx.reply(
    `Share this test:\nCode: ${shareCode}\nLink: ${link}`,
    { reply_markup: buildShareKeyboard(link) }
  );
};

const resetForRetake = (ctx: BotContext): void => {
  ctx.session.currentQuestionIndex = 0;
  ctx.session.sessionId = undefined;
  ctx.session.state = "testing";
};

export const testScene = async (conversation: Conversation<BotContext, BotContext>, ctx: BotContext): Promise<void> => {
  const activeTestId = await conversation.external((ctx) => ctx.session.activeTestId);
  if (!activeTestId) {
    await ctx.reply("There is no active test to run right now.");
    return;
  }

  while (true) {
      const currentActiveTestId = await conversation.external((ctx) => ctx.session.activeTestId);
      const test = await conversation.external(async () => testRepository.findById(currentActiveTestId!));
      if (!test) {
        throw new NotFoundError("The requested test could not be found", "TEST_NOT_FOUND");
      }

      const questions = test.questions;
      if (questions.length === 0) {
        throw new ValidationError("This test does not contain any questions", "TEST_EMPTY");
      }

      await conversation.external((ctx) => {
        // Rule 1: session writes in conversations must go through external.
        ctx.session.state = "testing";
        ctx.session.currentQuestionIndex = 0;
      });
      // Rule 4: Date.now is non-deterministic, so read it outside replay.
      const startedAt = await conversation.external(() => Date.now());
      logger.info("Test scene entered", {
        event: "test.scene.enter",
        userId: ctx.from?.id,
        testId: currentActiveTestId,
        questionCount: questions.length
      });

      const sessionId = await createOrReuseSession(conversation, ctx, questions.length);
      let correctCount = 0;

      for (let index = 0; index < questions.length; index += 1) {
        const question = questions[index] as Question;
        await conversation.external((ctx) => {
          // Rule 1: session writes in conversations must go through external.
          ctx.session.currentQuestionIndex = index;
        });

        const messageId = await sendQuestion(ctx, question, index, questions.length);
        const isCorrect =
          question.type === "mcq" || question.type === "truefalse"
            ? await handleChoiceQuestion(conversation, ctx, messageId, question, index, questions.length, sessionId)
            : await handleTextQuestion(conversation, question, index, sessionId);

        if (isCorrect === CANCELLED) {
          // Rule 3: Redis-backed active-session limits must run outside replay.
          await conversation.external((ctx) => releaseActiveTestSessionSlot(ctx));
          return;
        }

        if (isCorrect) {
          correctCount += 1;
        }
      }

      const score = await completeSession(conversation, ctx, correctCount, questions.length);
      logger.info("Test completed", {
        event: "test.completed",
        userId: ctx.from?.id,
        testId: currentActiveTestId,
        score,
        correctCount,
        totalQuestions: questions.length,
        durationMs: (await conversation.external(() => Date.now())) - startedAt
      });
      await showCompletionCard(ctx, correctCount, questions.length, score);

      while (true) {
        const nextCtx = await waitForUpdate(conversation);
        if (nextCtx === CANCELLED) {
          return;
        }
        const data = nextCtx.callbackQuery?.data;

        if (!data) {
          await nextCtx.reply("Use the buttons on the score card to choose what to do next.");
          continue;
        }

        if (data === SHARE_CALLBACK) {
          await nextCtx.answerCallbackQuery();
          await showShareCard(conversation, nextCtx);
          continue;
        }

        if (data === RETAKE_CALLBACK) {
          await nextCtx.answerCallbackQuery();
          await conversation.external((ctx) => {
            // Rule 1: session writes in conversations must go through external.
            resetForRetake(ctx);
          });
          await nextCtx.reply("Starting a fresh retake now.");
          break;
        }

        if (data === MAIN_MENU_CALLBACK) {
          await nextCtx.answerCallbackQuery();
          await conversation.external((ctx) => {
            // Rule 1: session writes in conversations must go through external.
            resetSession(ctx.session);
          });
          await nextCtx.reply("Back to the main menu.\nUse /newtest to create a new quiz or /join to take a shared one.");
          return;
        }

        await nextCtx.answerCallbackQuery({ text: "Use one of the score card buttons.", show_alert: false });
      }
    }
};
