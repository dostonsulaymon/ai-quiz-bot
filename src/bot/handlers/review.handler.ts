import { InlineKeyboard } from "grammy";
import { generateWithFallback } from "../../ai/ai.factory.js";
import { TestRepository } from "../../db/repositories/test.repository.js";
import { AppError } from "../../shared/errors/AppError.js";
import { logger } from "../../shared/logger.js";
import { ValidationError } from "../../shared/errors/ValidationError.js";
import { assertGenerationRateLimit } from "../middlewares/rateLimitMiddleware.js";
import type { GenerateQuestionsInput, Question, QuestionType, TestSourceType } from "../../shared/types/index.js";
import type { BotContext, UploadedFile } from "../types.js";
import { resetSession } from "../types.js";
import { transitionTo } from "../state-machine.js";
import { getUploadData, deleteAllUploadData } from "../utils/upload-storage.js";
import { t, type Language } from "../../shared/i18n/index.js";
import { safeEditMessageViaApi } from "../utils/telegram.js";
import { formatQuestionDisplay, formatOptionDisplay } from "../utils/format.js";

const REVIEW_PREV_CALLBACK = "review:prev";
const REVIEW_NEXT_CALLBACK = "review:next";
const REVIEW_EDIT_CALLBACK = "review:edit";
const REVIEW_REGENERATE_CALLBACK = "review:regenerate";
const REVIEW_DELETE_CALLBACK = "review:delete";
const REVIEW_START_CALLBACK = "review:start";
const REVIEW_REGENERATE_ALL_CALLBACK = "review:regenerate-all";
const REVIEW_NOOP_CALLBACK = "review:noop";

const testRepository = new TestRepository();

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const formatQuestionCard = (question: Question, index: number, total: number, lang: Language): string => {
  const { display: questionDisplay, truncated } = formatQuestionDisplay(question.question);
  const lines = [t(lang, "review.card.header", { n: index + 1, total }), "", questionDisplay];
  if (truncated) lines.push(t(lang, "question.truncated_note"));

  if (question.type === "mcq" && question.options) {
    lines.push(
      "",
      `A. ${formatOptionDisplay(question.options.A)}`,
      `B. ${formatOptionDisplay(question.options.B)}`,
      `C. ${formatOptionDisplay(question.options.C)}`,
      `D. ${formatOptionDisplay(question.options.D)}`
    );
    lines.push("", t(lang, "review.card.answer", { answer: question.correctAnswer }));
  } else if (question.type === "truefalse") {
    lines.push("", t(lang, "review.card.answer", { answer: question.correctAnswer }));
  } else {
    lines.push("", t(lang, "review.card.answer", { answer: question.correctAnswer }));
  }

  if (question.explanation) {
    lines.push("", t(lang, "review.card.explanation", { explanation: question.explanation }));
  }

  return lines.join("\n");
};

const buildReviewKeyboard = (index: number, total: number, lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "review.btn.prev"), REVIEW_PREV_CALLBACK)
    .text(`${index + 1} / ${total}`, REVIEW_NOOP_CALLBACK)
    .text(t(lang, "review.btn.next"), REVIEW_NEXT_CALLBACK)
    .row()
    .text(t(lang, "review.btn.editAnswer"), REVIEW_EDIT_CALLBACK)
    .text(t(lang, "review.btn.regenerate"), REVIEW_REGENERATE_CALLBACK)
    .text(t(lang, "review.btn.delete"), REVIEW_DELETE_CALLBACK)
    .row()
    .text(t(lang, "review.btn.startTest", { n: total }), REVIEW_START_CALLBACK);

const buildEmptyKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard().text(t(lang, "review.btn.regenerateAll"), REVIEW_REGENERATE_ALL_CALLBACK);

// ---------------------------------------------------------------------------
// Enter review flow
// ---------------------------------------------------------------------------

export const enterReviewFlow = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const questions = ctx.session.draftQuestions ?? [];
  if (questions.length === 0) {
    await ctx.reply(t(lang, "review.noDraftQuestions"));
    return;
  }

  transitionTo(ctx.session, "reviewing", "enterReviewFlow");
  ctx.session.reviewIndex = 0;
  ctx.session.reviewSubState = "idle";
  ctx.session.reviewEditQuestionIndex = undefined;

  logger.info("Review flow entered", {
    event: "review.flow.enter",
    userId: ctx.from?.id,
    totalQuestions: questions.length
  });

  const msg = await ctx.reply(formatQuestionCard(questions[0]!, 0, questions.length, lang), {
    reply_markup: buildReviewKeyboard(0, questions.length, lang)
  });
  ctx.session.reviewMessageId = msg.message_id;
};

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

export const reviewRouter = async (ctx: BotContext): Promise<void> => {
  if (ctx.session.reviewSubState === "editing_answer") {
    await handleEditingAnswer(ctx);
    return;
  }

  await handleReviewMain(ctx);
};

// ---------------------------------------------------------------------------
// Main review handler
// ---------------------------------------------------------------------------

const handleReviewMain = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const data = ctx.callbackQuery?.data;

  if (!data) {
    await ctx.reply(t(lang, "review.useButtons"));
    return;
  }

  if (data === REVIEW_NOOP_CALLBACK) {
    await ctx.answerCallbackQuery();
    return;
  }

  const draftQuestions = ctx.session.draftQuestions ?? [];
  const reviewIndex = ctx.session.reviewIndex ?? 0;
  const messageId = ctx.session.reviewMessageId;

  if (!messageId) {
    // No review message yet — send one
    await ctx.answerCallbackQuery();
    await enterReviewFlow(ctx);
    return;
  }

  if (draftQuestions.length === 0 && data !== REVIEW_REGENERATE_ALL_CALLBACK) {
    await ctx.answerCallbackQuery({ text: t(lang, "review.noQuestionsToast"), show_alert: false });
    return;
  }

  switch (data) {
    case REVIEW_PREV_CALLBACK: {
      await ctx.answerCallbackQuery();
      if (draftQuestions.length > 0) {
        const nextIndex = reviewIndex === 0 ? draftQuestions.length - 1 : reviewIndex - 1;
        ctx.session.reviewIndex = nextIndex;
        await safeEditMessageViaApi(ctx.api, ctx.chatId!, messageId, formatQuestionCard(draftQuestions[nextIndex]!, nextIndex, draftQuestions.length, lang), {
          reply_markup: buildReviewKeyboard(nextIndex, draftQuestions.length, lang)
        });
      }
      break;
    }
    case REVIEW_NEXT_CALLBACK: {
      await ctx.answerCallbackQuery();
      if (draftQuestions.length > 0) {
        const nextIndex = (reviewIndex + 1) % draftQuestions.length;
        ctx.session.reviewIndex = nextIndex;
        await safeEditMessageViaApi(ctx.api, ctx.chatId!, messageId, formatQuestionCard(draftQuestions[nextIndex]!, nextIndex, draftQuestions.length, lang), {
          reply_markup: buildReviewKeyboard(nextIndex, draftQuestions.length, lang)
        });
      }
      break;
    }
    case REVIEW_EDIT_CALLBACK: {
      await ctx.answerCallbackQuery();
      const question = draftQuestions[reviewIndex];
      if (!question) {
        await ctx.reply(t(lang, "review.noQuestionToEdit"));
        break;
      }

      ctx.session.reviewSubState = "editing_answer";
      ctx.session.reviewEditQuestionIndex = reviewIndex;

      const hint =
        question.type === "mcq"
          ? t(lang, "review.editHintMcq")
          : question.type === "truefalse"
            ? t(lang, "review.editHintTrueFalse")
            : t(lang, "review.editHintOpen");

      await ctx.reply(hint);
      break;
    }
    case REVIEW_REGENERATE_CALLBACK: {
      const question = draftQuestions[reviewIndex];
      if (!question) {
        await ctx.answerCallbackQuery({ text: t(lang, "review.noQuestionToRegenerateToast"), show_alert: false });
        break;
      }

      logger.info("Review question regeneration started", {
        event: "review.question.regenerate.start",
        userId: ctx.from?.id,
        questionIndex: reviewIndex
      });
      await ctx.answerCallbackQuery();
      await safeEditMessageViaApi(ctx.api, ctx.chatId!, messageId, t(lang, "review.regenerating"));

      try {
        await assertGenerationRateLimit(ctx);
        const input = await buildInputFromSession(ctx, 1, [question.type]);
        if (!input) {
          await safeEditMessageViaApi(ctx.api, ctx.chatId!, messageId, formatQuestionCard(question, reviewIndex, draftQuestions.length, lang), {
            reply_markup: buildReviewKeyboard(reviewIndex, draftQuestions.length, lang)
          });
          await ctx.reply(t(lang, "upload.expired"));
          break;
        }
        const generated = await generateWithFallback(input);
        const replacement = generated[0];

        if (!replacement) {
          throw new AppError("AI did not return a replacement question", 502);
        }

        draftQuestions[reviewIndex] = replacement;
        ctx.session.draftQuestions = draftQuestions;

        logger.info("Review question regeneration succeeded", { event: "review.question.regenerate.success", userId: ctx.from?.id, questionIndex: reviewIndex });
        await safeEditMessageViaApi(ctx.api, ctx.chatId!, messageId, formatQuestionCard(replacement, reviewIndex, draftQuestions.length, lang), {
          reply_markup: buildReviewKeyboard(reviewIndex, draftQuestions.length, lang)
        });
      } catch (error) {
        logger.error("Review question regeneration failed", { event: "review.question.regenerate.failed", userId: ctx.from?.id, questionIndex: reviewIndex });
        await safeEditMessageViaApi(ctx.api, ctx.chatId!, messageId, formatQuestionCard(question, reviewIndex, draftQuestions.length, lang), {
          reply_markup: buildReviewKeyboard(reviewIndex, draftQuestions.length, lang)
        });
        await ctx.answerCallbackQuery({ text: t(lang, "review.regenerationFailedToast"), show_alert: false });
      }
      break;
    }
    case REVIEW_DELETE_CALLBACK: {
      await ctx.answerCallbackQuery();
      draftQuestions.splice(reviewIndex, 1);
      ctx.session.draftQuestions = draftQuestions;

      logger.info("Review question deleted", { event: "review.question.deleted", userId: ctx.from?.id, questionIndex: reviewIndex, remaining: draftQuestions.length });

      if (draftQuestions.length === 0) {
        ctx.session.reviewIndex = 0;
        await safeEditMessageViaApi(ctx.api, ctx.chatId!, messageId, t(lang, "review.noQuestionsRemain"), { reply_markup: buildEmptyKeyboard(lang) });
        break;
      }

      const nextIndex = Math.min(reviewIndex, draftQuestions.length - 1);
      ctx.session.reviewIndex = nextIndex;
      await safeEditMessageViaApi(ctx.api, ctx.chatId!, messageId, formatQuestionCard(draftQuestions[nextIndex]!, nextIndex, draftQuestions.length, lang), {
        reply_markup: buildReviewKeyboard(nextIndex, draftQuestions.length, lang)
      });
      break;
    }
    case REVIEW_REGENERATE_ALL_CALLBACK: {
      await ctx.answerCallbackQuery();
      await safeEditMessageViaApi(ctx.api, ctx.chatId!, messageId, t(lang, "review.regenerating"));

      try {
        const { questionCount, questionTypes } = ctx.session;
        if (!questionCount || !questionTypes?.length) {
          throw new ValidationError("Missing data required to regenerate questions", "UPLOAD_SESSION_INCOMPLETE");
        }

        const input = await buildInputFromSession(ctx, questionCount, questionTypes);
        if (!input) {
          await safeEditMessageViaApi(ctx.api, ctx.chatId!, messageId, t(lang, "review.noQuestionsRemain"), { reply_markup: buildEmptyKeyboard(lang) });
          await ctx.reply(t(lang, "upload.expired"));
          break;
        }

        await assertGenerationRateLimit(ctx);
        const regenerated = await generateWithFallback(input);

        if (regenerated.length === 0) {
          throw new Error("AI returned an empty question list");
        }

        ctx.session.draftQuestions = regenerated;
        ctx.session.reviewIndex = 0;
        await safeEditMessageViaApi(ctx.api, ctx.chatId!, messageId, formatQuestionCard(regenerated[0]!, 0, regenerated.length, lang), {
          reply_markup: buildReviewKeyboard(0, regenerated.length, lang)
        });
      } catch (error) {
        logger.error("Review regenerate-all failed", { event: "review.regenerate_all.failed", userId: ctx.from?.id });
        await safeEditMessageViaApi(ctx.api, ctx.chatId!, messageId, t(lang, "review.noQuestionsRemain"), { reply_markup: buildEmptyKeyboard(lang) });
        await ctx.reply(t(lang, "review.regenerateAllFailed"));
      }
      break;
    }
    case REVIEW_START_CALLBACK: {
      if (draftQuestions.length < 1) {
        await ctx.answerCallbackQuery({ text: t(lang, "review.needAtLeastOneToast"), show_alert: false });
        break;
      }

      await ctx.answerCallbackQuery();
      logger.info("Review confirmed", { event: "review.confirmed", userId: ctx.from?.id, finalQuestionCount: draftQuestions.length });
      await saveTestAndTransition(ctx);
      break;
    }
    default: {
      await ctx.answerCallbackQuery();
      break;
    }
  }
};

// ---------------------------------------------------------------------------
// Editing answer sub-state
// ---------------------------------------------------------------------------

const handleEditingAnswer = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const rawAnswer = ctx.msg?.text?.trim();

  if (!rawAnswer) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    await ctx.reply(t(lang, "review.typeValidAnswer"));
    return;
  }

  const questionIndex = ctx.session.reviewEditQuestionIndex ?? ctx.session.reviewIndex ?? 0;
  const draftQuestions = ctx.session.draftQuestions ?? [];
  const question = draftQuestions[questionIndex];

  if (!question) {
    ctx.session.reviewSubState = "idle";
    await ctx.reply(t(lang, "review.questionGone"));
    return;
  }

  if (question.type === "mcq") {
    const normalized = rawAnswer.toUpperCase();
    if (!["A", "B", "C", "D"].includes(normalized)) {
      await ctx.reply(t(lang, "review.mcqAnswerInvalid"));
      return;
    }
    question.correctAnswer = normalized;
  } else if (question.type === "truefalse") {
    const normalized = rawAnswer.toLowerCase();
    if (normalized !== "true" && normalized !== "false") {
      await ctx.reply(t(lang, "review.tfAnswerInvalid"));
      return;
    }
    question.correctAnswer = normalized === "true" ? "True" : "False";
  } else {
    question.correctAnswer = rawAnswer;
  }

  draftQuestions[questionIndex] = question;
  ctx.session.draftQuestions = draftQuestions;
  ctx.session.reviewSubState = "idle";
  ctx.session.reviewEditQuestionIndex = undefined;

  logger.info("Review question edited", { event: "review.question.edited", userId: ctx.from?.id, questionIndex });

  const messageId = ctx.session.reviewMessageId;
  if (messageId) {
    await safeEditMessageViaApi(ctx.api, ctx.chatId!, messageId, formatQuestionCard(question, questionIndex, draftQuestions.length, lang), {
      reply_markup: buildReviewKeyboard(questionIndex, draftQuestions.length, lang)
    });
  }
};

// ---------------------------------------------------------------------------
// Save test and transition to testing
// ---------------------------------------------------------------------------

const getSourceType = (ctx: BotContext): TestSourceType =>
  ctx.session.uploadSourceType ?? "images";

type ResolvedFile = UploadedFile & { base64: string };

const buildGenerateInput = (
  filesWithData: ResolvedFile[],
  questionCount: number,
  questionTypes: QuestionType[]
): GenerateQuestionsInput => {
  const firstFile = filesWithData[0];
  if (!firstFile) throw new ValidationError("No uploaded files are available for generation", "UPLOAD_MISSING");

  if (firstFile.type === "pdf") {
    return { content: { type: "pdf", base64: firstFile.base64 }, questionCount, questionTypes };
  }

  return {
    content: {
      type: "images",
      images: filesWithData.map((file) => ({ base64: file.base64, mimeType: file.mimeType ?? "image/jpeg" }))
    },
    questionCount,
    questionTypes
  };
};

/** Fetches base64 data from Redis for all uploaded files. Returns null if any have expired. */
const resolveFilesFromRedis = async (
  ctx: BotContext,
  uploadedFiles: UploadedFile[]
): Promise<ResolvedFile[] | null> => {
  const base64Entries = await Promise.all(uploadedFiles.map((f) => getUploadData(ctx.redis, f.storageKey)));
  if (base64Entries.some((b) => b === null)) return null;
  return uploadedFiles.map((file, i) => ({ ...file, base64: base64Entries[i]! }));
};

/**
 * Build a GenerateQuestionsInput from the current session.
 * Returns null if the source data has expired (file TTL) — caller should handle gracefully.
 * Throws ValidationError if required session fields are missing.
 */
const buildInputFromSession = async (
  ctx: BotContext,
  questionCount: number,
  questionTypes: QuestionType[]
): Promise<GenerateQuestionsInput | null> => {
  const { uploadSourceType, uploadedText, uploadedFiles } = ctx.session;

  if (uploadSourceType === "text") {
    if (!uploadedText) {
      throw new ValidationError("Text source data is missing from session", "UPLOAD_SESSION_INCOMPLETE");
    }
    return { content: { type: "text", text: uploadedText }, questionCount, questionTypes };
  }

  const files = uploadedFiles ?? [];
  if (files.length === 0) {
    throw new ValidationError("Source files no longer available for regeneration", "UPLOAD_SESSION_INCOMPLETE");
  }
  const filesWithData = await resolveFilesFromRedis(ctx, files);
  if (!filesWithData) return null; // expired
  return buildGenerateInput(filesWithData, questionCount, questionTypes);
};

const saveTestAndTransition = async (ctx: BotContext): Promise<void> => {
  const draftQuestions = ctx.session.draftQuestions ?? [];
  const uploadedFiles = ctx.session.uploadedFiles ?? [];

  if (draftQuestions.length < 1) {
    throw new AppError("You need at least one question before starting a test.", 400);
  }

  const lang = ctx.lang();
  if (!ctx.user) {
    resetSession(ctx.session);
    await ctx.reply(t(lang, "error.session_corrupted"));
    return;
  }

  // Delete upload data from Redis — no longer needed after saving the test.
  await deleteAllUploadData(ctx.redis, uploadedFiles.map((f) => f.storageKey));

  const savedTest = await testRepository.create({
    creatorId: ctx.user._id,
    title: ctx.session.editingTitle ?? t(lang, "test.default_title"),
    questions: draftQuestions,
    sourceType: getSourceType(ctx),
    questionCount: draftQuestions.length,
    shuffleQuestions: ctx.session.shuffleQuestions ?? false,
    shuffleOptions: ctx.session.shuffleOptions ?? false,
    timeLimitSeconds: ctx.session.timeLimitSeconds ?? 0
  });

  ctx.session.activeTestId = String(savedTest._id);
  ctx.session.currentQuestionIndex = 0;
  ctx.session.sessionId = undefined;
  transitionTo(ctx.session, "testing", "saveTestAndTransition");
  ctx.session.testSubState = "answering";
  ctx.session.testCorrectCount = 0;
  ctx.session.reviewMessageId = undefined;
  ctx.session.reviewSubState = "idle";
};
