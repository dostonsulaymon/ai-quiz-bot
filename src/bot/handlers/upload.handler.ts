import { InlineKeyboard } from "grammy";
import { generateWithFallback } from "../../ai/ai.factory.js";
import { assertGenerationRateLimit } from "../middlewares/rateLimitMiddleware.js";
import { config } from "../../config/index.js";
import { AppError } from "../../shared/errors/AppError.js";
import { AIError } from "../../shared/errors/AIError.js";
import { logger } from "../../shared/logger.js";
import { recordAIGeneration } from "../../shared/metrics.js";
import { RateLimitError } from "../../shared/errors/RateLimitError.js";
import { ValidationError } from "../../shared/errors/ValidationError.js";
import { type GenerateQuestionsInput, type QuestionType } from "../../shared/types/index.js";
import { resetSession, type BotContext, type UploadedFile } from "../types.js";
import { transitionTo } from "../state-machine.js";
import { formatQuestionTypes, t, type Language } from "../../shared/i18n/index.js";
import { TestRepository } from "../../db/repositories/test.repository.js";
import { enterTestFlow } from "./test.handler.js";
import { enterReviewFlow } from "./review.handler.js";
import { storeUploadData, getUploadData, deleteAllUploadData } from "../utils/upload-storage.js";
import { NAV_MAIN_MENU_CALLBACK, NAV_MYTESTS_CALLBACK, NAV_NEWTEST_CALLBACK } from "./commands.js";

const testRepository = new TestRepository();

const DONE_ADDING_IMAGES_CALLBACK = "upload:images:done";
const RETRY_GENERATION_CALLBACK = "upload:generation:retry";
const CANCEL_RETRY_CALLBACK = "upload:generation:cancel";
const TITLE_SKIP_CALLBACK = "upload:title:skip";
const TITLE_CANCEL_CALLBACK = "upload:title:cancel";
const TEXT_START_CALLBACK = "upload:text:start";
const TEXT_CANCEL_CALLBACK = "upload:text:cancel";
const QUESTION_COUNT_CALLBACK_PREFIX = "upload:count:";
const PRESET_CALLBACK_PREFIX = "upload:preset:";
const QUESTION_TYPES_CALLBACK_PREFIX = "upload:types:";
const QUESTION_TYPES_CONFIRM_CALLBACK = "upload:types:confirm";
const SHUFFLE_CALLBACK_PREFIX = "upload:shuffle:";
const TIMER_CALLBACK_PREFIX = "upload:timer:";
const ACTION_CALLBACK_PREFIX = "upload:action:";
const SAVE_START_CALLBACK_PREFIX = "upload:save:start:";
const UPLOAD_NAV_CALLBACK_PREFIX = "upload:nav:";
const MAX_IMAGES = 10;
const MAX_CUSTOM_QUESTION_COUNT = config.MAX_QUESTIONS_PER_TEST;
const DEFAULT_MAX_FILE_SIZE_MB = 20;
const FILE_DOWNLOAD_TIMEOUT_MS = 30_000;
const RATE_LIMIT_RETRY_DELAY_SECONDS = 30;
const SESSION_KEY_PREFIX = "quiz-bot:session:";
const KB = 1024;
const MB = 1024 * 1024;

const getFileSizeLimitBytes = (): number => (config.MAX_FILE_SIZE_MB ?? DEFAULT_MAX_FILE_SIZE_MB) * 1024 * 1024;

const getRecommendedQuestionCount = (uploadedFiles: UploadedFile[] | undefined): number | undefined => {
  const first = uploadedFiles?.[0];
  if (!first || first.type !== "pdf" || typeof first.fileSizeBytes !== "number") {
    return undefined;
  }

  const size = first.fileSizeBytes;
  if (size < 100 * KB) return 10;
  if (size < 300 * KB) return 20;
  if (size < 600 * KB) return 30;
  if (size <= MB) return 50;
  return Math.min(75, MAX_CUSTOM_QUESTION_COUNT);
};

const formatTimerLabel = (seconds: number, lang: Language): string => {
  switch (seconds) {
    case 0: return t(lang, "upload.timer.btn.none");
    case 15: return t(lang, "upload.timer.btn.15");
    case 30: return t(lang, "upload.timer.btn.30");
    case 60: return t(lang, "upload.timer.btn.60");
    case 180: return t(lang, "upload.timer.btn.180");
    default: return `${seconds}s`;
  }
};

const getShuffleChoice = (shuffleQuestions: boolean, shuffleOptions: boolean): "both" | "questions" | "none" => {
  if (shuffleQuestions && shuffleOptions) return "both";
  if (shuffleQuestions) return "questions";
  return "none";
};

const formatShuffleLabel = (choice: "both" | "questions" | "none", lang: Language): string => {
  switch (choice) {
    case "both": return t(lang, "upload.shuffle.both");
    case "questions": return t(lang, "upload.shuffle.questions");
    default: return t(lang, "upload.shuffle.none");
  }
};

const buildQuestionCountKeyboard = (
  lang: Language,
  defaultCount?: number,
  recommendedCount?: number
): InlineKeyboard => {
  const keyboard = new InlineKeyboard();

  if (recommendedCount !== undefined) {
    keyboard
      .text(
        t(lang, "upload.recommendedCountButton", { count: recommendedCount }),
        `${QUESTION_COUNT_CALLBACK_PREFIX}${recommendedCount}`
      )
      .row();
  }

  if (defaultCount !== undefined) {
    keyboard
      .text(t(lang, "upload.keepDefaultCount", { count: defaultCount }), `${QUESTION_COUNT_CALLBACK_PREFIX}${defaultCount}`)
      .row();
  }

  return keyboard
    .text("5", `${QUESTION_COUNT_CALLBACK_PREFIX}5`)
    .text("10", `${QUESTION_COUNT_CALLBACK_PREFIX}10`)
    .text("15", `${QUESTION_COUNT_CALLBACK_PREFIX}15`)
    .text("20", `${QUESTION_COUNT_CALLBACK_PREFIX}20`)
    .row()
    .text("30", `${QUESTION_COUNT_CALLBACK_PREFIX}30`)
    .text("50", `${QUESTION_COUNT_CALLBACK_PREFIX}50`)
    .row()
    .text(t(lang, "upload.btn.customWithPencil"), `${QUESTION_COUNT_CALLBACK_PREFIX}custom`)
    .row()
    .text(t(lang, "btn.back"), `${UPLOAD_NAV_CALLBACK_PREFIX}preset`)
    .text(t(lang, "btn.cancel"), `${UPLOAD_NAV_CALLBACK_PREFIX}cancel`);
};

const buildPresetKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "upload.fast_path.use_defaults"), `${PRESET_CALLBACK_PREFIX}defaults`)
    .row()
    .text(t(lang, "upload.fast_path.customize"), `${PRESET_CALLBACK_PREFIX}customize`)
    .row()
    .text(t(lang, "btn.cancel"), `${UPLOAD_NAV_CALLBACK_PREFIX}cancel`);

const buildQuestionTypesKeyboard = (
  selectedTypes: QuestionType[],
  lang: Language,
  defaultTypes?: QuestionType[]
): InlineKeyboard => {
  const selected = new Set(selectedTypes);
  const toggleLabel = (type: QuestionType): string => {
    const typeKey = `upload.type.${type}` as Parameters<typeof t>[1];
    return `${selected.has(type) ? "[x]" : "[ ]"} ${t(lang, typeKey)}`;
  };

  const keyboard = new InlineKeyboard();

  if (defaultTypes?.length) {
    keyboard
      .text(
        t(lang, "upload.keepDefaultTypes", { types: formatQuestionTypes(defaultTypes, lang) }),
        QUESTION_TYPES_CONFIRM_CALLBACK
      )
      .row();
  }

  return keyboard
    .text(toggleLabel("mcq"), `${QUESTION_TYPES_CALLBACK_PREFIX}mcq`)
    .text(toggleLabel("truefalse"), `${QUESTION_TYPES_CALLBACK_PREFIX}truefalse`)
    .row()
    .text(toggleLabel("short"), `${QUESTION_TYPES_CALLBACK_PREFIX}short`)
    .text(toggleLabel("fill"), `${QUESTION_TYPES_CALLBACK_PREFIX}fill`)
    .row()
    .text(t(lang, "upload.btn.done"), QUESTION_TYPES_CONFIRM_CALLBACK)
    .text(t(lang, "btn.back"), `${UPLOAD_NAV_CALLBACK_PREFIX}count`)
    .row()
    .text(t(lang, "btn.cancel"), `${UPLOAD_NAV_CALLBACK_PREFIX}cancel`);
};

const buildDoneAddingImagesKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "upload.btn.doneAddingImages"), DONE_ADDING_IMAGES_CALLBACK)
    .row()
    .text(t(lang, "btn.cancel"), `${UPLOAD_NAV_CALLBACK_PREFIX}cancel`);

const buildRetryKeyboard = (lang: Language, retryLabel?: string): InlineKeyboard =>
  new InlineKeyboard()
    .text(retryLabel ?? t(lang, "upload.retry.btn"), RETRY_GENERATION_CALLBACK)
    .text(t(lang, "btn.cancel"), CANCEL_RETRY_CALLBACK);

const buildShuffleKeyboard = (
  lang: Language,
  defaultChoice?: "both" | "questions" | "none"
): InlineKeyboard => {
  const keyboard = new InlineKeyboard();

  if (defaultChoice !== undefined) {
    keyboard
      .text(
        t(lang, "upload.keepDefaultShuffle", { shuffle: formatShuffleLabel(defaultChoice, lang) }),
        `${SHUFFLE_CALLBACK_PREFIX}${defaultChoice}`
      )
      .row();
  }

  return keyboard
    .text(t(lang, "upload.shuffle.both"), `${SHUFFLE_CALLBACK_PREFIX}both`)
    .row()
    .text(t(lang, "upload.shuffle.questions"), `${SHUFFLE_CALLBACK_PREFIX}questions`)
    .row()
    .text(t(lang, "upload.shuffle.none"), `${SHUFFLE_CALLBACK_PREFIX}none`)
    .row()
    .text(t(lang, "btn.back"), `${UPLOAD_NAV_CALLBACK_PREFIX}types`)
    .text(t(lang, "btn.cancel"), `${UPLOAD_NAV_CALLBACK_PREFIX}cancel`);
};

const buildTimerKeyboard = (lang: Language, defaultSeconds?: number): InlineKeyboard => {
  const keyboard = new InlineKeyboard();

  if (defaultSeconds !== undefined) {
    keyboard
      .text(
        t(lang, "upload.keepDefaultTimer", { timer: formatTimerLabel(defaultSeconds, lang) }),
        `${TIMER_CALLBACK_PREFIX}${defaultSeconds}`
      )
      .row();
  }

  return keyboard
    .text(t(lang, "upload.timer.btn.15"), `${TIMER_CALLBACK_PREFIX}15`)
    .text(t(lang, "upload.timer.btn.30"), `${TIMER_CALLBACK_PREFIX}30`)
    .row()
    .text(t(lang, "upload.timer.btn.60"), `${TIMER_CALLBACK_PREFIX}60`)
    .text(t(lang, "upload.timer.btn.180"), `${TIMER_CALLBACK_PREFIX}180`)
    .row()
    .text(t(lang, "upload.timer.btn.none"), `${TIMER_CALLBACK_PREFIX}0`)
    .row()
    .text(t(lang, "btn.back"), `${UPLOAD_NAV_CALLBACK_PREFIX}shuffle`)
    .text(t(lang, "btn.cancel"), `${UPLOAD_NAV_CALLBACK_PREFIX}cancel`);
};

const buildActionKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "upload.action.start"), `${ACTION_CALLBACK_PREFIX}start`)
    .row()
    .text(t(lang, "upload.action.review"), `${ACTION_CALLBACK_PREFIX}review`)
    .row()
    .text(t(lang, "upload.action.save"), `${ACTION_CALLBACK_PREFIX}save`)
    .row()
    .text(t(lang, "btn.cancel"), `${UPLOAD_NAV_CALLBACK_PREFIX}cancel`);

const buildSavedTestKeyboard = (testId: string, link: string, lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "deadend.btn.start_test"), `${SAVE_START_CALLBACK_PREFIX}${testId}`)
    .url(t(lang, "deadend.btn.share_link"), link)
    .row()
    .text(t(lang, "deadend.btn.my_tests"), NAV_MYTESTS_CALLBACK)
    .text(t(lang, "deadend.btn.main_menu"), NAV_MAIN_MENU_CALLBACK);

const buildUploadCancelledKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "deadend.btn.create_test"), NAV_NEWTEST_CALLBACK)
    .text(t(lang, "deadend.btn.main_menu"), NAV_MAIN_MENU_CALLBACK);

const buildCountCustomKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "btn.back"), `${UPLOAD_NAV_CALLBACK_PREFIX}count`)
    .text(t(lang, "btn.cancel"), `${UPLOAD_NAV_CALLBACK_PREFIX}cancel`);

type ImageFileInfo = { fileId: string; fileSize: number | undefined; mimeType: string };

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

const getTelegramFileBuffer = async (ctx: BotContext, fileId: string): Promise<Buffer> => {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) {
    throw new AppError("Telegram did not return a downloadable file path", {
      statusCode: 502,
      code: "TELEGRAM_FILE_PATH_MISSING",
      isRetryable: true
    });
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), FILE_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.telegram.org/file/bot${config.BOT_TOKEN}/${file.file_path}`, {
      signal: controller.signal
    });
    if (!response.ok) {
      throw new AppError("Failed to download file from Telegram", {
        statusCode: response.status,
        code: "TELEGRAM_FILE_DOWNLOAD_FAILED",
        isRetryable: true
      });
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new AppError("Telegram file download timed out", {
        statusCode: 504,
        code: "FILE_DOWNLOAD_TIMEOUT",
        userMessage: "FILE_DOWNLOAD_TIMEOUT",
        isRetryable: true
      });
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
};

const validateFileSize = (fileSize: number | undefined, lang: Language): void => {
  if (fileSize !== undefined && fileSize > getFileSizeLimitBytes()) {
    logger.warn("Upload file rejected", {
      event: "upload.file.rejected",
      reason: "file_too_large",
      fileSizeBytes: fileSize
    });
    throw new ValidationError(
      t(lang, "upload.fileTooLarge", { maxMb: config.MAX_FILE_SIZE_MB ?? DEFAULT_MAX_FILE_SIZE_MB }),
      "FILE_TOO_LARGE"
    );
  }
};

type ResolvedFile = UploadedFile & { base64: string };

const buildGenerateInput = (
  filesWithData: ResolvedFile[],
  questionCount: number,
  questionTypes: QuestionType[]
): GenerateQuestionsInput => {
  const firstFile = filesWithData[0];
  if (!firstFile) {
    throw new ValidationError("No uploaded files are available for generation", "UPLOAD_MISSING");
  }

  if (firstFile.type === "pdf") {
    return { content: { type: "pdf", base64: firstFile.base64 }, questionCount, questionTypes };
  }

  return {
    content: {
      type: "images",
      images: filesWithData.map((file) => ({
        base64: file.base64,
        mimeType: file.mimeType ?? "image/jpeg"
      }))
    },
    questionCount,
    questionTypes
  };
};

const buildUploadPromptKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard().text(t(lang, "upload.text.btn"), TEXT_START_CALLBACK);

const buildFastPathSummary = (ctx: BotContext): string => {
  const lang = ctx.lang();
  const count = ctx.session.questionCount ?? ctx.user?.defaultQuestionCount ?? 10;
  const types = formatQuestionTypes(ctx.session.questionTypes ?? ctx.user?.defaultQuestionTypes ?? ["mcq", "truefalse"], lang);
  const timer = formatTimerLabel(ctx.session.timeLimitSeconds ?? ctx.user?.defaultTimeLimitSeconds ?? 0, lang);
  const shuffle = formatShuffleLabel(getShuffleChoice(
    ctx.session.shuffleQuestions ?? ctx.user?.defaultShuffleQuestions ?? false,
    ctx.session.shuffleOptions ?? ctx.user?.defaultShuffleOptions ?? false
  ), lang);

  return t(lang, "upload.fast_path.summary", { count, types, timer, shuffle });
};

const showUploadCancelled = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  resetSession(ctx.session);
  await ctx.reply(t(lang, "upload.cancelled"), {
    reply_markup: buildUploadCancelledKeyboard(lang)
  });
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const getSessionStorageKey = (ctx: BotContext): string | null =>
  ctx.from?.id && ctx.chat?.id ? `${SESSION_KEY_PREFIX}${ctx.from.id}:${ctx.chat.id}` : null;

const isRetryPendingInStorage = async (ctx: BotContext): Promise<boolean> => {
  const key = getSessionStorageKey(ctx);
  if (!key) return false;

  const raw = await ctx.redis.get(key);
  if (!raw) return false;

  try {
    const session = JSON.parse(raw) as { uploadStep?: string; state?: string };
    return session.state === "configuring" && session.uploadStep === "waiting_retry";
  } catch {
    return false;
  }
};

const mapGenerationError = (
  error: unknown,
  lang: Language
): { message: string; isRateLimit: boolean; retryLabel?: string } => {
  if (error instanceof AIError && error.code === "TIMEOUT") {
    return { message: t(lang, "upload.error.timeout"), isRateLimit: false };
  }

  if (
    error instanceof RateLimitError ||
    (error instanceof AIError && error.code === "RATE_LIMIT") ||
    (error instanceof AppError && error.code === "RATE_LIMIT_EXCEEDED")
  ) {
    return {
      message: t(lang, "upload.error.rate_limit"),
      isRateLimit: true,
      retryLabel: t(lang, "upload.retry.btn.delayed", { n: RATE_LIMIT_RETRY_DELAY_SECONDS })
    };
  }

  if (error instanceof AIError && error.code === "ALL_PROVIDERS_FAILED") {
    return { message: t(lang, "upload.error.all_failed"), isRateLimit: false };
  }

  return { message: t(lang, "upload.error.generic"), isRateLimit: false };
};

const scheduleRateLimitRetry = (ctx: BotContext, messageId: number, lang: Language): void => {
  void (async () => {
    for (let remaining = RATE_LIMIT_RETRY_DELAY_SECONDS; remaining >= 1; remaining--) {
      const stillWaiting = await isRetryPendingInStorage(ctx);
      if (!stillWaiting) return;

      await ctx.api.editMessageText(
        ctx.chatId!,
        messageId,
        t(lang, "upload.retry.rate_limit_countdown", { n: remaining }),
        {
          reply_markup: buildRetryKeyboard(lang, t(lang, "upload.retry.btn.delayed", { n: remaining }))
        }
      ).catch(() => undefined);

      await sleep(1_000);
    }

    const stillWaiting = await isRetryPendingInStorage(ctx);
    if (!stillWaiting) return;

    await ctx.api.editMessageText(ctx.chatId!, messageId, t(lang, "upload.retry.retrying")).catch(() => undefined);
    await runGeneration(ctx, true);
  })();
};

/** Enter the upload flow: reset session, pre-populate user defaults, set state, send prompt. */
export const enterUploadFlow = async (ctx: BotContext): Promise<void> => {
  resetSession(ctx.session);
  // Pre-populate from user preferences so saved defaults carry into each new test.
  ctx.session.questionCount = ctx.user?.defaultQuestionCount ?? 10;
  ctx.session.questionTypes = (ctx.user?.defaultQuestionTypes as QuestionType[] | undefined) ?? ["mcq", "truefalse"];
  ctx.session.timeLimitSeconds = ctx.user?.defaultTimeLimitSeconds ?? 0;
  ctx.session.shuffleQuestions = ctx.user?.defaultShuffleQuestions ?? false;
  ctx.session.shuffleOptions = ctx.user?.defaultShuffleOptions ?? false;
  ctx.session.uploadAutoStart = undefined;
  transitionTo(ctx.session, "uploading", "enterUploadFlow");
  ctx.session.uploadStep = "waiting_file";
  logger.info("Upload flow entered", { event: "upload.flow.enter", userId: ctx.from?.id });
  await ctx.reply(t(ctx.lang(), "upload.prompt"), { reply_markup: buildUploadPromptKeyboard(ctx.lang()) });
};

// ---------------------------------------------------------------------------
// Step: waiting_file
// ---------------------------------------------------------------------------

const handleWaitingFile = async (ctx: BotContext): Promise<void> => {
  // Handle "Type/Paste Text" button click.
  if (ctx.callbackQuery?.data === TEXT_START_CALLBACK) {
    await ctx.answerCallbackQuery();
    ctx.session.uploadStep = "waiting_text";
    ctx.session.uploadSourceType = "text";
    const lang = ctx.lang();
    await ctx.reply(t(lang, "upload.text.prompt"), {
      reply_markup: new InlineKeyboard().text(t(lang, "upload.text.cancel_btn"), TEXT_CANCEL_CALLBACK)
    });
    return;
  }

  const isDocument = Boolean(ctx.msg?.document);
  const isPhoto = Boolean(ctx.msg?.photo?.length);

  if (!isDocument && !isPhoto) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.reply(t(ctx.lang(), "upload.invalidFile"));
    return;
  }

  if (isDocument) {
    const mimeType = ctx.msg?.document?.mime_type ?? "";

    if (mimeType === "application/pdf") {
      await handlePdfUpload(ctx);
      return;
    }

    if (mimeType.startsWith("image/")) {
      await handleFirstImage(ctx);
      return;
    }

    await ctx.reply(t(ctx.lang(), "upload.unsupportedType"));
    return;
  }

  // isPhoto
  await handleFirstImage(ctx);
};

// ---------------------------------------------------------------------------
// Step: waiting_text
// ---------------------------------------------------------------------------

const TEXT_MIN_LENGTH = 100;
const TEXT_MAX_LENGTH = 10_000;

const handleWaitingText = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();

  // Cancel button
  if (ctx.callbackQuery?.data === TEXT_CANCEL_CALLBACK) {
    await ctx.answerCallbackQuery();
    await showUploadCancelled(ctx);
    return;
  }

  const text = ctx.message?.text;
  if (!text || ctx.message?.text?.startsWith("/")) {
    if (ctx.callbackQuery) { await ctx.answerCallbackQuery(); return; }
    return;
  }

  if (text.length < TEXT_MIN_LENGTH) {
    await ctx.reply(t(lang, "upload.text.too_short"));
    return;
  }

  if (text.length > TEXT_MAX_LENGTH) {
    await ctx.reply(t(lang, "upload.text.too_long"));
    return;
  }

  ctx.session.uploadedText = text;
  ctx.session.uploadSourceType = "text";
  logger.info("Text input received", { event: "upload.text.received", userId: ctx.from?.id, chars: text.length });
  await ctx.reply(t(lang, "upload.text.received", { chars: text.length }));
  await transitionToPresetChoice(ctx);
};

const handlePdfUpload = async (ctx: BotContext): Promise<void> => {
  const document = ctx.msg?.document;
  if (!document) return;

  const lang = ctx.lang();
  if (document.file_size !== undefined && document.file_size > getFileSizeLimitBytes()) {
    logger.warn("Upload file rejected", { event: "upload.file.rejected", userId: ctx.from?.id, reason: "file_too_large" });
    await ctx.reply(t(lang, "upload.fileTooLarge", { maxMb: config.MAX_FILE_SIZE_MB ?? DEFAULT_MAX_FILE_SIZE_MB }));
    return;
  }

  logger.info("Upload file received", { event: "upload.file.received", userId: ctx.from?.id, type: "pdf", fileSizeBytes: document.file_size });
  await ctx.replyWithChatAction("typing");
  await ctx.reply(t(lang, "upload.processing"));

  try {
    const buffer = await getTelegramFileBuffer(ctx, document.file_id);
    const base64 = buffer.toString("base64");
    const storageKey = await storeUploadData(ctx.redis, ctx.from!.id, document.file_id, base64);
    ctx.session.uploadedFiles = [{
      type: "pdf",
      fileId: document.file_id,
      storageKey,
      fileSizeBytes: document.file_size
    }];
  } catch (error) {
    if (error instanceof AppError && error.code === "FILE_DOWNLOAD_TIMEOUT") {
      await ctx.reply(t(lang, "error.file_download_timeout"));
    } else if (error instanceof AppError && error.code === "TELEGRAM_FILE_PATH_MISSING") {
      await ctx.reply(t(lang, "upload.telegram_read_error"));
    } else if (error instanceof AppError && error.code === "TELEGRAM_FILE_DOWNLOAD_FAILED") {
      await ctx.reply(t(lang, "upload.telegram_download_failed"));
    } else {
      const msg = error instanceof AppError ? error.message : t(lang, "upload.downloadError");
      await ctx.reply(msg);
    }
    return;
  }

  await transitionToPresetChoice(ctx);
};

const handleFirstImage = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const imageInfo = extractImageFileInfo(ctx);
  if (!imageInfo) {
    await ctx.reply(t(lang, "upload.sendPhoto"));
    return;
  }

  try {
    validateFileSize(imageInfo.fileSize, lang);
  } catch (error) {
    if (error instanceof ValidationError) {
      await ctx.reply(error.userMessage);
      return;
    }
    throw error;
  }

  await ctx.replyWithChatAction("typing");
  await ctx.reply(t(lang, "upload.processing"));

  try {
    const buffer = await getTelegramFileBuffer(ctx, imageInfo.fileId);
    const base64 = buffer.toString("base64");
    const storageKey = await storeUploadData(ctx.redis, ctx.from!.id, imageInfo.fileId, base64);
    ctx.session.uploadedFiles = [{
      type: "image",
      fileId: imageInfo.fileId,
      storageKey,
      mimeType: imageInfo.mimeType,
      fileSizeBytes: imageInfo.fileSize
    }];
  } catch (error) {
    if (error instanceof AppError && error.code === "FILE_DOWNLOAD_TIMEOUT") {
      await ctx.reply(t(lang, "error.file_download_timeout"));
    } else if (error instanceof AppError && error.code === "TELEGRAM_FILE_PATH_MISSING") {
      await ctx.reply(t(lang, "upload.telegram_read_error"));
    } else if (error instanceof AppError && error.code === "TELEGRAM_FILE_DOWNLOAD_FAILED") {
      await ctx.reply(t(lang, "upload.telegram_download_failed"));
    } else {
      const msg = error instanceof AppError ? error.message : t(lang, "upload.imageDownloadError");
      await ctx.reply(msg);
    }
    return;
  }

  logger.info("Upload file received", {
    event: "upload.file.received",
    userId: ctx.from?.id,
    type: "image",
    mimeType: imageInfo.mimeType,
    fileIndex: 1
  });

  ctx.session.uploadStep = "waiting_file"; // stay here to collect more images
  await ctx.reply(t(lang, "upload.image1Added"), { reply_markup: buildDoneAddingImagesKeyboard(lang) });
};

// When in waiting_file with uploadedFiles already present, we're collecting more images.
// The step stays "waiting_file" — we also handle the "Done" button and additional images here.
const handleAdditionalImage = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const files = ctx.session.uploadedFiles ?? [];

  if (ctx.callbackQuery?.data === DONE_ADDING_IMAGES_CALLBACK) {
    if (files.length === 0) {
      await ctx.answerCallbackQuery({ text: t(lang, "upload.sendAtLeastOne"), show_alert: false });
      return;
    }
    await ctx.answerCallbackQuery();
    logger.info("Upload images confirmed", { event: "upload.images.confirmed", userId: ctx.from?.id, imageCount: files.length });
    await transitionToPresetChoice(ctx);
    return;
  }

  const imageInfo = extractImageFileInfo(ctx);
  if (!imageInfo) {
    if (ctx.msg?.document?.mime_type === "application/pdf") {
      await ctx.reply(t(lang, "upload.pdf_after_images"));
    } else {
      await ctx.reply(t(lang, "upload.sendPhotoOrDone"));
    }
    return;
  }

  if (files.length >= MAX_IMAGES) {
    await ctx.reply(t(lang, "upload.imageLimitReached", { max: MAX_IMAGES }));
    return;
  }

  try {
    validateFileSize(imageInfo.fileSize, lang);
  } catch (error) {
    if (error instanceof ValidationError) {
      await ctx.reply(error.userMessage);
      return;
    }
    throw error;
  }

  await ctx.replyWithChatAction("typing");
  await ctx.reply(t(lang, "upload.processing"));

  try {
    const buffer = await getTelegramFileBuffer(ctx, imageInfo.fileId);
    const base64 = buffer.toString("base64");
    const storageKey = await storeUploadData(ctx.redis, ctx.from!.id, imageInfo.fileId, base64);
    files.push({
      type: "image",
      fileId: imageInfo.fileId,
      storageKey,
      mimeType: imageInfo.mimeType,
      fileSizeBytes: imageInfo.fileSize
    });
    ctx.session.uploadedFiles = files;
  } catch (error) {
    if (error instanceof AppError && error.code === "FILE_DOWNLOAD_TIMEOUT") {
      await ctx.reply(t(lang, "error.file_download_timeout"));
    } else if (error instanceof AppError && error.code === "TELEGRAM_FILE_PATH_MISSING") {
      await ctx.reply(t(lang, "upload.telegram_read_error"));
    } else if (error instanceof AppError && error.code === "TELEGRAM_FILE_DOWNLOAD_FAILED") {
      await ctx.reply(t(lang, "upload.telegram_download_failed"));
    } else {
      const msg = error instanceof AppError ? error.message : t(lang, "upload.imageDownloadError");
      await ctx.reply(msg);
    }
    return;
  }

  logger.info("Upload file received", {
    event: "upload.file.received",
    userId: ctx.from?.id,
    type: "image",
    mimeType: imageInfo.mimeType,
    fileIndex: files.length
  });

  if (files.length >= MAX_IMAGES) {
    await ctx.reply(t(lang, "upload.imageLimitReachedAuto", { max: MAX_IMAGES }));
    await transitionToPresetChoice(ctx);
    return;
  }

  await ctx.reply(t(lang, "upload.imageNAdded", { n: files.length }));
};

// ---------------------------------------------------------------------------
// Step transitions
// ---------------------------------------------------------------------------

const transitionToPresetChoice = async (ctx: BotContext): Promise<void> => {
  transitionTo(ctx.session, "configuring", "transitionToWaitingCount");
  ctx.session.uploadStep = "waiting_preset";
  await ctx.reply(
    [t(ctx.lang(), "upload.fast_path.prompt"), "", buildFastPathSummary(ctx)].join("\n"),
    { reply_markup: buildPresetKeyboard(ctx.lang()) }
  );
};

const transitionToWaitingCount = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const recommendedCount = getRecommendedQuestionCount(ctx.session.uploadedFiles);

  transitionTo(ctx.session, "configuring", "transitionToWaitingCount");
  ctx.session.uploadStep = "waiting_count";
  ctx.session.uploadCustomCountAttempts = undefined;

  const text = recommendedCount !== undefined
    ? `${t(lang, "upload.howManyQuestions")}\n${t(lang, "upload.recommendedCountHint", { count: recommendedCount })}`
    : t(lang, "upload.howManyQuestions");

  await ctx.reply(text, {
    reply_markup: buildQuestionCountKeyboard(lang, ctx.user?.defaultQuestionCount, recommendedCount)
  });
};

const transitionToWaitingTypes = async (ctx: BotContext, preserveSelection = false): Promise<void> => {
  const defaultTypes = (ctx.user?.defaultQuestionTypes as QuestionType[] | undefined) ?? ["mcq", "truefalse"];
  if (!preserveSelection || !(ctx.session.questionTypes?.length)) {
    ctx.session.questionTypes = [...defaultTypes];
  }
  ctx.session.uploadStep = "waiting_types";

  const message = await ctx.reply(t(ctx.lang(), "upload.whichTypes"), {
    reply_markup: buildQuestionTypesKeyboard(ctx.session.questionTypes, ctx.lang(), defaultTypes)
  });
  ctx.session.uploadTypesMessageId = message.message_id;
};

const handleUploadNavigation = async (ctx: BotContext): Promise<boolean> => {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(UPLOAD_NAV_CALLBACK_PREFIX)) {
    return false;
  }

  await ctx.answerCallbackQuery();
  const target = data.slice(UPLOAD_NAV_CALLBACK_PREFIX.length);

  switch (target) {
    case "preset":
      await transitionToPresetChoice(ctx);
      return true;
    case "count":
      await transitionToWaitingCount(ctx);
      return true;
    case "types":
      await transitionToWaitingTypes(ctx, true);
      return true;
    case "shuffle":
      await transitionToWaitingShuffle(ctx);
      return true;
    case "timer":
      await transitionToWaitingTimer(ctx);
      return true;
    case "cancel":
      await showUploadCancelled(ctx);
      return true;
    default:
      return true;
  }
};

const handleWaitingPreset = async (ctx: BotContext): Promise<void> => {
  const data = ctx.callbackQuery?.data;

  if (!data?.startsWith(PRESET_CALLBACK_PREFIX)) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    await ctx.reply(t(ctx.lang(), "upload.usePresetButtons"));
    return;
  }

  await ctx.answerCallbackQuery();
  const choice = data.slice(PRESET_CALLBACK_PREFIX.length);

  if (choice === "defaults") {
    ctx.session.editingTitle = undefined;
    ctx.session.uploadAutoStart = true;
    logger.info("Upload fast path selected", { event: "upload.config.fast_path", userId: ctx.from?.id });
    await runGeneration(ctx, false, "start");
    return;
  }

  ctx.session.uploadAutoStart = false;
  await transitionToWaitingCount(ctx);
};

const persistDraftTest = async (ctx: BotContext, lang: Language): Promise<string | null> => {
  const draftQuestions = ctx.session.draftQuestions ?? [];
  if (draftQuestions.length < 1) {
    await ctx.reply(t(lang, "review.needAtLeastOneToast"));
    return null;
  }

  if (!ctx.user) {
    resetSession(ctx.session);
    await ctx.reply(t(lang, "error.session_corrupted"));
    return null;
  }

  const uploadStorageKeys = (ctx.session.uploadedFiles ?? []).map((f) => f.storageKey);
  await deleteAllUploadData(ctx.redis, uploadStorageKeys);

  const savedTest = await testRepository.create({
    creatorId: ctx.user._id,
    title: ctx.session.editingTitle ?? t(lang, "test.default_title"),
    questions: draftQuestions,
    sourceType: ctx.session.uploadSourceType ?? "images",
    questionCount: draftQuestions.length,
    shuffleQuestions: ctx.session.shuffleQuestions ?? false,
    shuffleOptions: ctx.session.shuffleOptions ?? false,
    timeLimitSeconds: ctx.session.timeLimitSeconds ?? 0
  });

  return String(savedTest._id);
};

// ---------------------------------------------------------------------------
// Step: waiting_count
// ---------------------------------------------------------------------------

const handleWaitingCount = async (ctx: BotContext): Promise<void> => {
  const data = ctx.callbackQuery?.data;

  if (!data?.startsWith(QUESTION_COUNT_CALLBACK_PREFIX)) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    await ctx.reply(t(ctx.lang(), "upload.useCountButtons"));
    return;
  }

  await ctx.answerCallbackQuery();
  const value = data.slice(QUESTION_COUNT_CALLBACK_PREFIX.length);

  if (value === "custom") {
    await handleCustomCountCallback(ctx);
    return;
  }

  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_CUSTOM_QUESTION_COUNT) {
    await ctx.reply(t(ctx.lang(), "upload.useCountButtons"));
    return;
  }
  logger.info("Question count selected", { event: "upload.config.questionCount", userId: ctx.from?.id, count });
  ctx.session.questionCount = count;
  await transitionToWaitingTypes(ctx);
};

const handleCustomCountCallback = async (ctx: BotContext): Promise<void> => {
  ctx.session.uploadStep = "waiting_count_custom";
  ctx.session.uploadCustomCountAttempts = 0;
  await ctx.reply(t(ctx.lang(), "upload.customCountPrompt"), {
    reply_markup: buildCountCustomKeyboard(ctx.lang())
  });
};

// ---------------------------------------------------------------------------
// Step: waiting_count_custom
// ---------------------------------------------------------------------------

const handleWaitingCountCustom = async (ctx: BotContext): Promise<void> => {
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery();
    return;
  }

  const rawValue = ctx.msg?.text?.trim();

  if (!rawValue) {
    const attempts = (ctx.session.uploadCustomCountAttempts ?? 0) + 1;
    ctx.session.uploadCustomCountAttempts = attempts;
    if (attempts < 2) {
      await ctx.reply(t(ctx.lang(), "upload.typeNumberHint"));
      return;
    }
    await ctx.reply(t(ctx.lang(), "upload.customCountFallbackToButtons"));
    await transitionToWaitingCount(ctx);
    return;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CUSTOM_QUESTION_COUNT) {
    const attempts = (ctx.session.uploadCustomCountAttempts ?? 0) + 1;
    ctx.session.uploadCustomCountAttempts = attempts;
    if (attempts < 2) {
      await ctx.reply(t(ctx.lang(), "upload.invalidCount"));
      return;
    }
    await ctx.reply(t(ctx.lang(), "upload.customCountFallbackToButtons"));
    await transitionToWaitingCount(ctx);
    return;
  }

  logger.info("Question count selected", { event: "upload.config.questionCount", userId: ctx.from?.id, count: parsed });
  ctx.session.questionCount = parsed;
  ctx.session.uploadCustomCountAttempts = undefined;
  await transitionToWaitingTypes(ctx);
};

// ---------------------------------------------------------------------------
// Step: waiting_shuffle
// ---------------------------------------------------------------------------

const transitionToWaitingShuffle = async (ctx: BotContext): Promise<void> => {
  ctx.session.uploadStep = "waiting_shuffle";
  const defaultChoice = getShuffleChoice(
    ctx.user?.defaultShuffleQuestions ?? false,
    ctx.user?.defaultShuffleOptions ?? false
  );
  await ctx.reply(t(ctx.lang(), "upload.shuffle.prompt"), {
    reply_markup: buildShuffleKeyboard(ctx.lang(), defaultChoice)
  });
};

const handleWaitingShuffle = async (ctx: BotContext): Promise<void> => {
  const data = ctx.callbackQuery?.data;

  if (!data?.startsWith(SHUFFLE_CALLBACK_PREFIX)) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    await ctx.reply(t(ctx.lang(), "upload.useShuffleButtons"));
    return;
  }

  await ctx.answerCallbackQuery();
  const choice = data.slice(SHUFFLE_CALLBACK_PREFIX.length);

  ctx.session.shuffleQuestions = choice === "both" || choice === "questions";
  ctx.session.shuffleOptions = choice === "both";

  logger.info("Shuffle preference selected", { event: "upload.config.shuffle", userId: ctx.from?.id, choice });
  await transitionToWaitingTimer(ctx);
};

// ---------------------------------------------------------------------------
// Step: waiting_timer
// ---------------------------------------------------------------------------

const transitionToWaitingTimer = async (ctx: BotContext): Promise<void> => {
  ctx.session.uploadStep = "waiting_timer";
  await ctx.reply(t(ctx.lang(), "upload.timer.prompt"), {
    reply_markup: buildTimerKeyboard(ctx.lang(), ctx.user?.defaultTimeLimitSeconds)
  });
};

const handleWaitingTimer = async (ctx: BotContext): Promise<void> => {
  const data = ctx.callbackQuery?.data;

  if (!data?.startsWith(TIMER_CALLBACK_PREFIX)) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    return;
  }

  await ctx.answerCallbackQuery();
  const seconds = Number(data.slice(TIMER_CALLBACK_PREFIX.length));
  ctx.session.timeLimitSeconds = seconds;

  logger.info("Timer preference selected", { event: "upload.config.timer", userId: ctx.from?.id, timeLimitSeconds: seconds });
  await transitionToWaitingTitle(ctx);
};

// ---------------------------------------------------------------------------
// Step: waiting_title
// ---------------------------------------------------------------------------

const buildTitleSkipKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "upload.title.skip"), TITLE_SKIP_CALLBACK)
    .text(t(lang, "btn.back"), `${UPLOAD_NAV_CALLBACK_PREFIX}timer`)
    .row()
    .text(t(lang, "upload.title.cancel_btn"), TITLE_CANCEL_CALLBACK);

const transitionToWaitingTitle = async (ctx: BotContext): Promise<void> => {
  ctx.session.uploadStep = "waiting_title";
  const lang = ctx.lang();
  let prompt = t(lang, "upload.title.prompt");

  if (ctx.user) {
    const recentTests = await testRepository.findByCreatorPaginated(ctx.user._id, 1, 1);
    const recentTitle = recentTests[0]?.title?.trim();
    if (recentTitle) {
      prompt = `${prompt}\n\n${t(lang, "upload.title.recentHint", { title: recentTitle })}`;
    }
  }

  await ctx.reply(prompt, { reply_markup: buildTitleSkipKeyboard(lang) });
};

const handleWaitingTitle = async (ctx: BotContext): Promise<void> => {
  if (ctx.callbackQuery?.data === TITLE_CANCEL_CALLBACK) {
    await ctx.answerCallbackQuery();
    await showUploadCancelled(ctx);
    return;
  }

  if (ctx.callbackQuery?.data === TITLE_SKIP_CALLBACK) {
    await ctx.answerCallbackQuery();
    ctx.session.editingTitle = undefined;
    logger.info("Title skipped", { event: "upload.config.title_skipped", userId: ctx.from?.id });
    await runGeneration(ctx);
    return;
  }

  const text = ctx.msg?.text?.trim();
  if (!text) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    return;
  }

  if (text.length > 100) {
    await ctx.reply(t(ctx.lang(), "upload.title.too_long"));
    return;
  }

  ctx.session.editingTitle = text;
  logger.info("Title set", { event: "upload.config.title_set", userId: ctx.from?.id, titleLength: text.length });
  await runGeneration(ctx);
};

// ---------------------------------------------------------------------------
// Step: waiting_types
// ---------------------------------------------------------------------------

const handleWaitingTypes = async (ctx: BotContext): Promise<void> => {
  const data = ctx.callbackQuery?.data;

  if (!data?.startsWith(QUESTION_TYPES_CALLBACK_PREFIX) && data !== QUESTION_TYPES_CONFIRM_CALLBACK) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    await ctx.reply(t(ctx.lang(), "upload.useTypeButtons"));
    return;
  }

  await ctx.answerCallbackQuery();

  if (data === QUESTION_TYPES_CONFIRM_CALLBACK) {
    const selectedTypes = ctx.session.questionTypes ?? [];
    if (selectedTypes.length === 0) {
      await ctx.reply(t(ctx.lang(), "upload.selectAtLeastOneType"));
      return;
    }

    logger.info("Question types selected", { event: "upload.config.questionTypes", userId: ctx.from?.id, types: selectedTypes });
    await transitionToWaitingShuffle(ctx);
    return;
  }

  const type = data.slice(QUESTION_TYPES_CALLBACK_PREFIX.length) as QuestionType;
  const currentTypes = new Set<QuestionType>(ctx.session.questionTypes ?? []);
  if (currentTypes.has(type)) {
    currentTypes.delete(type);
  } else {
    currentTypes.add(type);
  }
  ctx.session.questionTypes = [...currentTypes];

  const messageId = ctx.session.uploadTypesMessageId;
  if (messageId) {
    await ctx.api.editMessageReplyMarkup(ctx.chatId!, messageId, {
      reply_markup: buildQuestionTypesKeyboard(
        ctx.session.questionTypes,
        ctx.lang(),
        ctx.user?.defaultQuestionTypes as QuestionType[] | undefined
      )
    });
  }
};

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const runGeneration = async (
  ctx: BotContext,
  isRetry = false,
  completionMode: "menu" | "start" = "menu"
): Promise<void> => {
  const { uploadedFiles, uploadedText, uploadSourceType, questionCount, questionTypes } = ctx.session;
  const lang = ctx.lang();

  if (!questionCount || !questionTypes?.length) {
    throw new ValidationError("Upload session is missing data required for generation", "UPLOAD_SESSION_INCOMPLETE");
  }

  let input: GenerateQuestionsInput;

  if (uploadSourceType === "text") {
    if (!uploadedText) {
      throw new ValidationError("Upload session is missing text data for generation", "UPLOAD_SESSION_INCOMPLETE");
    }
    input = { content: { type: "text", text: uploadedText }, questionCount, questionTypes };
  } else {
    if (!uploadedFiles?.length) {
      throw new ValidationError("Upload session is missing file data for generation", "UPLOAD_SESSION_INCOMPLETE");
    }
    // Resolve base64 data from Redis for all uploaded files
    const base64Entries = await Promise.all(uploadedFiles.map((f) => getUploadData(ctx.redis, f.storageKey)));
    if (base64Entries.some((b) => b === null)) {
      await ctx.reply(t(lang, "upload.expired"), {
        reply_markup: buildUploadCancelledKeyboard(lang)
      });
      resetSession(ctx.session);
      return;
    }
    const filesWithData: ResolvedFile[] = uploadedFiles.map((file, i) => ({ ...file, base64: base64Entries[i]! }));
    input = buildGenerateInput(filesWithData, questionCount, questionTypes);
  }

  await ctx.replyWithChatAction("typing");
  const thinkingMsg = await ctx.reply(isRetry ? t(lang, "upload.retry.retrying") : t(lang, "upload.generating"));

  const startedAt = Date.now();
  logger.info("AI generation started", {
    event: "ai.generation.start",
    userId: ctx.from?.id,
    provider: config.AI_PROVIDER,
    questionCount,
    types: questionTypes
  });

  try {
    await assertGenerationRateLimit(ctx);
    const generatedQuestions = await generateWithFallback(input, async () => {
      await ctx.reply(t(lang, "upload.ai_fallback"));
    });
    const questions = generatedQuestions.slice(0, questionCount);

    if (questions.length < questionCount) {
      logger.warn("AI generation returned fewer questions than requested", {
        event: "ai.generation.partial",
        userId: ctx.from?.id,
        requested: questionCount,
        received: questions.length
      });
    }

    logger.info("AI generation succeeded", {
      event: "ai.generation.success",
      userId: ctx.from?.id,
      questionsReturned: questions.length,
      durationMs: Date.now() - startedAt
    });
    recordAIGeneration(true, Date.now() - startedAt);

    ctx.session.draftQuestions = questions;
    ctx.session.reviewIndex = 0;
    ctx.session.uploadStep = completionMode === "start" ? undefined : "waiting_action";
    ctx.session.uploadTypesMessageId = undefined;
    if (uploadSourceType !== "text") {
      ctx.session.uploadSourceType = uploadedFiles![0]?.type === "pdf" ? "pdf" : "images";
    }
    // Keep uploadedFiles/uploadedText in session — review flow may need them for regeneration.
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    logger.error("AI generation failed", {
      event: "ai.generation.failed",
      userId: ctx.from?.id,
      error: error instanceof Error ? error.message : String(error)
    });
    recordAIGeneration(false, durationMs);

    ctx.session.uploadStep = "waiting_retry";
    const failure = mapGenerationError(error, lang);
    const retryMessage = await ctx.reply(failure.message, {
      reply_markup: buildRetryKeyboard(lang, failure.retryLabel)
    });

    if (failure.isRateLimit) {
      scheduleRateLimitRetry(ctx, retryMessage.message_id, lang);
    }
  } finally {
    await ctx.api.deleteMessage(ctx.chatId!, thinkingMsg.message_id).catch(() => undefined);
  }

  if (completionMode === "start" && ctx.session.draftQuestions?.length) {
    const testId = await persistDraftTest(ctx, lang);
    if (!testId) return;

    ctx.session.activeTestId = testId;
    ctx.session.draftQuestions = [];
    logger.info("Test started from upload fast path", {
      event: "upload.fast_path.start",
      userId: ctx.from?.id,
      testId
    });
    await enterTestFlow(ctx, testId);
    return;
  }

  if (ctx.session.uploadStep === "waiting_action") {
    const questions = ctx.session.draftQuestions ?? [];
    const total = questions.length;

    // Build type-count map
    const typeCounts = new Map<string, number>();
    for (const q of questions) {
      typeCounts.set(q.type, (typeCounts.get(q.type) ?? 0) + 1);
    }

    let readyLine: string;
    if (typeCounts.size === 1) {
      const [[type]] = [...typeCounts.entries()];
      const typeLabel = t(lang, `upload.type.${type}` as Parameters<typeof t>[1]);
      readyLine = t(lang, "upload.action.ready_single", { count: total, type: typeLabel });
    } else {
      const breakdown = [...typeCounts.entries()]
        .map(([type, count]) => `${count} ${t(lang, `upload.type.${type}` as Parameters<typeof t>[1])}`)
        .join(", ");
      readyLine = t(lang, "upload.action.ready_mixed", { count: total, breakdown });
    }

    const text = [
      readyLine,
      "━━━━━━━━━━━━━━━━",
      t(lang, "upload.action.prompt"),
      "",
      t(lang, "upload.action.start_desc"),
      t(lang, "upload.action.review_desc"),
      t(lang, "upload.action.save_desc")
    ].join("\n");

    await ctx.reply(text, { reply_markup: buildActionKeyboard(lang) });
  }
};

const cancelRetry = async (ctx: BotContext): Promise<void> => {
  const storageKeys = (ctx.session.uploadedFiles ?? []).map((file) => file.storageKey);
  await deleteAllUploadData(ctx.redis, storageKeys);
  resetSession(ctx.session);
  await ctx.reply(t(ctx.lang(), "upload.retry.cancelled"), {
    reply_markup: buildUploadCancelledKeyboard(ctx.lang())
  });
};

// ---------------------------------------------------------------------------
// Step: waiting_action
// ---------------------------------------------------------------------------

const handleWaitingAction = async (ctx: BotContext): Promise<void> => {
  const data = ctx.callbackQuery?.data;

  if (!data?.startsWith(ACTION_CALLBACK_PREFIX)) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    return;
  }

  await ctx.answerCallbackQuery();
  const action = data.slice(ACTION_CALLBACK_PREFIX.length); // "start" | "review" | "save"
  const lang = ctx.lang();

  if (action === "review") {
    ctx.session.uploadStep = undefined;
    // enterReviewFlow handles the state transition to "reviewing".
    await enterReviewFlow(ctx);
    return;
  }

  const testId = await persistDraftTest(ctx, lang);
  if (!testId) return;

  if (action === "start") {
    ctx.session.activeTestId = testId;
    ctx.session.uploadStep = undefined;
    ctx.session.draftQuestions = [];
    // enterTestFlow handles the state transition to "testing".
    logger.info("Test started from action menu", { event: "upload.action.start", userId: ctx.from?.id, testId });
    await enterTestFlow(ctx, testId);
    return;
  }

  if (action === "save") {
    const testWithCode = await testRepository.ensureShareCode(testId);
    const code = `TEST-${testWithCode.shareCode}`;
    const username = ctx.me.username ?? "your_bot";
    const link = `https://t.me/${username}?start=${code}`;
    const instructions = t(lang, "share.instructions", { code, link });
    logger.info("Test saved and shared from action menu", { event: "upload.action.save", userId: ctx.from?.id, testId });
    resetSession(ctx.session);
    await ctx.reply(t(lang, "upload.action.saveShareCard", { instructions }), {
      reply_markup: buildSavedTestKeyboard(testId, link, lang)
    });
  }
};

// The router needs to know about the "Done" button and additional images
// while still in the file-collection phase. Patch handleWaitingFile to check
// whether files have already been collected.
const _originalHandleWaitingFile = handleWaitingFile;

// Re-export overridden router that handles image collection correctly.
// (We patch the flow: if uploadedFiles is non-empty we're collecting more images.)
export const uploadRouterFull = async (ctx: BotContext): Promise<void> => {
  if (await handleUploadNavigation(ctx)) {
    return;
  }

  const step = ctx.session.uploadStep ?? "waiting_file";
  const hasFiles = (ctx.session.uploadedFiles?.length ?? 0) > 0;

  if (step === "waiting_file") {
    if (hasFiles) {
      // Already collecting images — handle additional uploads or Done button.
      await handleAdditionalImage(ctx);

      // Check if we're now in waiting_count (handleAdditionalImage may have advanced state).
      if (ctx.session.uploadStep === "waiting_count") {
        return;
      }
    } else {
      await _originalHandleWaitingFile(ctx);
    }
    return;
  }

  if (step === "waiting_text") {
    await handleWaitingText(ctx);
    return;
  }

  if (step === "waiting_count") {
    await handleWaitingCount(ctx);
    return;
  }

  if (step === "waiting_preset") {
    await handleWaitingPreset(ctx);
    return;
  }

  if (step === "waiting_count_custom") {
    await handleWaitingCountCustom(ctx);
    return;
  }

  if (step === "waiting_shuffle") {
    await handleWaitingShuffle(ctx);
    return;
  }

  if (step === "waiting_timer") {
    await handleWaitingTimer(ctx);
    return;
  }

  if (step === "waiting_title") {
    await handleWaitingTitle(ctx);
    return;
  }

  if (step === "waiting_action") {
    await handleWaitingAction(ctx);
    return;
  }

  if (step === "waiting_retry") {
    if (ctx.callbackQuery?.data === CANCEL_RETRY_CALLBACK) {
      await ctx.answerCallbackQuery();
      await cancelRetry(ctx);
      return;
    }

    if (ctx.callbackQuery?.data === RETRY_GENERATION_CALLBACK) {
      await ctx.answerCallbackQuery();
      await runGeneration(ctx, true, ctx.session.uploadAutoStart ? "start" : "menu");
      return;
    }

    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery();
    }
    return;
  }

  if (step === "waiting_types") {
    await handleWaitingTypes(ctx);
  }
};

export const registerUploadDeadEndHandlers = (bot: import("grammy").Bot<BotContext>): void => {
  bot.callbackQuery(new RegExp(`^${SAVE_START_CALLBACK_PREFIX}`), async (ctx) => {
    const testId = ctx.callbackQuery.data.slice(SAVE_START_CALLBACK_PREFIX.length);
    await ctx.answerCallbackQuery();
    await enterTestFlow(ctx, testId);
  });
};
