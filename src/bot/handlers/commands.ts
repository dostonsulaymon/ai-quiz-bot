import type { BotCommand } from "grammy/types";
import { InlineKeyboard, type Bot } from "grammy";
import { TestRepository } from "../../db/repositories/test.repository.js";
import { UserRepository } from "../../db/repositories/user.repository.js";
import { logger } from "../../shared/logger.js";
import { registerHistoryHandler } from "./history.handler.js";
import { registerMyTestsHandler } from "./mytests.handler.js";
import type { BotContext } from "../types.js";
import { REVIEW_CONVERSATION_NAME } from "../scenes/review.scene.js";
import { TEST_CONVERSATION_NAME } from "../scenes/test.scene.js";
import { resetSession } from "../types.js";
import { UPLOAD_CONVERSATION_NAME } from "../scenes/upload.scene.js";

const commands: BotCommand[] = [
  { command: "start", description: "Start the bot and open a shared test" },
  { command: "newtest", description: "Create a new test from text, PDF, or images" },
  { command: "join", description: "Join a shared test using a share code" },
  { command: "mytests", description: "List tests you created" },
  { command: "history", description: "View your past test sessions" },
  { command: "cancel", description: "Cancel the current flow and reset progress" },
  { command: "help", description: "Show available commands" }
];

const helpText = [
  "Available commands:",
  "/start - Welcome message and open a shared test via deep link",
  "/newtest - Start creating a new quiz",
  "/join [CODE] - Join a shared quiz by share code",
  "/mytests - View your created tests (coming soon)",
  "/history - View your completed sessions (coming soon)",
  "/cancel - Reset the current session",
  "/help - Show this help message"
].join("\n");

const JOIN_AWAITING_CODE = "__awaiting_join_code__";
const JOIN_START_CALLBACK_PREFIX = "join:start:";
const JOIN_CANCEL_CALLBACK = "join:cancel";
const testRepository = new TestRepository();
const userRepository = new UserRepository();

const normalizeShareCode = (value: string | undefined): string | undefined => {
  const code = value?.trim().toUpperCase().replace(/^TEST-/, "");
  return code ? code : undefined;
};

const isShareCode = (value: string | undefined): value is string => Boolean(value && /^[A-Z0-9]{6}$/.test(value));

const formatQuestionTypes = (types: string[]): string =>
  [...new Set(types)].map((type) => {
    switch (type) {
      case "mcq":
        return "MCQ";
      case "truefalse":
        return "True/False";
      case "short":
        return "Short";
      case "fill":
        return "Fill";
      default:
        return type;
    }
  }).join(", ");

const buildPreviewKeyboard = (testId: string): InlineKeyboard =>
  new InlineKeyboard()
    .text("▶️ Start Test", `${JOIN_START_CALLBACK_PREFIX}${testId}`)
    .text("❌ Cancel", JOIN_CANCEL_CALLBACK);

const showTestPreview = async (ctx: BotContext, testId: string): Promise<void> => {
  const test = await testRepository.findById(testId);
  if (!test || !test.isActive) {
    await ctx.reply("This test link is expired or invalid ❌");
    return;
  }

  const creator = await userRepository.findById(test.creatorId);
  const creatorLabel = creator?.username ? `@${creator.username}` : "Unknown creator";
  const title = test.title?.trim() || "Untitled Test";
  const questionTypes = formatQuestionTypes(test.questions.map((question) => question.type));

  await ctx.reply(
    [
      `📝 Test: ${title}`,
      `Questions: ${test.questions.length}`,
      `Types: ${questionTypes}`,
      `Created by: ${creatorLabel}`
    ].join("\n"),
    { reply_markup: buildPreviewKeyboard(String(test._id)) }
  );
};

const previewSharedTest = async (ctx: BotContext, shareCode: string): Promise<void> => {
  const test = await testRepository.findByShareCode(shareCode);
  if (!test) {
    await ctx.reply("This test link is expired or invalid ❌");
    return;
  }

  await showTestPreview(ctx, String(test._id));
};

const startPreviewedTest = async (ctx: BotContext, testId: string): Promise<void> => {
  // Exit all conversations before resetting session to avoid stale grammY history.
  // This version of @grammyjs/conversations has no zero-arg exit() overload — call per name.
  await ctx.conversation.exit(UPLOAD_CONVERSATION_NAME);
  await ctx.conversation.exit(REVIEW_CONVERSATION_NAME);
  await ctx.conversation.exit(TEST_CONVERSATION_NAME);
  resetSession(ctx.session);
  ctx.session.activeTestId = testId;
  ctx.session.state = "testing";
  // Ensure leftover sessionId/index from a previous run do not bleed in.
  ctx.session.sessionId = undefined;
  ctx.session.currentQuestionIndex = 0;
  await ctx.conversation.enter(TEST_CONVERSATION_NAME);
};

export const registerCommandHandlers = async (bot: Bot<BotContext>): Promise<void> => {
  await bot.api.setMyCommands(commands);

  bot.command("start", async (ctx) => {
    const deepLinkCode = normalizeShareCode(typeof ctx.match === "string" ? ctx.match : undefined);
    logger.info("Start command received", {
      event: "command.start",
      userId: ctx.from?.id,
      hasDeepLink: isShareCode(deepLinkCode)
    });

    resetSession(ctx.session);

    if (isShareCode(deepLinkCode)) {
      await previewSharedTest(ctx, deepLinkCode);
      return;
    }

    await ctx.reply(
      "Welcome to Quiz Bot.\nUse /newtest to create a quiz or /join SHARECODE to take a shared one."
    );
  });

  bot.command("newtest", async (ctx) => {
    logger.info("New test command received", {
      event: "command.newtest",
      userId: ctx.from?.id
    });
    // Exit all active conversations before resetting state so grammY can clean
    // up its internal conversation history before we wipe the session.
    await ctx.conversation.exit(UPLOAD_CONVERSATION_NAME);
    await ctx.conversation.exit(REVIEW_CONVERSATION_NAME);
    await ctx.conversation.exit(TEST_CONVERSATION_NAME);
    resetSession(ctx.session);
    await ctx.conversation.enter(UPLOAD_CONVERSATION_NAME);
    // NOTE: the previous code checked ctx.session.state === "reviewing" here,
    // but resetSession() just set state to "idle", so that branch was dead code.
    // Removed to avoid confusion.
  });

  bot.command("join", async (ctx) => {
    const shareCode = normalizeShareCode(typeof ctx.match === "string" ? ctx.match : undefined);
    logger.info("Join command received", {
      event: "command.join",
      userId: ctx.from?.id,
      code: shareCode ?? null
    });

    if (!isShareCode(shareCode)) {
      ctx.session.pendingJoinCode = JOIN_AWAITING_CODE;
      await ctx.reply("Send me the 6-character share code.");
      return;
    }

    ctx.session.pendingJoinCode = undefined;
    await previewSharedTest(ctx, shareCode);
  });

  bot.command("cancel", async (ctx) => {
    logger.info("Cancel command received", {
      event: "command.cancel",
      userId: ctx.from?.id
    });
    // Exit all active conversations first so grammY clears its history, then
    // reset the session — if the order is reversed, the session is wiped before
    // the conversation exit logic can reference it.
    await ctx.conversation.exit(UPLOAD_CONVERSATION_NAME);
    await ctx.conversation.exit(REVIEW_CONVERSATION_NAME);
    await ctx.conversation.exit(TEST_CONVERSATION_NAME);
    resetSession(ctx.session);
    await ctx.reply("Your current flow has been cancelled and your session is back to idle.");
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpText);
  });

  bot.on("message:text", async (ctx, next) => {
    if (ctx.session.pendingJoinCode !== JOIN_AWAITING_CODE) {
      await next();
      return;
    }

    const shareCode = normalizeShareCode(ctx.msg.text);
    if (!isShareCode(shareCode)) {
      await ctx.reply("That code doesn't look right. Please send a 6-character code like ABC123.");
      return;
    }

    ctx.session.pendingJoinCode = undefined;
    await previewSharedTest(ctx, shareCode);
  });

  bot.callbackQuery(new RegExp(`^${JOIN_START_CALLBACK_PREFIX}`), async (ctx) => {
    const testId = ctx.callbackQuery.data.slice(JOIN_START_CALLBACK_PREFIX.length);
    await ctx.answerCallbackQuery();
    await startPreviewedTest(ctx, testId);
  });

  bot.callbackQuery(JOIN_CANCEL_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.pendingJoinCode = undefined;
    await ctx.reply("Join cancelled.");
  });

  registerMyTestsHandler(bot);
  registerHistoryHandler(bot);
};
