import { InlineKeyboard, type Bot } from "grammy";
import { TestRepository } from "../../db/repositories/test.repository.js";
import { TestSessionRepository } from "../../db/repositories/test-session.repository.js";
import type { BotContext } from "../types.js";
import { REVIEW_CONVERSATION_NAME } from "../scenes/review.scene.js";
import { TEST_CONVERSATION_NAME } from "../scenes/test.scene.js";
import { resetSession } from "../types.js";
import { UPLOAD_CONVERSATION_NAME } from "../scenes/upload.scene.js";

const MYTESTS_PAGE_SIZE = 5;
const MYTESTS_PAGE_CALLBACK_PREFIX = "mytests:page:";
const MYTESTS_SHARE_CALLBACK_PREFIX = "mytests:share:";
const MYTESTS_DELETE_CALLBACK_PREFIX = "mytests:delete:";
const MYTESTS_DELETE_CONFIRM_CALLBACK_PREFIX = "mytests:delete:confirm:";
const MYTESTS_DELETE_CANCEL_CALLBACK_PREFIX = "mytests:delete:cancel:";
const MYTESTS_TAKE_CALLBACK_PREFIX = "mytests:take:";
const MYTESTS_PREVIEW_CALLBACK_PREFIX = "mytests:preview:";
const MYTESTS_BACK_CALLBACK_PREFIX = "mytests:back:";
const MYTESTS_NOOP_CALLBACK = "mytests:noop";

const testRepository = new TestRepository();
const testSessionRepository = new TestSessionRepository();

const formatDate = (value: Date | string | undefined): string =>
  value
    ? new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric"
      }).format(new Date(value))
    : "Unknown date";

const formatQuestionTypes = (types: string[]): string =>
  [...new Set(types)].map((type) => {
    switch (type) {
      case "mcq":
        return "MCQ";
      case "truefalse":
        return "T/F";
      case "short":
        return "Short";
      case "fill":
        return "Fill";
      default:
        return type;
    }
  }).join(", ");

const buildPaginationRow = (page: number, totalPages: number): InlineKeyboard =>
  new InlineKeyboard()
    .text("◀", `${MYTESTS_PAGE_CALLBACK_PREFIX}${Math.max(1, page - 1)}`)
    .text(`Page ${page}/${totalPages}`, MYTESTS_NOOP_CALLBACK)
    .text("▶", `${MYTESTS_PAGE_CALLBACK_PREFIX}${Math.min(totalPages, page + 1)}`);

const renderMyTestsPage = async (userId: string, page: number): Promise<{ text: string; keyboard: InlineKeyboard }> => {
  const totalItems = await testRepository.countByCreator(userId);
  if (totalItems === 0) {
    return {
      text: "You haven’t created any tests yet.",
      keyboard: new InlineKeyboard().text("Page 1/1", MYTESTS_NOOP_CALLBACK)
    };
  }

  const totalPages = Math.max(1, Math.ceil(totalItems / MYTESTS_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const tests = await testRepository.findByCreatorPaginated(userId, currentPage, MYTESTS_PAGE_SIZE);
  const takeCounts = await Promise.all(tests.map((test) => testSessionRepository.countByTestId(test._id)));

  const lines = tests.flatMap((test, index) => [
    `${index + 1}. 📝 ${test.title?.trim() || "Untitled"}  •  ${test.questions.length} questions  •  ${formatQuestionTypes(test.questions.map((question) => question.type))}`,
    `👥 Taken ${takeCounts[index] ?? 0} times  •  📅 ${formatDate(test.createdAt)}`,
    ""
  ]);

  const keyboard = new InlineKeyboard();
  tests.forEach((test, index) => {
    const testId = String(test._id);
    keyboard
      .text(`▶️ Take ${index + 1}`, `${MYTESTS_TAKE_CALLBACK_PREFIX}${testId}`)
      .text("📤 Share", `${MYTESTS_SHARE_CALLBACK_PREFIX}${testId}:${currentPage}`)
      .text("🗑️ Delete", `${MYTESTS_DELETE_CALLBACK_PREFIX}${testId}:${currentPage}`)
      .row()
      .text("👁 Preview", `${MYTESTS_PREVIEW_CALLBACK_PREFIX}${testId}:${currentPage}`)
      .row();
  });

  keyboard.append(buildPaginationRow(currentPage, totalPages));

  return {
    text: ["Your Tests", "", ...lines].join("\n").trim(),
    keyboard
  };
};

const renderPreview = async (testId: string, page: number): Promise<{ text: string; keyboard: InlineKeyboard }> => {
  const test = await testRepository.findById(testId);
  if (!test || !test.isActive) {
    return {
      text: "This test is no longer available.",
      keyboard: new InlineKeyboard().text("◀ Back", `${MYTESTS_BACK_CALLBACK_PREFIX}${page}`)
    };
  }

  return {
    text: [
      `📝 Test: ${test.title?.trim() || "Untitled Test"}`,
      `Questions: ${test.questions.length}`,
      `Types: ${formatQuestionTypes(test.questions.map((question) => question.type))}`
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text("▶️ Take Test", `${MYTESTS_TAKE_CALLBACK_PREFIX}${testId}`)
      .text("◀ Back", `${MYTESTS_BACK_CALLBACK_PREFIX}${page}`)
  };
};

const renderShareView = async (testId: string, page: number, botUsername?: string): Promise<{ text: string; keyboard: InlineKeyboard }> => {
  const test = await testRepository.ensureShareCode(testId);
  const code = `TEST-${test.shareCode}`;
  const link = `https://t.me/${botUsername ?? "your_bot"}?start=${code}`;

  return {
    text: `Share this test:\nCode: ${code}\nLink: ${link}`,
    keyboard: new InlineKeyboard()
      .url("📋 Copy link", link)
      .row()
      .text("◀ Back", `${MYTESTS_BACK_CALLBACK_PREFIX}${page}`)
  };
};

const renderDeleteConfirm = async (testId: string, page: number): Promise<{ text: string; keyboard: InlineKeyboard }> => {
  const test = await testRepository.findById(testId);

  return {
    text: `Delete "${test?.title?.trim() || "Untitled Test"}"? This will hide it from future joins and listings.`,
    keyboard: new InlineKeyboard()
      .text("✅ Confirm delete", `${MYTESTS_DELETE_CONFIRM_CALLBACK_PREFIX}${testId}:${page}`)
      .text("❌ Cancel", `${MYTESTS_DELETE_CANCEL_CALLBACK_PREFIX}${page}`)
  };
};

const startOwnedTest = async (ctx: BotContext, testId: string): Promise<void> => {
  // Exit all conversations before resetting session to avoid stale grammY history.
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

export const registerMyTestsHandler = (bot: Bot<BotContext>): void => {
  bot.command("mytests", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("I couldn't load your account right now.");
      return;
    }

    const totalItems = await testRepository.countByCreator(ctx.user._id);
    if (totalItems === 0) {
      await ctx.reply("You haven’t created any tests yet.");
      return;
    }

    const { text, keyboard } = await renderMyTestsPage(String(ctx.user._id), 1);
    await ctx.reply(text, { reply_markup: keyboard });
  });

  bot.callbackQuery(new RegExp(`^${MYTESTS_PAGE_CALLBACK_PREFIX}`), async (ctx) => {
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: "User session missing.", show_alert: false });
      return;
    }

    const page = Number(ctx.callbackQuery.data.slice(MYTESTS_PAGE_CALLBACK_PREFIX.length));
    const { text, keyboard } = await renderMyTestsPage(String(ctx.user._id), page);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, { reply_markup: keyboard });
  });

  bot.callbackQuery(new RegExp(`^${MYTESTS_PREVIEW_CALLBACK_PREFIX}`), async (ctx) => {
    const payload = ctx.callbackQuery.data.slice(MYTESTS_PREVIEW_CALLBACK_PREFIX.length);
    const [testId, pageValue] = payload.split(":");
    const { text, keyboard } = await renderPreview(testId ?? "", Number(pageValue ?? "1"));
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, { reply_markup: keyboard });
  });

  bot.callbackQuery(new RegExp(`^${MYTESTS_SHARE_CALLBACK_PREFIX}`), async (ctx) => {
    const payload = ctx.callbackQuery.data.slice(MYTESTS_SHARE_CALLBACK_PREFIX.length);
    const [testId, pageValue] = payload.split(":");
    const { text, keyboard } = await renderShareView(testId ?? "", Number(pageValue ?? "1"), ctx.me.username);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, { reply_markup: keyboard });
  });

  bot.callbackQuery(/^mytests:delete:[^:]+:\d+$/, async (ctx) => {
    const payload = ctx.callbackQuery.data.slice(MYTESTS_DELETE_CALLBACK_PREFIX.length);
    const [testId, pageValue] = payload.split(":");
    const { text, keyboard } = await renderDeleteConfirm(testId ?? "", Number(pageValue ?? "1"));
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, { reply_markup: keyboard });
  });

  bot.callbackQuery(/^mytests:delete:confirm:[^:]+:\d+$/, async (ctx) => {
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: "User session missing.", show_alert: false });
      return;
    }

    const payload = ctx.callbackQuery.data.slice(MYTESTS_DELETE_CONFIRM_CALLBACK_PREFIX.length);
    const [testId, pageValue] = payload.split(":");
    await testRepository.softDelete(testId ?? "");
    const { text, keyboard } = await renderMyTestsPage(String(ctx.user._id), Number(pageValue ?? "1"));
    await ctx.answerCallbackQuery({ text: "Test deleted.", show_alert: false });
    await ctx.editMessageText(text, { reply_markup: keyboard });
  });

  bot.callbackQuery(/^mytests:delete:cancel:\d+$/, async (ctx) => {
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: "User session missing.", show_alert: false });
      return;
    }

    const page = Number(ctx.callbackQuery.data.slice(MYTESTS_DELETE_CANCEL_CALLBACK_PREFIX.length));
    const { text, keyboard } = await renderMyTestsPage(String(ctx.user._id), page);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, { reply_markup: keyboard });
  });

  bot.callbackQuery(new RegExp(`^${MYTESTS_BACK_CALLBACK_PREFIX}`), async (ctx) => {
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: "User session missing.", show_alert: false });
      return;
    }

    const page = Number(ctx.callbackQuery.data.slice(MYTESTS_BACK_CALLBACK_PREFIX.length));
    const { text, keyboard } = await renderMyTestsPage(String(ctx.user._id), page);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, { reply_markup: keyboard });
  });

  bot.callbackQuery(new RegExp(`^${MYTESTS_TAKE_CALLBACK_PREFIX}`), async (ctx) => {
    const testId = ctx.callbackQuery.data.slice(MYTESTS_TAKE_CALLBACK_PREFIX.length);
    await ctx.answerCallbackQuery();
    await startOwnedTest(ctx, testId);
  });

  bot.callbackQuery(MYTESTS_NOOP_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery();
  });
};
