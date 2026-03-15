import { Conversation } from "@grammyjs/conversations";
import { InlineKeyboard } from "grammy";
import { getAIProvider } from "../../ai/ai.factory.js";
import { assertGenerationRateLimit } from "../middlewares/rateLimitMiddleware.js";
import { config } from "../../config/index.js";
import { AppError } from "../../shared/errors/AppError.js";
import { logger } from "../../shared/logger.js";
import { ValidationError } from "../../shared/errors/ValidationError.js";
import { DEFAULT_QUESTION_TYPES, type GenerateQuestionsInput, type Question, type QuestionType } from "../../shared/types/index.js";
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

type ImageFileInfo = { fileId: string; fileSize: number | undefined; mimeType: string };

/**
 * Returns image file info from either a compressed photo message or a document
 * sent via "Send as File". Returns null if the message is not an image.
 * Telegram always recompresses ctx.message.photo to JPEG; documents carry the
 * original mime_type set by Telegram's own detection.
 */
const extractImageFileInfo = (ctx: BotContext): ImageFileInfo | null => {
  if (ctx.msg?.photo?.length) {
    const photo = ctx.msg.photo.at(-1)!;
    return { fileId: photo.file_id, fileSize: photo.file_size, mimeType: "image/jpeg" };
  }
  const doc = ctx.msg?.document;
  if (doc?.mime_type?.startsWith("image/")) {
    return { fileId: doc.file_id, fileSize: doc.file_size, mimeType: doc.mime_type };
  }
  return null;
};

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

const CANCELLED = Symbol("upload-cancelled");

const getTelegramFile = async (ctx: BotContext, fileId: string) => {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) {
    throw new AppError("Telegram did not return a downloadable file path", {
      statusCode: 502,
      code: "TELEGRAM_FILE_PATH_MISSING",
      userMessage: "I couldn't read that Telegram file. Please try sending it again.",
      isRetryable: true
    });
  }

  return file;
};

const getTelegramFileBuffer = async (ctx: BotContext, fileId: string): Promise<Buffer> => {
  const file = await getTelegramFile(ctx, fileId);

  const response = await fetch(`https://api.telegram.org/file/bot${config.BOT_TOKEN}/${file.file_path}`);
  if (!response.ok) {
    throw new AppError("Failed to download file from Telegram", {
      statusCode: response.status,
      code: "TELEGRAM_FILE_DOWNLOAD_FAILED",
      userMessage: "I couldn't download that file from Telegram. Please try again.",
      isRetryable: true
    });
  }

  return Buffer.from(await response.arrayBuffer());
};

const validateFileSize = (fileSize: number | undefined): void => {
  if (fileSize !== undefined && fileSize > getFileSizeLimitBytes()) {
    logger.warn("Upload file rejected", {
      event: "upload.file.rejected",
      reason: "file_too_large",
      fileSizeBytes: fileSize
    });
    throw new ValidationError(
      `That file is too large. Please keep files under ${config.MAX_FILE_SIZE_MB ?? DEFAULT_MAX_FILE_SIZE_MB} MB.`,
      "FILE_TOO_LARGE"
    );
  }
};


const handleCancel = async (conversation: Conversation<BotContext, BotContext>, ctx: BotContext): Promise<typeof CANCELLED> => {
  // Session writes inside a conversation must go through external() so they are
  // skipped on replay instead of being re-applied and corrupting state.
  await conversation.external((liveCtx) => { resetSession(liveCtx.session); });
  await ctx.reply("Your current flow has been cancelled and your session is back to idle.");
  return CANCELLED;
};

const waitForUpdate = async (
  conversation: Conversation<BotContext, BotContext>
): Promise<BotContext | typeof CANCELLED> => {
  const ctx = await conversation.wait();

  if (isCancelMessage(ctx)) {
    return handleCancel(conversation, ctx);
  }

  return ctx;
};

const collectPdfUpload = async (
  conversation: Conversation<BotContext, BotContext>,
  ctx: BotContext
): Promise<UploadedFile[]> => {
  const document = ctx.msg?.document;
  if (!document) {
    throw new ValidationError("No document found in the message", "DOCUMENT_MISSING");
  }

  if (document.mime_type !== "application/pdf") {
    logger.warn("Upload file rejected", {
      event: "upload.file.rejected",
      userId: ctx.from?.id,
      reason: "wrong_type"
    });
    throw new ValidationError("That document is not a PDF. Please send a PDF or photos instead.", "INVALID_PDF_TYPE");
  }

  if (document.file_size !== undefined && document.file_size > getFileSizeLimitBytes()) {
    logger.warn("Upload file rejected", {
      event: "upload.file.rejected",
      userId: ctx.from?.id,
      reason: "file_too_large",
      fileSizeBytes: document.file_size
    });
  }
  validateFileSize(document.file_size);
  logger.info("Upload file received", {
    event: "upload.file.received",
    userId: ctx.from?.id,
    type: "pdf",
    fileSizeBytes: document.file_size
  });
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
): Promise<UploadedFile[] | typeof CANCELLED> => {
  const uploadedFiles: UploadedFile[] = [];
  let currentCtx: BotContext | null = initialCtx;

  while (uploadedFiles.length < MAX_IMAGES) {
    // Accept both compressed photo messages and images sent via "Send as File".
    const imageInfo = currentCtx ? extractImageFileInfo(currentCtx) : null;

    if (currentCtx && imageInfo) {
      try {
        validateFileSize(imageInfo.fileSize);
      } catch (error) {
        if (error instanceof ValidationError) {
          await currentCtx.reply(error.userMessage);
          currentCtx = null;
          continue;
        }
        throw error;
      }

      await currentCtx.reply("Processing your file... ⏳");

      const activeCtx = currentCtx;
      const { fileId, mimeType } = imageInfo;
      // Rule 3: Telegram file download must run outside replay.
      const base64 = await conversation.external(async () => {
        const buffer = await getTelegramFileBuffer(activeCtx, fileId);
        return buffer.toString("base64");
      });

      uploadedFiles.push({ type: "image", fileId, base64, mimeType });
      logger.info("Upload file received", {
        event: "upload.file.received",
        userId: currentCtx.from?.id,
        type: "image",
        mimeType,
        fileIndex: uploadedFiles.length
      });

      if (uploadedFiles.length === 1) {
        await currentCtx.reply(
          "Image 1 added. Send more images one by one, or tap the button when you’re done.",
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

    const nextUpdate = await waitForUpdate(conversation);
    if (nextUpdate === CANCELLED) {
      return CANCELLED;
    }

    currentCtx = nextUpdate;

    if (currentCtx.callbackQuery?.data === DONE_ADDING_IMAGES_CALLBACK) {
      await currentCtx.answerCallbackQuery();
      logger.info("Upload images confirmed", {
        event: "upload.images.confirmed",
        userId: currentCtx.from?.id,
        imageCount: uploadedFiles.length
      });
      break;
    }

    // Reject non-image updates (PDFs mid-session, plain text, etc.)
    if (!extractImageFileInfo(currentCtx)) {
      logger.warn("Upload file rejected", {
        event: "upload.file.rejected",
        userId: currentCtx.from?.id,
        reason: "wrong_type"
      });
      await currentCtx.reply("Please send a photo or image file, or tap Done adding images ✅ when you’re finished.");
      currentCtx = null;
    }
  }

  return uploadedFiles;
};

const askForUpload = async (
  conversation: Conversation<BotContext, BotContext>,
  ctx: BotContext
): Promise<UploadedFile[] | typeof CANCELLED> => {
  await conversation.external((ctx) => {
    // Rule 1: session writes in conversations must go through external.
    ctx.session.state = "uploading";
    ctx.session.uploadedFiles = undefined;
  });
  logger.info("Upload scene entered", {
    event: "upload.scene.enter",
    userId: ctx.from?.id
  });

  await ctx.reply("Send me a PDF or one/more images of your study material");

  while (true) {
    const nextCtx = await waitForUpdate(conversation);
    if (nextCtx === CANCELLED) {
      return CANCELLED;
    }
    logger.info("Upload received update", {
      event: "upload.debug.update",
      hasDocument: Boolean(nextCtx.msg?.document),
      documentMimeType: nextCtx.msg?.document?.mime_type,
      hasPhoto: Boolean(nextCtx.msg?.photo?.length),
      hasText: Boolean(nextCtx.msg?.text),
      updateKeys: Object.keys(nextCtx.update),
      messageKeys: nextCtx.msg ? Object.keys(nextCtx.msg) : []
    });

    if (isDocumentMessage(nextCtx)) {
      const mimeType = nextCtx.msg?.document?.mime_type ?? "";
      if (mimeType === "application/pdf") {
        try {
          return await collectPdfUpload(conversation, nextCtx);
        } catch (error) {
          if (error instanceof ValidationError) {
            await nextCtx.reply(error.userMessage);
            continue;
          }

          throw error;
        }
      }
      if (mimeType.startsWith("image/")) {
        return collectImageUploads(conversation, nextCtx);
      }
      await nextCtx.reply(
        "That file type isn't supported. Please send a PDF or an image (JPEG/PNG)."
      );
      continue;
    }

    if (isPhotoMessage(nextCtx)) {
      return collectImageUploads(conversation, nextCtx);
    }

    logger.warn("Upload file rejected", {
      event: "upload.file.rejected",
      userId: nextCtx.from?.id,
      reason: "wrong_type"
    });
    await nextCtx.reply("Please send a PDF document or one/more images to continue.");
  }
};

const askForQuestionCount = async (
  conversation: Conversation<BotContext, BotContext>,
  ctx: BotContext
): Promise<number | typeof CANCELLED> => {
  await conversation.external((ctx) => {
    // Rule 1: session writes in conversations must go through external.
    ctx.session.state = "configuring";
  });

  await ctx.reply("How many questions should I generate?", {
    reply_markup: buildQuestionCountKeyboard()
  });

  while (true) {
    const nextCtx = await waitForUpdate(conversation);
    if (nextCtx === CANCELLED) {
      return CANCELLED;
    }
    const callbackData = nextCtx.callbackQuery?.data;

    if (!callbackData?.startsWith(QUESTION_COUNT_CALLBACK_PREFIX)) {
      await nextCtx.reply("Use the buttons to choose a question count.");
      continue;
    }

    await nextCtx.answerCallbackQuery();

    const value = callbackData.slice(QUESTION_COUNT_CALLBACK_PREFIX.length);
    if (value !== "custom") {
      const count = Number(value);
      logger.info("Question count selected", {
        event: "upload.config.questionCount",
        userId: nextCtx.from?.id,
        count
      });
      return count;
    }

    await nextCtx.reply("Type the number of questions you want (1-50).");

    while (true) {
      const customCtx = await waitForUpdate(conversation);
      if (customCtx === CANCELLED) {
        return CANCELLED;
      }
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

      logger.info("Question count selected", {
        event: "upload.config.questionCount",
        userId: customCtx.from?.id,
        count: parsed
      });
      return parsed;
    }
  }
};

const askForQuestionTypes = async (
  conversation: Conversation<BotContext, BotContext>,
  ctx: BotContext
): Promise<QuestionType[] | typeof CANCELLED> => {
  const selectedTypes = new Set<QuestionType>(ctx.user?.defaultQuestionTypes ?? DEFAULT_QUESTION_TYPES);
  const promptText = "Which question types?";

  const message = await ctx.reply(promptText, {
    reply_markup: buildQuestionTypesKeyboard([...selectedTypes])
  });

  while (true) {
    const nextCtx = await waitForUpdate(conversation);
    if (nextCtx === CANCELLED) {
      return CANCELLED;
    }
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

      logger.info("Question types selected", {
        event: "upload.config.questionTypes",
        userId: nextCtx.from?.id,
        types: [...selectedTypes]
      });
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
        // Fall back to jpeg if mimeType was somehow not recorded (should not happen).
        mimeType: file.mimeType ?? "image/jpeg"
      }))
    },
    questionCount,
    questionTypes
  };
};

const isMalformedJsonError = (error: unknown): boolean =>
  error instanceof AppError && error.message.toLowerCase().includes("malformed json");

const generateQuestions = async (
  conversation: Conversation<BotContext, BotContext>,
  userId: number | undefined,
  input: GenerateQuestionsInput
): Promise<Question[]> => {
  let malformedJsonRetried = false;
  let attempt = 1;

  while (true) {
    try {
      return await conversation.external(async () => getAIProvider().generateQuestions(input));
    } catch (error) {
      if (isMalformedJsonError(error) && !malformedJsonRetried) {
        malformedJsonRetried = true;
        logger.warn("AI generation retry requested", {
          event: "ai.generation.retry",
          userId,
          attempt
        });
        await conversation.log("[upload] Retrying question generation after malformed JSON response");
        attempt += 1;
        continue;
      }

      throw error;
    }
  }
};

const generateUntilSuccessOrCancel = async (
  conversation: Conversation<BotContext, BotContext>,
  ctx: BotContext
): Promise<Question[] | typeof CANCELLED> => {
  const { uploadedFiles, questionCount, questionTypes } = await conversation.external((ctx) => ({
    // Rule 1: session reads in conversations must go through external.
    uploadedFiles: ctx.session.uploadedFiles ?? [],
    questionCount: ctx.session.questionCount,
    questionTypes: ctx.session.questionTypes
  }));

  if (!questionCount || !questionTypes?.length || uploadedFiles.length === 0) {
    throw new ValidationError("Upload session is missing data required for generation", "UPLOAD_SESSION_INCOMPLETE");
  }

  const input = buildGenerateInput(uploadedFiles, questionCount, questionTypes);

  while (true) {
    await ctx.reply("Generating your questions... 🧠 This may take a moment");
    // Rule 4: Date.now is non-deterministic, so read it outside replay.
    const startedAt = await conversation.external(() => Date.now());
    logger.info("AI generation started", {
      event: "ai.generation.start",
      userId: ctx.from?.id,
      provider: config.AI_PROVIDER,
      questionCount,
      types: questionTypes
    });

    try {
      // Rule 3: Redis-backed rate limiting must run outside replay.
      await conversation.external((ctx) => assertGenerationRateLimit(ctx));
      const questions = await generateQuestions(conversation, ctx.from?.id, input);
      logger.info("AI generation succeeded", {
        event: "ai.generation.success",
        userId: ctx.from?.id,
        questionsReturned: questions.length,
        durationMs: (await conversation.external(() => Date.now())) - startedAt
      });
      return questions;
    } catch (error) {
      logger.error("AI generation failed", {
        event: "ai.generation.failed",
        userId: ctx.from?.id,
        error: error instanceof Error ? error.message : String(error)
      });
      console.error("[upload] Question generation failed", error);
      await ctx.reply(
        "I couldn’t generate questions from that material right now. You can retry without re-uploading your file.",
        { reply_markup: buildRetryKeyboard() }
      );

      while (true) {
        const nextCtx = await waitForUpdate(conversation);
        if (nextCtx === CANCELLED) {
          return CANCELLED;
        }

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
  const uploadedFiles = await askForUpload(conversation, ctx);
  if (uploadedFiles === CANCELLED) {
    return;
  }

  const questionCount = await askForQuestionCount(conversation, ctx);
  if (questionCount === CANCELLED) {
    return;
  }

  const questionTypes = await askForQuestionTypes(conversation, ctx);
  if (questionTypes === CANCELLED) {
    return;
  }

  await conversation.external((ctx) => {
    // Rule 1: persist wizard state outside replay before AI generation.
    ctx.session.uploadedFiles = uploadedFiles;
    ctx.session.questionCount = questionCount;
    ctx.session.questionTypes = questionTypes;
  });

  const draftQuestions = await generateUntilSuccessOrCancel(conversation, ctx);
  if (draftQuestions === CANCELLED) {
    return;
  }

  await conversation.external((ctx) => {
    // Rule 1: session writes in conversations must go through external.
    ctx.session.state = "reviewing";
    ctx.session.draftQuestions = draftQuestions;
    ctx.session.reviewIndex = 0;
  });
};
