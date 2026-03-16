import type { BotCommand } from "grammy/types";
import { InlineKeyboard, type Bot } from "grammy";
import { TestRepository } from "../../db/repositories/test.repository.js";
import { UserRepository } from "../../db/repositories/user.repository.js";
import { logger } from "../../shared/logger.js";
import { registerHistoryHandler } from "./history.handler.js";
import { registerMyTestsHandler } from "./mytests.handler.js";
import { registerClassesHandler, showClassPreviewFromShareCode, showMyClassesPage } from "./classes.handler.js";
import { registerLeaderboardHandler, renderLeaderboard } from "./leaderboard.handler.js";
import { registerSettingsHandler, buildSettingsPage } from "./settings.handler.js";
import { registerGroupHandlers, startGroupQuiz, cancelGroupQuiz, stopGroupQuiz } from "./group.handler.js";
import type { BotContext } from "../types.js";
import { resetSession } from "../types.js";
import { enterUploadFlow } from "./upload.handler.js";
import { enterTestFlow } from "./test.handler.js";
import { t, formatQuestionTypes, type Language } from "../../shared/i18n/index.js";
import { TestSessionRepository } from "../../db/repositories/test-session.repository.js";
import type { UserStats } from "../../db/repositories/test-session.repository.js";
import { GroupSessionRepository } from "../../db/repositories/group-session.repository.js";
import { userCache } from "../middlewares/userMiddleware.js";
import { safeEditMessage } from "../utils/telegram.js";

const commands: BotCommand[] = [
  { command: "start", description: "Start the bot and open a shared test" },
  { command: "newtest", description: "Create a new test from text, PDF, or images" },
  { command: "join", description: "Join a shared test using a share code" },
  { command: "mytests", description: "List tests you created" },
  { command: "myclasses", description: "Manage your classes of tests" },
  { command: "history", description: "View your past test sessions" },
  { command: "stats", description: "View your overall performance statistics" },
  { command: "settings", description: "Configure your default test preferences" },
  { command: "leaderboard", description: "View leaderboard for a test by share code" },
  { command: "language", description: "Change language / Tilni o'zgartirish" },
  { command: "stop", description: "Stop the current group quiz (group chats only)" },
  { command: "cancel", description: "Cancel the current flow and reset progress" },
  { command: "help", description: "Show available commands" }
];

const JOIN_AWAITING_CODE = "__awaiting_join_code__";
const JOIN_START_CALLBACK_PREFIX = "join:start:";
const JOIN_CANCEL_CALLBACK = "join:cancel";
const NEWTEST_CONFIRM_CALLBACK = "newtest:confirm";
const NEWTEST_CANCEL_CALLBACK = "newtest:cancel";
const LANG_CALLBACK_PREFIX = "lang:";
const START_NEWTEST_CALLBACK = "start:newtest";
const START_JOIN_CALLBACK = "start:join";
const START_LANGUAGE_CALLBACK = "start:language";
const START_HELP_CALLBACK = "start:help";
const START_STATS_CALLBACK = "start:stats";
const START_SETTINGS_CALLBACK = "start:settings";
const START_CLASSES_CALLBACK = "start:classes";
const testRepository = new TestRepository();
const userRepository = new UserRepository();
const testSessionRepository = new TestSessionRepository();
const groupSessionRepository = new GroupSessionRepository();

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

  const lines = [
    t(lang, "commands.testPreview.title", { title }),
    t(lang, "commands.testPreview.questions", { n: test.questions.length }),
    t(lang, "commands.testPreview.types", { types: questionTypes }),
    t(lang, "commands.testPreview.creator", { creator: creatorLabel })
  ];

  // Only show the private-chat note when we're actually in a private chat
  if (ctx.chat?.type === "private") {
    lines.push("", t(lang, "join.taking_privately"));
  }

  await ctx.reply(lines.join("\n"), { reply_markup: buildPreviewKeyboard(String(test._id), lang) });
};

const previewSharedTest = async (ctx: BotContext, shareCode: string): Promise<void> => {
  const test = await testRepository.findByShareCode(shareCode);
  if (!test) {
    await ctx.reply(t(ctx.lang(), "commands.testLinkInvalid"));
    return;
  }

  await showTestPreview(ctx, String(test._id));
};

const buildWelcomeKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "start.btn.newtest"), START_NEWTEST_CALLBACK)
    .text(t(lang, "start.btn.join"), START_JOIN_CALLBACK)
    .row()
    .text(t(lang, "start.btn.stats"), START_STATS_CALLBACK)
    .text(t(lang, "start.btn.settings"), START_SETTINGS_CALLBACK)
    .row()
    .text(t(lang, "start.btn.classes"), START_CLASSES_CALLBACK)
    .text(t(lang, "start.btn.language"), START_LANGUAGE_CALLBACK)
    .row()
    .text(t(lang, "start.btn.help"), START_HELP_CALLBACK);

const buildStatsMessage = (stats: UserStats, testsCreated: number, lang: Language): string => {
  if (stats.totalTests === 0) {
    return t(lang, "stats.empty");
  }

  const SEP = t(lang, "test.complete.separator");
  return [
    t(lang, "stats.title"),
    SEP,
    t(lang, "stats.total_tests", { count: stats.totalTests }),
    t(lang, "stats.total_questions", { count: stats.totalQuestions }),
    t(lang, "stats.total_correct", { count: stats.totalCorrect }),
    t(lang, "stats.average_score", { score: stats.averageScore }),
    t(lang, "stats.best_score", { score: stats.bestScore }),
    t(lang, "stats.this_week", { count: stats.testsThisWeek }),
    SEP,
    t(lang, "stats.tests_created", { count: testsCreated })
  ].join("\n");
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

    if (ctx.shouldPromptLanguage) {
      if (payload?.startsWith("TEST-")) {
        ctx.session.pendingJoinCode = normalizeShareCode(payload);
      }
      ctx.session.awaitingLangForWelcome = true;
      const prompt = `${t("en", "language.auto_prompt")}\n${t("uz", "language.auto_prompt_uz")}`;
      await ctx.reply(prompt, { reply_markup: buildLanguageKeyboard(ctx.lang()) });
      return;
    }

    if (payload?.startsWith("TEST-")) {
      return handleJoinByCode(ctx, payload);
    }

    if (payload?.startsWith("CLASS-")) {
      return showClassPreviewFromShareCode(ctx, payload);
    }

    const lang = ctx.lang();

    const text = ctx.isNewUser
      ? t(lang, "start.welcome_new", { name: ctx.from?.first_name ?? "" })
      : t(lang, "start.welcome_returning");
    await ctx.reply(text, { reply_markup: buildWelcomeKeyboard(lang) });
  });

  bot.command("newtest", async (ctx) => {
    const lang = ctx.lang();

    if (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") {
      const kb = new InlineKeyboard().url(
        t(lang, "newtest.open_private_chat"),
        `https://t.me/${ctx.me.username}`
      );
      await ctx.reply(t(lang, "newtest.groups_not_allowed"), { reply_markup: kb });
      return;
    }

    logger.info("New test command received", {
      event: "command.newtest",
      userId: ctx.from?.id,
      state: ctx.session.state
    });

    const state = ctx.session.state;

    if (state === "uploading" || state === "configuring") {
      const kb = new InlineKeyboard()
        .text(t(lang, "newtest.confirm_yes"), NEWTEST_CONFIRM_CALLBACK)
        .text(t(lang, "newtest.confirm_no"), NEWTEST_CANCEL_CALLBACK);
      await ctx.reply(t(lang, "newtest.confirm_reset_upload"), { reply_markup: kb });
      return;
    }

    if (state === "reviewing") {
      const kb = new InlineKeyboard()
        .text(t(lang, "newtest.confirm_yes"), NEWTEST_CONFIRM_CALLBACK)
        .text(t(lang, "newtest.confirm_no"), NEWTEST_CANCEL_CALLBACK);
      await ctx.reply(t(lang, "newtest.confirm_reset_review"), { reply_markup: kb });
      return;
    }

    if (state === "testing") {
      const answered = ctx.session.currentQuestionIndex ?? 0;
      const correct = ctx.session.testCorrectCount ?? 0;
      const kb = new InlineKeyboard()
        .text(t(lang, "newtest.confirm_yes"), NEWTEST_CONFIRM_CALLBACK)
        .text(t(lang, "newtest.confirm_no"), NEWTEST_CANCEL_CALLBACK);
      await ctx.reply(t(lang, "newtest.confirm_reset_test", { answered, correct }), { reply_markup: kb });
      return;
    }

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
      const lang = ctx.lang();
      const title = test.title?.trim() || t(lang, "common.untitledTest");
      await ctx.reply(
        t(lang, "join.group_starting", {
          name: ctx.from?.first_name ?? "Someone",
          title,
          count: test.questions.length
        })
      );
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

    // In group chats, /cancel ends the active group quiz (host-only)
    const chatType = ctx.chat?.type;
    if (chatType === "group" || chatType === "supergroup") {
      const session = await groupSessionRepository.findActiveByChat(String(ctx.chat!.id));
      if (session) {
        if (ctx.from?.id !== Number(session.startedBy)) {
          await ctx.reply(t(ctx.lang(), "group.stop_host_only"));
          return;
        }
        await cancelGroupQuiz(String(ctx.chat!.id));
      }
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

    const lang = ctx.lang();
    const state = ctx.session.state;

    if (state === "uploading") {
      const fileCount = ctx.session.uploadedFiles?.length ?? 0;
      const msg = fileCount > 0
        ? t(lang, "cancel.uploading", { count: fileCount })
        : t(lang, "cancel.uploading_empty");
      resetSession(ctx.session);
      await ctx.reply(msg);
      return;
    }

    if (state === "configuring") {
      resetSession(ctx.session);
      await ctx.reply(t(lang, "cancel.configuring"));
      return;
    }

    if (state === "reviewing") {
      const count = ctx.session.draftQuestions?.length ?? 0;
      resetSession(ctx.session);
      await ctx.reply(t(lang, "cancel.reviewing", { count }));
      return;
    }

    if (state === "editing") {
      resetSession(ctx.session);
      await ctx.reply(t(lang, "cancel.editing"));
      return;
    }

    resetSession(ctx.session);
    await ctx.reply(t(lang, "commands.cancelled"));
  });

  bot.command("stop", async (ctx) => {
    const chatType = ctx.chat?.type;
    if (chatType !== "group" && chatType !== "supergroup") return;
    await stopGroupQuiz(ctx);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(t(ctx.lang(), "commands.help"));
  });

  bot.command("language", async (ctx) => {
    if (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") {
      await ctx.reply(t(ctx.lang(), "cmd.private_only"));
      return;
    }
    const lang = ctx.lang();
    logger.info("Language command received", { event: "command.language", userId: ctx.from?.id });
    await ctx.reply(t(lang, "language.prompt"), { reply_markup: buildLanguageKeyboard(lang) });
  });

  bot.callbackQuery(new RegExp(`^${LANG_CALLBACK_PREFIX}(en|uz)$`), async (ctx) => {
    const newLang = ctx.callbackQuery.data.slice(LANG_CALLBACK_PREFIX.length) as Language;
    await ctx.answerCallbackQuery();

    if (ctx.user) {
      await userRepository.updateSettings(ctx.user._id, { language: newLang, languagePrompted: true });
      if (ctx.from) userCache.delete(ctx.from.id);
    }

    ctx.session.language = newLang;
    ctx.lang = () => newLang;

    const confirmKey = newLang === "uz" ? "language.selected.uz" : "language.selected.en";
    await ctx.reply(t(newLang, confirmKey));

    logger.info("Language changed", { event: "command.language.changed", userId: ctx.from?.id, lang: newLang });

    if (ctx.session.awaitingLangForWelcome) {
      ctx.session.awaitingLangForWelcome = undefined;
      
      if (ctx.session.pendingJoinCode && ctx.session.pendingJoinCode !== JOIN_AWAITING_CODE) {
        const code = ctx.session.pendingJoinCode;
        ctx.session.pendingJoinCode = undefined;
        await previewSharedTest(ctx, code);
        return;
      }

      const text = ctx.isNewUser
        ? t(newLang, "start.welcome_new", { name: ctx.from?.first_name ?? "" })
        : t(newLang, "start.welcome_returning");
      await ctx.reply(text, { reply_markup: buildWelcomeKeyboard(newLang) });
    }

    if (ctx.session.settingsReturnToMenu && ctx.user) {
      ctx.session.settingsReturnToMenu = undefined;
      const { text, keyboard } = await buildSettingsPage(String(ctx.user._id), newLang);
      await safeEditMessage(ctx, text, { reply_markup: keyboard });
    }
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

  bot.callbackQuery(NEWTEST_CONFIRM_CALLBACK, async (ctx) => {
    const lang = ctx.lang();
    if (ctx.session.state === "testing") {
      if (ctx.session.sessionId) {
        await testSessionRepository.abandon(ctx.session.sessionId);
      }
      await import("../middlewares/rateLimitMiddleware.js").then(({ releaseActiveTestSessionSlot }) =>
        releaseActiveTestSessionSlot(ctx)
      );
    }
    resetSession(ctx.session);
    await ctx.answerCallbackQuery();
    await enterUploadFlow(ctx);
  });

  bot.callbackQuery(NEWTEST_CANCEL_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery({ text: t(ctx.lang(), "newtest.cancelled"), show_alert: false });
    await ctx.deleteMessage().catch(() => undefined);
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

  bot.command("stats", async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.reply(t(lang, "error.userLoad"));
      return;
    }
    const [stats, testsCreated] = await Promise.all([
      testSessionRepository.getUserStats(ctx.user._id),
      testRepository.countByCreator(ctx.user._id)
    ]);
    await ctx.reply(buildStatsMessage(stats, testsCreated, lang));
  });

  bot.command("settings", async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.reply(t(lang, "error.userLoad"));
      return;
    }
    const { text, keyboard } = await buildSettingsPage(String(ctx.user._id), lang);
    await ctx.reply(text, { reply_markup: keyboard });
  });

  // Welcome screen button callbacks
  bot.callbackQuery(START_NEWTEST_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery();
    await enterUploadFlow(ctx);
  });

  bot.callbackQuery(START_JOIN_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.pendingJoinCode = JOIN_AWAITING_CODE;
    await ctx.reply(t(ctx.lang(), "commands.joinPromptCode"));
  });

  bot.callbackQuery(START_LANGUAGE_CALLBACK, async (ctx) => {
    const lang = ctx.lang();
    await ctx.answerCallbackQuery();
    await ctx.reply(t(lang, "language.prompt"), { reply_markup: buildLanguageKeyboard(lang) });
  });

  bot.callbackQuery(START_HELP_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(t(ctx.lang(), "commands.help"));
  });

  bot.callbackQuery(START_STATS_CALLBACK, async (ctx) => {
    const lang = ctx.lang();
    await ctx.answerCallbackQuery();
    if (!ctx.user) {
      await ctx.reply(t(lang, "error.userLoad"));
      return;
    }
    const [stats, testsCreated] = await Promise.all([
      testSessionRepository.getUserStats(ctx.user._id),
      testRepository.countByCreator(ctx.user._id)
    ]);
    await ctx.reply(buildStatsMessage(stats, testsCreated, lang));
  });

  bot.callbackQuery(START_SETTINGS_CALLBACK, async (ctx) => {
    const lang = ctx.lang();
    await ctx.answerCallbackQuery();
    if (!ctx.user) {
      await ctx.reply(t(lang, "error.userLoad"));
      return;
    }
    const { text, keyboard } = await buildSettingsPage(String(ctx.user._id), lang);
    await ctx.reply(text, { reply_markup: keyboard });
  });

  bot.callbackQuery(START_CLASSES_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showMyClassesPage(ctx, 1);
  });

  registerMyTestsHandler(bot);
  registerClassesHandler(bot);
  registerHistoryHandler(bot);
  registerLeaderboardHandler(bot);
  registerGroupHandlers(bot);
  registerSettingsHandler(bot);
};
