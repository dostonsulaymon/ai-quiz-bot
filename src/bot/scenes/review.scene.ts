import { Conversation } from "@grammyjs/conversations";
import { InlineKeyboard } from "grammy";
import { getAIProvider } from "../../ai/ai.factory.js";
import { TestRepository } from "../../db/repositories/test.repository.js";
import { UserRepository } from "../../db/repositories/user.repository.js";
import { AppError } from "../../shared/errors/AppError.js";
import { logger } from "../../shared/logger.js";
import { ValidationError } from "../../shared/errors/ValidationError.js";
import type { GenerateQuestionsInput, Question, QuestionType, TestSourceType } from "../../shared/types/index.js";
import type { BotContext, UploadedFile } from "../types.js";
import { resetSession } from "../types.js";
import { assertGenerationRateLimit } from "../middlewares/rateLimitMiddleware.js";

export const REVIEW_CONVERSATION_NAME = "review";

const REVIEW_PREV_CALLBACK = "review:prev";
const REVIEW_NEXT_CALLBACK = "review:next";
const REVIEW_EDIT_CALLBACK = "review:edit";
const REVIEW_REGENERATE_CALLBACK = "review:regenerate";
const REVIEW_DELETE_CALLBACK = "review:delete";
const REVIEW_START_CALLBACK = "review:start";
const REVIEW_REGENERATE_ALL_CALLBACK = "review:regenerate-all";
const CANCELLED = Symbol("review-cancelled");

const testRepository = new TestRepository();
const userRepository = new UserRepository();

const isCancelMessage = (ctx: BotContext): boolean => ctx.msg?.text?.trim() === "/cancel";

const buildGenerateInput = (
  uploadedFiles: UploadedFile[],
  questionCount: number,
  questionTypes: QuestionType[]
): GenerateQuestionsInput => {
  const firstFile = uploadedFiles[0];

  if (!firstFile) {
    throw new ValidationError("No uploaded files are available for generation", "UPLOAD_MISSING");
  }

  if (firstFile.type === "pdf") {
    return {
      content: {
        type: "pdf",
        base64: firstFile.base64 ?? ""
      },
      questionCount,
      questionTypes
    };
  }

  return {
    content: {
      type: "images",
      images: uploadedFiles.map((file) => ({
        base64: file.base64 ?? "",
        mimeType: file.mimeType ?? "image/jpeg"
      }))
    },
    questionCount,
    questionTypes
  };
};

const formatQuestionCard = (question: Question, index: number, total: number): string => {
  const lines = [`Question ${index + 1} of ${total}`, "", question.question];

  if (question.type === "mcq" && question.options) {
    lines.push("");
    lines.push(`A. ${question.options.A}`);
    lines.push(`B. ${question.options.B}`);
    lines.push(`C. ${question.options.C}`);
    lines.push(`D. ${question.options.D}`);
    lines.push("");
    lines.push(`✅ Answer: ${question.correctAnswer}`);
  } else if (question.type === "truefalse") {
    lines.push("");
    lines.push(`✅ Answer: ${question.correctAnswer}`);
  } else {
    lines.push("");
    lines.push(`✅ Answer: ${question.correctAnswer}`);
  }

  if (question.explanation) {
    lines.push("");
    lines.push(`Explanation: ${question.explanation}`);
  }

  return lines.join("\n");
};

const buildReviewKeyboard = (index: number, total: number): InlineKeyboard =>
  new InlineKeyboard()
    .text("◀ Prev", REVIEW_PREV_CALLBACK)
    .text(`${index + 1} / ${total}`, "review:noop")
    .text("Next ▶", REVIEW_NEXT_CALLBACK)
    .row()
    .text("✏️ Edit answer", REVIEW_EDIT_CALLBACK)
    .text("🔄 Regenerate", REVIEW_REGENERATE_CALLBACK)
    .text("🗑️ Delete", REVIEW_DELETE_CALLBACK)
    .row()
    .text(`✅ Start Test (${total} questions)`, REVIEW_START_CALLBACK);

const buildEmptyKeyboard = (): InlineKeyboard =>
  new InlineKeyboard().text("🔄 Regenerate all", REVIEW_REGENERATE_ALL_CALLBACK);

const updateReviewMessage = async (
  ctx: BotContext,
  messageId: number,
  question: Question,
  index: number,
  total: number
): Promise<void> => {
  await ctx.api.editMessageText(ctx.chatId!, messageId, formatQuestionCard(question, index, total), {
    reply_markup: buildReviewKeyboard(index, total)
  });
};

const updateEmptyMessage = async (ctx: BotContext, messageId: number): Promise<void> => {
  await ctx.api.editMessageText(
    ctx.chatId!,
    messageId,
    "No questions remain.\nTap Regenerate all to create a fresh set from your uploaded material.",
    { reply_markup: buildEmptyKeyboard() }
  );
};

const getSourceType = (uploadedFiles: UploadedFile[]): TestSourceType => {
  const firstFile = uploadedFiles[0];
  if (!firstFile) {
    throw new ValidationError("Missing uploaded files for this review session", "UPLOAD_MISSING");
  }

  return firstFile.type === "pdf" ? "pdf" : "images";
};

const waitForReviewUpdate = async (
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

const generateSingleQuestion = async (
  conversation: Conversation<BotContext, BotContext>,
  ctx: BotContext,
  uploadedFiles: UploadedFile[],
  question: Question
): Promise<Question> => {
  const input = buildGenerateInput(uploadedFiles, 1, [question.type]);
  // Rule 3: Redis-backed rate limiting must run outside replay.
  await conversation.external((ctx) => assertGenerationRateLimit(ctx));
  const generated = await conversation.external(async () => getAIProvider().generateQuestions(input));
  const nextQuestion = generated[0];

  if (!nextQuestion) {
    throw new AppError("AI did not return a replacement question", 502);
  }

  return nextQuestion;
};

const regenerateAllQuestions = async (conversation: Conversation<BotContext, BotContext>, ctx: BotContext): Promise<Question[]> => {
  const { uploadedFiles, questionCount, questionTypes } = await conversation.external((ctx) => ({
    // Rule 1: session reads in conversations must go through external.
    uploadedFiles: ctx.session.uploadedFiles ?? [],
    questionCount: ctx.session.questionCount,
    questionTypes: ctx.session.questionTypes
  }));

  if (!questionCount || !questionTypes?.length || uploadedFiles.length === 0) {
    throw new ValidationError("Missing data required to regenerate questions", "UPLOAD_SESSION_INCOMPLETE");
  }

  const input = buildGenerateInput(uploadedFiles, questionCount, questionTypes);
  // Rule 3: Redis-backed rate limiting must run outside replay.
  await conversation.external((ctx) => assertGenerationRateLimit(ctx));
  return conversation.external(async () => getAIProvider().generateQuestions(input));
};

const promptForEditedAnswer = async (
  conversation: Conversation<BotContext, BotContext>,
  ctx: BotContext,
  question: Question
): Promise<string | typeof CANCELLED> => {
  const hint =
    question.type === "mcq"
      ? "Type the new correct answer (A, B, C, or D)."
      : question.type === "truefalse"
        ? "Type the new correct answer: True or False."
        : "Type the new correct answer.";

  await ctx.reply(hint);

  while (true) {
    const nextCtx = await waitForReviewUpdate(conversation);
    if (nextCtx === CANCELLED) {
      return CANCELLED;
    }
    const rawAnswer = nextCtx.msg?.text?.trim();

    if (!rawAnswer) {
      await nextCtx.reply("Please type a valid answer.");
      continue;
    }

    if (question.type === "mcq") {
      const normalized = rawAnswer.toUpperCase();
      if (!["A", "B", "C", "D"].includes(normalized)) {
        await nextCtx.reply("For multiple choice questions, the answer must be A, B, C, or D.");
        continue;
      }

      return normalized;
    }

    if (question.type === "truefalse") {
      const normalized = rawAnswer.toLowerCase();
      if (normalized !== "true" && normalized !== "false") {
        await nextCtx.reply("For true/false questions, please type True or False.");
        continue;
      }

      return normalized === "true" ? "True" : "False";
    }

    return rawAnswer;
  }
};

const saveTestAndTransition = async (conversation: Conversation<BotContext, BotContext>, ctx: BotContext): Promise<void> => {
  const { draftQuestions, uploadedFiles } = await conversation.external((ctx) => ({
    // Rule 1: session reads in conversations must go through external.
    draftQuestions: ctx.session.draftQuestions ?? [],
    uploadedFiles: ctx.session.uploadedFiles ?? []
  }));

  if (draftQuestions.length < 1) {
    throw new AppError("You need at least one question before starting a test.", 400);
  }

  const user = await conversation.external(async () => {
    if (!ctx.from?.id) {
      throw new AppError("User record is missing from context", 500);
    }

    return userRepository.findOrCreate(ctx.from.id);
  });

  const savedTest = await conversation.external(async () =>
    testRepository.create({
      creatorId: user._id,
      questions: draftQuestions,
      sourceType: getSourceType(uploadedFiles),
      questionCount: draftQuestions.length
    })
  );

  await conversation.external((ctx) => {
    // Rule 1: transition state must be persisted outside replay.
    ctx.session.activeTestId = String(savedTest._id);
    ctx.session.currentQuestionIndex = 0;
    ctx.session.state = "testing";
  });
};

export const reviewScene = async (conversation: Conversation<BotContext, BotContext>, ctx: BotContext): Promise<void> => {
  await conversation.external((ctx) => {
    // Rule 1: session writes in conversations must go through external.
    ctx.session.state = "reviewing";
    ctx.session.reviewIndex = ctx.session.reviewIndex ?? 0;
  });

  const initialState = await conversation.external((ctx) => ({
    draftQuestions: ctx.session.draftQuestions ?? [],
    reviewIndex: ctx.session.reviewIndex ?? 0
  }));

  if (initialState.draftQuestions.length === 0) {
    await ctx.reply("There are no draft questions to review.");
    return;
  }
  logger.info("Review scene entered", {
    event: "review.scene.enter",
    userId: ctx.from?.id,
    totalQuestions: initialState.draftQuestions.length
  });

  let messageId = (
    await ctx.reply(
      formatQuestionCard(
        initialState.draftQuestions[initialState.reviewIndex]!,
        initialState.reviewIndex,
        initialState.draftQuestions.length
      ),
      {
        reply_markup: buildReviewKeyboard(initialState.reviewIndex, initialState.draftQuestions.length)
      }
    )
  ).message_id;

  while (true) {
      const nextCtx = await waitForReviewUpdate(conversation);
      if (nextCtx === CANCELLED) {
        return;
      }
      const data = nextCtx.callbackQuery?.data;

      if (!data) {
        await nextCtx.reply("Use the review buttons below the question card to continue.");
        continue;
      }

      if (data === "review:noop") {
        await nextCtx.answerCallbackQuery();
        continue;
      }

      const { draftQuestions, reviewIndex, uploadedFiles } = await conversation.external((ctx) => ({
        // Rule 1: session reads in conversations must go through external.
        draftQuestions: ctx.session.draftQuestions ?? [],
        reviewIndex: ctx.session.reviewIndex ?? 0,
        uploadedFiles: ctx.session.uploadedFiles ?? []
      }));
      if (draftQuestions.length === 0) {
        if (data !== REVIEW_REGENERATE_ALL_CALLBACK) {
          await nextCtx.answerCallbackQuery({ text: "No questions remain. Regenerate all to continue.", show_alert: false });
          continue;
        }
      }

      switch (data) {
        case REVIEW_PREV_CALLBACK: {
          await nextCtx.answerCallbackQuery();
          logger.info("Review question kept", {
            event: "review.question.kept",
            userId: nextCtx.from?.id,
            questionIndex: reviewIndex
          });
          if (draftQuestions.length > 0) {
            const nextIndex = reviewIndex === 0 ? draftQuestions.length - 1 : reviewIndex - 1;
            await conversation.external((ctx) => {
              // Rule 1: session writes in conversations must go through external.
              ctx.session.reviewIndex = nextIndex;
            });
            await updateReviewMessage(
              nextCtx,
              messageId,
              draftQuestions[nextIndex]!,
              nextIndex,
              draftQuestions.length
            );
          }
          break;
        }
        case REVIEW_NEXT_CALLBACK: {
          await nextCtx.answerCallbackQuery();
          logger.info("Review question kept", {
            event: "review.question.kept",
            userId: nextCtx.from?.id,
            questionIndex: reviewIndex
          });
          if (draftQuestions.length > 0) {
            const nextIndex = (reviewIndex + 1) % draftQuestions.length;
            await conversation.external((ctx) => {
              // Rule 1: session writes in conversations must go through external.
              ctx.session.reviewIndex = nextIndex;
            });
            await updateReviewMessage(
              nextCtx,
              messageId,
              draftQuestions[nextIndex]!,
              nextIndex,
              draftQuestions.length
            );
          }
          break;
        }
        case REVIEW_EDIT_CALLBACK: {
          await nextCtx.answerCallbackQuery();
          const currentQuestion = draftQuestions[reviewIndex];
          if (!currentQuestion) {
            await nextCtx.reply("There is no question to edit right now.");
            break;
          }

          const newAnswer = await promptForEditedAnswer(conversation, nextCtx, currentQuestion);
          if (newAnswer === CANCELLED) {
            return;
          }
          currentQuestion.correctAnswer = newAnswer;
          logger.info("Review question edited", {
            event: "review.question.edited",
            userId: nextCtx.from?.id,
            questionIndex: reviewIndex
          });
          await conversation.external((ctx) => {
            // Rule 1: session writes in conversations must go through external.
            ctx.session.draftQuestions = draftQuestions;
          });
          await updateReviewMessage(nextCtx, messageId, currentQuestion, reviewIndex, draftQuestions.length);
          break;
        }
        case REVIEW_REGENERATE_CALLBACK: {
          const currentIndex = reviewIndex;
          const currentQuestion = draftQuestions[currentIndex];
          if (!currentQuestion) {
            await nextCtx.answerCallbackQuery({ text: "There is no question to regenerate.", show_alert: false });
            break;
          }

          logger.info("Review question regeneration started", {
            event: "review.question.regenerate.start",
            userId: nextCtx.from?.id,
            questionIndex: currentIndex
          });
          await nextCtx.api.editMessageText(nextCtx.chatId!, messageId, "Regenerating... 🔄");

          try {
            const replacement = await generateSingleQuestion(
              conversation,
              nextCtx,
              uploadedFiles,
              currentQuestion
            );
            draftQuestions[currentIndex] = replacement;
            await conversation.external((ctx) => {
              // Rule 1: session writes in conversations must go through external.
              ctx.session.draftQuestions = draftQuestions;
            });
            logger.info("Review question regeneration succeeded", {
              event: "review.question.regenerate.success",
              userId: nextCtx.from?.id,
              questionIndex: currentIndex
            });
            await updateReviewMessage(nextCtx, messageId, replacement, currentIndex, draftQuestions.length);
            await nextCtx.answerCallbackQuery();
          } catch (error) {
            console.error("[review] Failed to regenerate question", error);
            logger.error("Review question regeneration failed", {
              event: "review.question.regenerate.failed",
              userId: nextCtx.from?.id,
              questionIndex: currentIndex
            });
            await updateReviewMessage(nextCtx, messageId, currentQuestion, currentIndex, draftQuestions.length);
            await nextCtx.answerCallbackQuery({ text: "Regeneration failed. Keeping the original question.", show_alert: false });
          }
          break;
        }
        case REVIEW_DELETE_CALLBACK: {
          await nextCtx.answerCallbackQuery();
          draftQuestions.splice(reviewIndex, 1);
          await conversation.external((ctx) => {
            // Rule 1: session writes in conversations must go through external.
            ctx.session.draftQuestions = draftQuestions;
          });
          logger.info("Review question deleted", {
            event: "review.question.deleted",
            userId: nextCtx.from?.id,
            questionIndex: reviewIndex,
            remaining: draftQuestions.length
          });

          if (draftQuestions.length === 0) {
            await conversation.external((ctx) => {
              // Rule 1: session writes in conversations must go through external.
              ctx.session.reviewIndex = 0;
            });
            await updateEmptyMessage(nextCtx, messageId);
            break;
          }

          const nextIndex = Math.min(reviewIndex, draftQuestions.length - 1);
          await conversation.external((ctx) => {
            // Rule 1: session writes in conversations must go through external.
            ctx.session.reviewIndex = nextIndex;
          });
          await updateReviewMessage(
            nextCtx,
            messageId,
            draftQuestions[nextIndex]!,
            nextIndex,
            draftQuestions.length
          );
          break;
        }
        case REVIEW_REGENERATE_ALL_CALLBACK: {
          await nextCtx.answerCallbackQuery();
          await nextCtx.api.editMessageText(nextCtx.chatId!, messageId, "Regenerating... 🔄");

          try {
            const regenerated = await regenerateAllQuestions(conversation, ctx);
            if (regenerated.length === 0) {
              // AI returned an empty array — treat as a failure so the user can retry.
              throw new Error("AI returned an empty question list");
            }

            await conversation.external((ctx) => {
              // Rule 1: session writes in conversations must go through external.
              ctx.session.draftQuestions = regenerated;
              ctx.session.reviewIndex = 0;
            });
            await updateReviewMessage(nextCtx, messageId, regenerated[0]!, 0, regenerated.length);
          } catch (error) {
            console.error("[review] Failed to regenerate all questions", error);
            await updateEmptyMessage(nextCtx, messageId);
            await nextCtx.reply("I couldn’t regenerate the full set right now. Please try again.");
          }
          break;
        }
        case REVIEW_START_CALLBACK: {
          if (draftQuestions.length < 1) {
            await nextCtx.answerCallbackQuery({ text: "You need at least one question before starting.", show_alert: false });
            break;
          }

          await nextCtx.answerCallbackQuery();
          logger.info("Review scene confirmed", {
            event: "review.scene.confirmed",
            userId: nextCtx.from?.id,
            finalQuestionCount: draftQuestions.length
          });
          await saveTestAndTransition(conversation, nextCtx);
          return;
        }
        default: {
          await nextCtx.answerCallbackQuery();
          break;
        }
      }
    }
};
