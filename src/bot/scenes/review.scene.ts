import { Conversation } from "@grammyjs/conversations";
import { InlineKeyboard } from "grammy";
import { getAIProvider } from "../../ai/ai.factory.js";
import { TestRepository } from "../../db/repositories/test.repository.js";
import { AppError } from "../../shared/errors/AppError.js";
import type { GenerateQuestionsInput, Question, QuestionType, TestSourceType } from "../../shared/types/index.js";
import type { BotContext, UploadedFile } from "../types.js";
import { resetSession } from "../types.js";
import { TEST_CONVERSATION_NAME } from "./test.scene.js";

export const REVIEW_CONVERSATION_NAME = "review";

const REVIEW_PREV_CALLBACK = "review:prev";
const REVIEW_NEXT_CALLBACK = "review:next";
const REVIEW_EDIT_CALLBACK = "review:edit";
const REVIEW_REGENERATE_CALLBACK = "review:regenerate";
const REVIEW_DELETE_CALLBACK = "review:delete";
const REVIEW_START_CALLBACK = "review:start";
const REVIEW_REGENERATE_ALL_CALLBACK = "review:regenerate-all";

const testRepository = new TestRepository();

const isCancelMessage = (ctx: BotContext): boolean => ctx.msg?.text?.trim() === "/cancel";

const buildGenerateInput = (
  uploadedFiles: UploadedFile[],
  questionCount: number,
  questionTypes: QuestionType[]
): GenerateQuestionsInput => {
  const firstFile = uploadedFiles[0];

  if (!firstFile) {
    throw new AppError("No uploaded files are available for generation", 400);
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
      base64Array: uploadedFiles.map((file) => file.base64 ?? "")
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
    throw new AppError("Missing uploaded files for this review session", 400);
  }

  return firstFile.type === "pdf" ? "pdf" : "images";
};

const waitForReviewUpdate = async (conversation: Conversation<BotContext, BotContext>): Promise<BotContext> => {
  const ctx = await conversation.wait();

  if (isCancelMessage(ctx)) {
    resetSession(ctx.session);
    await ctx.reply("Your current flow has been cancelled and your session is back to idle.");
    throw new Error("conversation_cancelled");
  }

  return ctx;
};

const generateSingleQuestion = async (
  conversation: Conversation<BotContext, BotContext>,
  uploadedFiles: UploadedFile[],
  question: Question
): Promise<Question> => {
  const input = buildGenerateInput(uploadedFiles, 1, [question.type]);
  const generated = await conversation.external(async () => getAIProvider().generateQuestions(input));
  const nextQuestion = generated[0];

  if (!nextQuestion) {
    throw new AppError("AI did not return a replacement question", 502);
  }

  return nextQuestion;
};

const regenerateAllQuestions = async (conversation: Conversation<BotContext, BotContext>, ctx: BotContext): Promise<Question[]> => {
  const uploadedFiles = ctx.session.uploadedFiles ?? [];
  const questionCount = ctx.session.questionCount;
  const questionTypes = ctx.session.questionTypes;

  if (!questionCount || !questionTypes?.length || uploadedFiles.length === 0) {
    throw new AppError("Missing data required to regenerate questions", 400);
  }

  const input = buildGenerateInput(uploadedFiles, questionCount, questionTypes);
  return conversation.external(async () => getAIProvider().generateQuestions(input));
};

const promptForEditedAnswer = async (
  conversation: Conversation<BotContext, BotContext>,
  ctx: BotContext,
  question: Question
): Promise<string> => {
  const hint =
    question.type === "mcq"
      ? "Type the new correct answer (A, B, C, or D)."
      : question.type === "truefalse"
        ? "Type the new correct answer: True or False."
        : "Type the new correct answer.";

  await ctx.reply(hint);

  while (true) {
    const nextCtx = await waitForReviewUpdate(conversation);
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
  const draftQuestions = ctx.session.draftQuestions ?? [];
  const uploadedFiles = ctx.session.uploadedFiles ?? [];

  if (!ctx.user) {
    throw new AppError("User record is missing from context", 500);
  }

  if (draftQuestions.length < 1) {
    throw new AppError("You need at least one question before starting a test.", 400);
  }

  const savedTest = await conversation.external(async () =>
    testRepository.create({
      creatorId: ctx.user!._id,
      questions: draftQuestions,
      sourceType: getSourceType(uploadedFiles),
      questionCount: draftQuestions.length
    })
  );

  ctx.session.activeTestId = String(savedTest._id);
  ctx.session.currentQuestionIndex = 0;
  ctx.session.state = "testing";

  await ctx.conversation.enter(TEST_CONVERSATION_NAME);
};

export const reviewScene = async (conversation: Conversation<BotContext, BotContext>, ctx: BotContext): Promise<void> => {
  try {
    ctx.session.state = "reviewing";
    ctx.session.reviewIndex = ctx.session.reviewIndex ?? 0;

    const initialQuestions = ctx.session.draftQuestions ?? [];
    if (initialQuestions.length === 0) {
      await ctx.reply("There are no draft questions to review.");
      return;
    }

    let messageId = (
      await ctx.reply(
        formatQuestionCard(initialQuestions[ctx.session.reviewIndex]!, ctx.session.reviewIndex, initialQuestions.length),
        {
          reply_markup: buildReviewKeyboard(ctx.session.reviewIndex, initialQuestions.length)
        }
      )
    ).message_id;

    while (true) {
      const nextCtx = await waitForReviewUpdate(conversation);
      const data = nextCtx.callbackQuery?.data;

      if (!data) {
        await nextCtx.reply("Use the review buttons below the question card to continue.");
        continue;
      }

      if (data === "review:noop") {
        await nextCtx.answerCallbackQuery();
        continue;
      }

      const draftQuestions = ctx.session.draftQuestions ?? [];
      if (draftQuestions.length === 0) {
        if (data !== REVIEW_REGENERATE_ALL_CALLBACK) {
          await nextCtx.answerCallbackQuery({ text: "No questions remain. Regenerate all to continue.", show_alert: false });
          continue;
        }
      }

      switch (data) {
        case REVIEW_PREV_CALLBACK: {
          await nextCtx.answerCallbackQuery();
          if (draftQuestions.length > 0) {
            ctx.session.reviewIndex = ctx.session.reviewIndex === 0 ? draftQuestions.length - 1 : ctx.session.reviewIndex! - 1;
            await updateReviewMessage(
              nextCtx,
              messageId,
              draftQuestions[ctx.session.reviewIndex]!,
              ctx.session.reviewIndex,
              draftQuestions.length
            );
          }
          break;
        }
        case REVIEW_NEXT_CALLBACK: {
          await nextCtx.answerCallbackQuery();
          if (draftQuestions.length > 0) {
            ctx.session.reviewIndex = (ctx.session.reviewIndex! + 1) % draftQuestions.length;
            await updateReviewMessage(
              nextCtx,
              messageId,
              draftQuestions[ctx.session.reviewIndex]!,
              ctx.session.reviewIndex,
              draftQuestions.length
            );
          }
          break;
        }
        case REVIEW_EDIT_CALLBACK: {
          await nextCtx.answerCallbackQuery();
          const currentQuestion = draftQuestions[ctx.session.reviewIndex ?? 0];
          if (!currentQuestion) {
            await nextCtx.reply("There is no question to edit right now.");
            break;
          }

          const newAnswer = await promptForEditedAnswer(conversation, nextCtx, currentQuestion);
          currentQuestion.correctAnswer = newAnswer;
          await updateReviewMessage(nextCtx, messageId, currentQuestion, ctx.session.reviewIndex ?? 0, draftQuestions.length);
          break;
        }
        case REVIEW_REGENERATE_CALLBACK: {
          const currentIndex = ctx.session.reviewIndex ?? 0;
          const currentQuestion = draftQuestions[currentIndex];
          if (!currentQuestion) {
            await nextCtx.answerCallbackQuery({ text: "There is no question to regenerate.", show_alert: false });
            break;
          }

          await nextCtx.api.editMessageText(nextCtx.chatId!, messageId, "Regenerating... 🔄");

          try {
            const replacement = await generateSingleQuestion(conversation, ctx.session.uploadedFiles ?? [], currentQuestion);
            draftQuestions[currentIndex] = replacement;
            ctx.session.draftQuestions = draftQuestions;
            await updateReviewMessage(nextCtx, messageId, replacement, currentIndex, draftQuestions.length);
            await nextCtx.answerCallbackQuery();
          } catch (error) {
            console.error("[review] Failed to regenerate question", error);
            await updateReviewMessage(nextCtx, messageId, currentQuestion, currentIndex, draftQuestions.length);
            await nextCtx.answerCallbackQuery({ text: "Regeneration failed. Keeping the original question.", show_alert: false });
          }
          break;
        }
        case REVIEW_DELETE_CALLBACK: {
          await nextCtx.answerCallbackQuery();
          draftQuestions.splice(ctx.session.reviewIndex ?? 0, 1);
          ctx.session.draftQuestions = draftQuestions;

          if (draftQuestions.length === 0) {
            ctx.session.reviewIndex = 0;
            await updateEmptyMessage(nextCtx, messageId);
            break;
          }

          ctx.session.reviewIndex = Math.min(ctx.session.reviewIndex ?? 0, draftQuestions.length - 1);
          await updateReviewMessage(
            nextCtx,
            messageId,
            draftQuestions[ctx.session.reviewIndex]!,
            ctx.session.reviewIndex,
            draftQuestions.length
          );
          break;
        }
        case REVIEW_REGENERATE_ALL_CALLBACK: {
          await nextCtx.answerCallbackQuery();
          await nextCtx.api.editMessageText(nextCtx.chatId!, messageId, "Regenerating... 🔄");

          try {
            const regenerated = await regenerateAllQuestions(conversation, ctx);
            ctx.session.draftQuestions = regenerated;
            ctx.session.reviewIndex = 0;
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
          await saveTestAndTransition(conversation, nextCtx);
          return;
        }
        default: {
          await nextCtx.answerCallbackQuery();
          break;
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "conversation_cancelled") {
      return;
    }

    throw error;
  }
};
