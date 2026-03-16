import type { BotCommand } from "grammy/types";
import { InlineKeyboard, type Bot } from "grammy";
import { TestRepository } from "../../db/repositories/test.repository.js";
import { UserRepository } from "../../db/repositories/user.repository.js";
import { logger } from "../../shared/logger.js";
import { registerHistoryHandler } from "./history.handler.js";
import { registerMyTestsHandler } from "./mytests.handler.js";
import { registerLeaderboardHandler, renderLeaderboard } from "./leaderboard.handler.js";
import { registerGroupHandlers, startGroupQuiz, cancelGroupQuiz } from "./group.handler.js";
import type { BotContext } from "../types.js";
import { resetSession } from "../types.js";
import { enterUploadFlow } from "./upload.handler.js";
import { enterTestFlow } from "./test.handler.js";
import { t, formatQuestionTypes, type Language } from "../../shared/i18n/index.js";
import { TestSessionRepository } from "../../db/repositories/test-session.repository.js";
import { userCache } from "../middlewares/userMiddleware.js";

const commands: BotCommand[] = [
  { command: "start", description: "Start the bot and open a shared test" },
  { command: "newtest", description: "Create a new test from text, PDF, or images" },
  { command: "join", description: "Join a shared test using a share code" },
  { command: "mytests", description: "List tests you created" },
  { command: "history", description: "View your past test sessions" },
  { command: "leaderboard", description: "View leaderboard for a test by share code" },
  { command: "language", description: "Change language / Tilni o'zgartirish" },
  { command: "cancel", description: "Cancel the current flow and reset progress" },
  { command: "help", description: "Show available commands" }
];

const JOIN_AWAITING_CODE = "__awaiting_join_code__";
const JOIN_START_CALLBACK_PREFIX = "join:start:";
const JOIN_CANCEL_CALLBACK = "join:cancel";
const LANG_CALLBACK_PREFIX = "lang:";
const testRepository = new TestRepository();
const userRepository = new UserRepository();
const testSessionRepository = new TestSessionRepository();

const normalizeShareCode = (value: string | undefined): string | undefined => {
  const code = value?.trim().toUpperCase().replace(/^TEST-/, "");
  return code ? code : undefined;
};

const isShareCode = (value: string | undefined): value is string => Boolean(value && /^[A-Z0-9]{6}$/.test(value));

const buildPreviewKeyboard = (testId: string, lang: ReturnType<BotContext["lang"]>): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "commands.btn.startTest"), `${JOIN_START_CALLBACK_PREFIX}${testId}`)
    .text(t(lang, "btn.cancel"), JOIN_CANCEL_CALLBACK);

const showTestPreview = async (ctx: BotContext, testId: string): Promise<void> => {
  const lang = ctx.lang();
  const test = await testRepository.findById(testId);
  if (!test || !test.isActive) {
    await ctx.reply(t(lang, "commands.testLinkInvalid"));
    return;
  }

  const creator = await userRepository.findById(test.creatorId);
  const creatorLabel = creator?.username ? `@${creator.username}` : t(lang, "common.unknownCreator");
  const title = test.title?.trim() || t(lang, "common.untitledTest");
  const questionTypes = formatQuestionTypes(test.questions.map((question) => question.type), lang);

  await ctx.reply(
    [
      t(lang, "commands.testPreview.title", { title }),
      t(lang, "commands.testPreview.questions", { n: test.questions.length }),
      t(lang, "commands.testPreview.types", { types: questionTypes }),
      t(lang, "commands.testPreview.creator", { creator: creatorLabel })
    ].join("\n"),
    { reply_markup: buildPreviewKeyboard(String(test._id), lang) }
  );
};

const previewSharedTest = async (ctx: BotContext, shareCode: string): Promise<void> => {
  const test = await testRepository.findByShareCode(shareCode);
  if (!test) {
    await ctx.reply(t(ctx.lang(), "commands.testLinkInvalid"));
    return;
  }

  await showTestPreview(ctx, String(test._id));
};

const buildLanguageKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "language.btn.en"), `${LANG_CALLBACK_PREFIX}en`)
    .text(t(lang, "language.btn.uz"), `${LANG_CALLBACK_PREFIX}uz`);

const handleJoinByCode = async (ctx: BotContext, raw: string): Promise<void> => {
  const shareCode = normalizeShareCode(raw);
  if (!isShareCode(shareCode)) {
    ctx.session.pendingJoinCode = JOIN_AWAITING_CODE;
    await ctx.reply(t(ctx.lang(), "commands.joinPromptCode"));
    return;
  }
  ctx.session.pendingJoinCode = undefined;
  await previewSharedTest(ctx, shareCode);
};

export const registerCommandHandlers = async (bot: Bot<BotContext>): Promise<void> => {
  await bot.api.setMyCommands(commands);

  bot.command("start", async (ctx) => {
    const payload = (ctx.match as string | undefined) ?? ctx.message?.text?.split(" ")[1];
    logger.info("Start command received", {
      event: "command.start",
      userId: ctx.from?.id,
      hasDeepLink: Boolean(payload?.startsWith("TEST-"))
    });

    if (ctx.session.state === "testing") {
      if (ctx.session.sessionId) {
        await testSessionRepository.abandon(ctx.session.sessionId);
      }
      if (ctx.session.testSubState !== "completed") {
        await import("../middlewares/rateLimitMiddleware.js").then(({ releaseActiveTestSessionSlot }) =>
          releaseActiveTestSessionSlot(ctx)
        );
      }
    }

    resetSession(ctx.session);

    if (payload?.startsWith("TEST-")) {
      return handleJoinByCode(ctx, payload);
    }

    await ctx.reply(t(ctx.lang(), "commands.welcome"));
  });

  bot.command("newtest", async (ctx) => {
    logger.info("New test command received", {
      event: "command.newtest",
      userId: ctx.from?.id
    });
    await enterUploadFlow(ctx);
  });

  bot.command("join", async (ctx) => {
    const raw = typeof ctx.match === "string" ? ctx.match : undefined;
    logger.info("Join command received", {
      event: "command.join",
      userId: ctx.from?.id,
      code: raw ?? null
    });

    // In group chats, /join starts a group quiz instead of a private test
    const chatType = ctx.chat?.type;
    if (chatType === "group" || chatType === "supergroup") {
      if (!raw) {
        await ctx.reply(t(ctx.lang(), "commands.joinPromptCode"));
        return;
      }
      const shareCode = normalizeShareCode(raw);
      if (!isShareCode(shareCode)) {
        await ctx.reply(t(ctx.lang(), "commands.invalidCode"));
        return;
      }
      const test = await testRepository.findByShareCode(shareCode);
      if (!test) {
        await ctx.reply(t(ctx.lang(), "commands.testLinkInvalid"));
        return;
      }
      await startGroupQuiz(ctx, String(test._id));
      return;
    }

    if (!raw) {
      ctx.session.pendingJoinCode = JOIN_AWAITING_CODE;
      await ctx.reply(t(ctx.lang(), "commands.joinPromptCode"));
      return;
    }

    await handleJoinByCode(ctx, raw);
  });

  bot.command("cancel", async (ctx) => {
    logger.info("Cancel command received", {
      event: "command.cancel",
      userId: ctx.from?.id
    });

    // In group chats, /cancel ends the active group quiz
    const chatType = ctx.chat?.type;
    if (chatType === "group" || chatType === "supergroup") {
      await cancelGroupQuiz(String(ctx.chat!.id));
      await ctx.reply(t(ctx.lang(), "commands.cancelled"));
      return;
    }

    if (ctx.session.state === "testing") {
      if (ctx.session.sessionId) {
        await testSessionRepository.abandon(ctx.session.sessionId);
      }
      if (ctx.session.testSubState !== "completed") {
        await import("../middlewares/rateLimitMiddleware.js").then(({ releaseActiveTestSessionSlot }) =>
          releaseActiveTestSessionSlot(ctx)
        );
      }

      const answered = ctx.session.currentQuestionIndex ?? 0;
      const correct = ctx.session.testCorrectCount ?? 0;
      const total = ctx.session.testQuestions?.length ?? 0;

      if (answered > 0 && ctx.session.testCorrectCount !== undefined) {
        const lang = ctx.lang();
        const pct = Math.round((correct / answered) * 100);
        await ctx.reply(
          [
            t(lang, "test.cancelled.summary"),
            t(lang, "test.complete.separator"),
            t(lang, "test.cancelled.answered", { answered, total }),
            t(lang, "test.cancelled.correct", { correct }),
            t(lang, "test.cancelled.score", { pct }),
            t(lang, "test.complete.separator"),
            t(lang, "test.cancelled.not_saved")
          ].join("\n")
        );
        resetSession(ctx.session);
        return;
      }
    }

    resetSession(ctx.session);
    await ctx.reply(t(ctx.lang(), "commands.cancelled"));
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(t(ctx.lang(), "commands.help"));
  });

  bot.command("language", async (ctx) => {
    const lang = ctx.lang();
    logger.info("Language command received", { event: "command.language", userId: ctx.from?.id });
    await ctx.reply(t(lang, "language.prompt"), { reply_markup: buildLanguageKeyboard(lang) });
  });

  bot.callbackQuery(new RegExp(`^${LANG_CALLBACK_PREFIX}(en|uz)$`), async (ctx) => {
    const newLang = ctx.callbackQuery.data.slice(LANG_CALLBACK_PREFIX.length) as Language;
    await ctx.answerCallbackQuery();

    if (ctx.user) {
      await userRepository.updateSettings(ctx.user._id, { language: newLang });
      if (ctx.from) userCache.delete(ctx.from.id);
    }

    ctx.session.language = newLang;
    ctx.lang = () => newLang;

    const confirmKey = newLang === "uz" ? "language.selected.uz" : "language.selected.en";
    await ctx.reply(t(newLang, confirmKey));

    logger.info("Language changed", { event: "command.language.changed", userId: ctx.from?.id, lang: newLang });
  });

  bot.on("message:text", async (ctx, next) => {
    if (ctx.session.pendingJoinCode !== JOIN_AWAITING_CODE) {
      await next();
      return;
    }

    const shareCode = normalizeShareCode(ctx.msg.text);
    if (!isShareCode(shareCode)) {
      await ctx.reply(t(ctx.lang(), "commands.invalidCode"));
      return;
    }

    ctx.session.pendingJoinCode = undefined;
    await previewSharedTest(ctx, shareCode);
  });

  bot.callbackQuery(new RegExp(`^${JOIN_START_CALLBACK_PREFIX}`), async (ctx) => {
    const testId = ctx.callbackQuery.data.slice(JOIN_START_CALLBACK_PREFIX.length);
    await ctx.answerCallbackQuery();
    resetSession(ctx.session);
    await enterTestFlow(ctx, testId);
  });

  bot.callbackQuery(JOIN_CANCEL_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.pendingJoinCode = undefined;
    await ctx.reply(t(ctx.lang(), "commands.joinCancelled"));
  });

  bot.command("leaderboard", async (ctx) => {
    const lang = ctx.lang();
    const raw = typeof ctx.match === "string" ? ctx.match.trim() : undefined;

    if (!raw) {
      await ctx.reply(t(lang, "commands.leaderboardPromptCode"));
      return;
    }

    const shareCode = normalizeShareCode(raw);
    if (!isShareCode(shareCode)) {
      await ctx.reply(t(lang, "commands.invalidCode"));
      return;
    }

    const test = await testRepository.findByShareCode(shareCode);
    if (!test) {
      await ctx.reply(t(lang, "commands.testLinkInvalid"));
      return;
    }

    const { text } = await renderLeaderboard(String(test._id), ctx.user?._id ? String(ctx.user._id) : undefined, lang);
    await ctx.reply(text);
  });

  registerMyTestsHandler(bot);
  registerHistoryHandler(bot);
  registerLeaderboardHandler(bot);
  registerGroupHandlers(bot);
};
