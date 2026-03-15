import { Conversation } from "@grammyjs/conversations";
import { InlineKeyboard } from "grammy";
import { getAIProvider } from "../../ai/ai.factory.js";
import { config } from "../../config/index.js";
import { AppError } from "../../shared/errors/AppError.js";
import { DEFAULT_QUESTION_TYPES, type GenerateQuestionsInput, type Question, type QuestionType } from "../../shared/types/index.js";
import { REVIEW_CONVERSATION_NAME } from "./review.scene.js";
import { resetSession, type BotContext, type UploadedFile } from "../types.js";

export const UPLOAD_CONVERSATION_NAME = "upload";

const DONE_ADDING_IMAGES_CALLBACK = "upload:images:done";
const RETRY_GENERATION_CALLBACK = "upload:generation:retry";
const QUESTION_COUNT_CALLBACK_PREFIX = "upload:count:";
const QUESTION_TYPES_CALLBACK_PREFIX = "upload:types:";
const QUESTION_TYPES_CONFIRM_CALLBACK = "upload:types:confirm";
const MAX_IMAGES = 10;
const MAX_CUSTOM_QUESTION_COUNT = 50;
const DEFAULT_MAX_FILE_SIZE_MB = 20;

const questionTypeLabels: Record<QuestionType, string> = {
  mcq: "Multiple Choice",
  truefalse: "True / False",
  short: "Short Answer",
  fill: "Fill in the Blank"
};

const isCancelMessage = (ctx: BotContext): boolean => ctx.msg?.text?.trim() === "/cancel";

const isPhotoMessage = (ctx: BotContext): boolean => Boolean(ctx.msg?.photo?.length);

const isDocumentMessage = (ctx: BotContext): boolean => Boolean(ctx.msg?.document);

const getFileSizeLimitBytes = (): number => (config.MAX_FILE_SIZE_MB ?? DEFAULT_MAX_FILE_SIZE_MB) * 1024 * 1024;

const buildQuestionCountKeyboard = (): InlineKeyboard =>
  new InlineKeyboard()
    .text("5", `${QUESTION_COUNT_CALLBACK_PREFIX}5`)
    .text("10", `${QUESTION_COUNT_CALLBACK_PREFIX}10`)
    .text("15", `${QUESTION_COUNT_CALLBACK_PREFIX}15`)
    .text("20", `${QUESTION_COUNT_CALLBACK_PREFIX}20`)
    .row()
    .text("Custom", `${QUESTION_COUNT_CALLBACK_PREFIX}custom`);

const buildQuestionTypesKeyboard = (selectedTypes: QuestionType[]): InlineKeyboard => {
  const selected = new Set(selectedTypes);
  const toggleLabel = (type: QuestionType): string =>
    `${selected.has(type) ? "[x]" : "[ ]"} ${questionTypeLabels[type]}`;

  return new InlineKeyboard()
    .text(toggleLabel("mcq"), `${QUESTION_TYPES_CALLBACK_PREFIX}mcq`)
    .text(toggleLabel("truefalse"), `${QUESTION_TYPES_CALLBACK_PREFIX}truefalse`)
    .row()
    .text(toggleLabel("short"), `${QUESTION_TYPES_CALLBACK_PREFIX}short`)
    .text(toggleLabel("fill"), `${QUESTION_TYPES_CALLBACK_PREFIX}fill`)
    .row()
    .text("[Confirm selection]", QUESTION_TYPES_CONFIRM_CALLBACK);
};

const buildDoneAddingImagesKeyboard = (): InlineKeyboard =>
  new InlineKeyboard().text("Done adding images ✅", DONE_ADDING_IMAGES_CALLBACK);

const buildRetryKeyboard = (): InlineKeyboard =>
  new InlineKeyboard().text("Retry generation", RETRY_GENERATION_CALLBACK);

const getTelegramFileBuffer = async (ctx: BotContext, fileId: string): Promise<Buffer> => {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) {
    throw new AppError("Telegram did not return a downloadable file path", 502);
  }

  const response = await fetch(`https://api.telegram.org/file/bot${config.BOT_TOKEN}/${file.file_path}`);
  if (!response.ok) {
    throw new AppError("Failed to download file from Telegram", response.status);
  }

  return Buffer.from(await response.arrayBuffer());
};

const validateFileSize = (fileSize: number | undefined): void => {
  if (fileSize !== undefined && fileSize > getFileSizeLimitBytes()) {
    throw new AppError(
      `That file is too large. Please keep files under ${config.MAX_FILE_SIZE_MB ?? DEFAULT_MAX_FILE_SIZE_MB} MB.`,
      400
    );
  }
};

const handleCancel = async (conversation: Conversation<BotContext, BotContext>, ctx: BotContext): Promise<never> => {
  resetSession(ctx.session);
  await ctx.reply("Your current flow has been cancelled and your session is back to idle.");
  throw new Error("conversation_cancelled");
};

const waitForUpdate = async (conversation: Conversation<BotContext, BotContext>): Promise<BotContext> => {
  const ctx = await conversation.wait();

  if (isCancelMessage(ctx)) {
    await handleCancel(conversation, ctx);
  }

  return ctx;
};

const collectPdfUpload = async (
  conversation: Conversation<BotContext, BotContext>,
  ctx: BotContext
): Promise<UploadedFile[]> => {
  const document = ctx.msg?.document;
  if (!document) {
    throw new AppError("No document found in the message", 400);
  }

  if (document.mime_type !== "application/pdf") {
    throw new AppError("That document is not a PDF. Please send a PDF or photos instead.", 400);
  }

  validateFileSize(document.file_size);
  await ctx.reply("Processing your file... ⏳");

  const base64 = await conversation.external(async () => {
    const buffer = await getTelegramFileBuffer(ctx, document.file_id);
    return buffer.toString("base64");
  });

  return [{ type: "pdf", fileId: document.file_id, base64 }];
};

const collectImageUploads = async (
  conversation: Conversation<BotContext, BotContext>,
  initialCtx: BotContext
): Promise<UploadedFile[]> => {
  const uploadedFiles: UploadedFile[] = [];
  let currentCtx: BotContext | null = initialCtx;

  while (uploadedFiles.length < MAX_IMAGES) {
    if (currentCtx && isPhotoMessage(currentCtx)) {
      const message = currentCtx.msg;
      const photo = message?.photo?.at(-1);
      if (!photo) {
        throw new AppError("No photo found in the message", 400);
      }

      validateFileSize(photo.file_size);
      await currentCtx.reply("Processing your file... ⏳");

      const activeCtx = currentCtx;
      const base64 = await conversation.external(async () => {
        const buffer = await getTelegramFileBuffer(activeCtx, photo.file_id);
        return buffer.toString("base64");
      });

      uploadedFiles.push({ type: "image", fileId: photo.file_id, base64 });

      if (uploadedFiles.length === 1) {
        await currentCtx.reply(
          "Image 1 added. Send more images one by one, or tap the button when you're done.",
          { reply_markup: buildDoneAddingImagesKeyboard() }
        );
      } else if (uploadedFiles.length < MAX_IMAGES) {
        await currentCtx.reply(`Image ${uploadedFiles.length} added. Send another image or tap Done adding images ✅.`);
      }
    }

    if (uploadedFiles.length >= MAX_IMAGES) {
      await currentCtx?.reply(`You reached the ${MAX_IMAGES}-image limit. I’ll use these images.`);
      break;
    }

    currentCtx = await waitForUpdate(conversation);

    if (currentCtx.callbackQuery?.data === DONE_ADDING_IMAGES_CALLBACK) {
      await currentCtx.answerCallbackQuery();
      break;
    }

    if (isDocumentMessage(currentCtx)) {
      await currentCtx.reply("You already started with images. Please keep sending images or tap Done adding images ✅.");
      currentCtx = null;
      continue;
    }

    if (!isPhotoMessage(currentCtx)) {
      await currentCtx.reply("Please send another photo, or tap Done adding images ✅ when you’re finished.");
      currentCtx = null;
    }
  }

  return uploadedFiles;
};

const askForUpload = async (
  conversation: Conversation<BotContext, BotContext>,
  ctx: BotContext
): Promise<UploadedFile[]> => {
  ctx.session.state = "uploading";
  ctx.session.uploadedFiles = undefined;

  await ctx.reply("Send me a PDF or one/more images of your study material");

  while (true) {
    const nextCtx = await waitForUpdate(conversation);

    if (isDocumentMessage(nextCtx)) {
      return collectPdfUpload(conversation, nextCtx);
    }

    if (isPhotoMessage(nextCtx)) {
      return collectImageUploads(conversation, nextCtx);
    }

    await nextCtx.reply("Please send a PDF document or one/more images to continue.");
  }
};

const askForQuestionCount = async (
  conversation: Conversation<BotContext, BotContext>,
  ctx: BotContext
): Promise<number> => {
  ctx.session.state = "configuring";

  await ctx.reply("How many questions should I generate?", {
    reply_markup: buildQuestionCountKeyboard()
  });

  while (true) {
    const nextCtx = await waitForUpdate(conversation);
    const callbackData = nextCtx.callbackQuery?.data;

    if (!callbackData?.startsWith(QUESTION_COUNT_CALLBACK_PREFIX)) {
      await nextCtx.reply("Use the buttons to choose a question count.");
      continue;
    }

    await nextCtx.answerCallbackQuery();

    const value = callbackData.slice(QUESTION_COUNT_CALLBACK_PREFIX.length);
    if (value !== "custom") {
      const count = Number(value);
      return count;
    }

    await nextCtx.reply("Type the number of questions you want (1-50).");

    while (true) {
      const customCtx = await waitForUpdate(conversation);
      const rawValue = customCtx.msg?.text?.trim();

      if (!rawValue) {
        await customCtx.reply("Please type a number between 1 and 50.");
        continue;
      }

      const parsed = Number(rawValue);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CUSTOM_QUESTION_COUNT) {
        await customCtx.reply("That number is out of range. Please enter a whole number from 1 to 50.");
        continue;
      }

      return parsed;
    }
  }
};

const askForQuestionTypes = async (
  conversation: Conversation<BotContext, BotContext>,
  ctx: BotContext
): Promise<QuestionType[]> => {
  const selectedTypes = new Set<QuestionType>(ctx.user?.defaultQuestionTypes ?? DEFAULT_QUESTION_TYPES);
  const promptText = "Which question types?";

  const message = await ctx.reply(promptText, {
    reply_markup: buildQuestionTypesKeyboard([...selectedTypes])
  });

  while (true) {
    const nextCtx = await waitForUpdate(conversation);
    const callbackData = nextCtx.callbackQuery?.data;

    if (!callbackData?.startsWith(QUESTION_TYPES_CALLBACK_PREFIX) && callbackData !== QUESTION_TYPES_CONFIRM_CALLBACK) {
      await nextCtx.reply("Use the buttons to choose one or more question types, then confirm.");
      continue;
    }

    await nextCtx.answerCallbackQuery();

    if (callbackData === QUESTION_TYPES_CONFIRM_CALLBACK) {
      if (selectedTypes.size === 0) {
        await nextCtx.reply("Please select at least one question type before confirming.");
        continue;
      }

      return [...selectedTypes];
    }

    const type = callbackData.slice(QUESTION_TYPES_CALLBACK_PREFIX.length) as QuestionType;
    if (selectedTypes.has(type)) {
      selectedTypes.delete(type);
    } else {
      selectedTypes.add(type);
    }

    await nextCtx.api.editMessageReplyMarkup(nextCtx.chatId!, message.message_id, {
      reply_markup: buildQuestionTypesKeyboard([...selectedTypes])
    });
  }
};

const buildGenerateInput = (uploadedFiles: UploadedFile[], questionCount: number, questionTypes: QuestionType[]): GenerateQuestionsInput => {
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

const isMalformedJsonError = (error: unknown): boolean =>
  error instanceof AppError && error.message.toLowerCase().includes("malformed json");

const generateQuestions = async (
  conversation: Conversation<BotContext, BotContext>,
  input: GenerateQuestionsInput
): Promise<Question[]> => {
  let malformedJsonRetried = false;

  while (true) {
    try {
      return await conversation.external(async () => getAIProvider().generateQuestions(input));
    } catch (error) {
      if (isMalformedJsonError(error) && !malformedJsonRetried) {
        malformedJsonRetried = true;
        await conversation.log("[upload] Retrying question generation after malformed JSON response");
        continue;
      }

      throw error;
    }
  }
};

const generateUntilSuccessOrCancel = async (
  conversation: Conversation<BotContext, BotContext>,
  ctx: BotContext
): Promise<Question[] | null> => {
  const uploadedFiles = ctx.session.uploadedFiles ?? [];
  const questionCount = ctx.session.questionCount;
  const questionTypes = ctx.session.questionTypes;

  if (!questionCount || !questionTypes?.length || uploadedFiles.length === 0) {
    throw new AppError("Upload session is missing data required for generation", 400);
  }

  const input = buildGenerateInput(uploadedFiles, questionCount, questionTypes);

  while (true) {
    await ctx.reply("Generating your questions... 🧠 This may take a moment");

    try {
      return await generateQuestions(conversation, input);
    } catch (error) {
      console.error("[upload] Question generation failed", error);
      await ctx.reply(
        "I couldn’t generate questions from that material right now. You can retry without re-uploading your file.",
        { reply_markup: buildRetryKeyboard() }
      );

      while (true) {
        const nextCtx = await waitForUpdate(conversation);

        if (nextCtx.callbackQuery?.data === RETRY_GENERATION_CALLBACK) {
          await nextCtx.answerCallbackQuery();
          break;
        }

        await nextCtx.reply("Tap Retry generation to try again, or use /cancel to stop.");
      }
    }
  }
};

export const uploadScene = async (
  conversation: Conversation<BotContext, BotContext>,
  ctx: BotContext
): Promise<void> => {
  try {
    const uploadedFiles = await askForUpload(conversation, ctx);
    ctx.session.uploadedFiles = uploadedFiles;

    const questionCount = await askForQuestionCount(conversation, ctx);
    ctx.session.questionCount = questionCount;

    const questionTypes = await askForQuestionTypes(conversation, ctx);
    ctx.session.questionTypes = questionTypes;

    const draftQuestions = await generateUntilSuccessOrCancel(conversation, ctx);
    if (!draftQuestions) {
      return;
    }

    ctx.session.state = "reviewing";
    ctx.session.draftQuestions = draftQuestions;
    ctx.session.reviewIndex = 0;

    await ctx.conversation.enter(REVIEW_CONVERSATION_NAME);
  } catch (error) {
    if (error instanceof Error && error.message === "conversation_cancelled") {
      return;
    }

    if (error instanceof AppError && error.statusCode < 500) {
      await ctx.reply(error.message);
      await ctx.conversation.enter(UPLOAD_CONVERSATION_NAME);
      return;
    }

    throw error;
  }
};
