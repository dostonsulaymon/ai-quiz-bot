import { InlineKeyboard, type Bot } from "grammy";
import { TestRepository } from "../../db/repositories/test.repository.js";
import { TestSessionRepository } from "../../db/repositories/test-session.repository.js";
import { LeaderboardRepository } from "../../db/repositories/leaderboard.repository.js";
import type { BotContext } from "../types.js";
import { resetSession } from "../types.js";
import { enterTestFlow, LEADERBOARD_CALLBACK_PREFIX } from "./test.handler.js";
import { enterEditFlow } from "./edit.handler.js";
import { t, formatQuestionTypes, type Language } from "../../shared/i18n/index.js";
import { formatDate } from "../utils/format.js";
import { safeEditMessage } from "../utils/telegram.js";

const MYTESTS_PAGE_SIZE = 5;
const MYTESTS_PAGE_CALLBACK_PREFIX = "mytests:page:";
const MYTESTS_SHARE_CALLBACK_PREFIX = "mytests:share:";
const MYTESTS_DELETE_CALLBACK_PREFIX = "mytests:delete:";
const MYTESTS_DELETE_CONFIRM_CALLBACK_PREFIX = "mytests:delete:confirm:";
const MYTESTS_DELETE_CANCEL_CALLBACK_PREFIX = "mytests:delete:cancel:";
const MYTESTS_TAKE_CALLBACK_PREFIX = "mytests:take:";
const MYTESTS_PREVIEW_CALLBACK_PREFIX = "mytests:preview:";
const MYTESTS_BACK_CALLBACK_PREFIX = "mytests:back:";
const MYTESTS_EDIT_CALLBACK_PREFIX = "mytests:edit:";
const MYTESTS_DUPLICATE_CALLBACK_PREFIX = "mytests:duplicate:";
const MYTESTS_NOOP_CALLBACK = "mytests:noop";

const testRepository = new TestRepository();
const testSessionRepository = new TestSessionRepository();
const leaderboardRepository = new LeaderboardRepository();

const buildPaginationRow = (page: number, totalPages: number, lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text("◀", `${MYTESTS_PAGE_CALLBACK_PREFIX}${Math.max(1, page - 1)}:${page}`)
    .text(t(lang, "pagination.page", { page, total: totalPages }), MYTESTS_NOOP_CALLBACK)
    .text("▶", `${MYTESTS_PAGE_CALLBACK_PREFIX}${Math.min(totalPages, page + 1)}:${page}`);

const renderMyTestsPage = async (userId: string, page: number, lang: Language): Promise<{ text: string; keyboard: InlineKeyboard }> => {
  const totalItems = await testRepository.countByCreator(userId);
  if (totalItems === 0) {
    return {
      text: t(lang, "mytests.noTests"),
      keyboard: new InlineKeyboard().text(t(lang, "pagination.page", { page: 1, total: 1 }), MYTESTS_NOOP_CALLBACK)
    };
  }

  const totalPages = Math.max(1, Math.ceil(totalItems / MYTESTS_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const tests = await testRepository.findByCreatorPaginated(userId, currentPage, MYTESTS_PAGE_SIZE);
  const testIds = tests.map((test) => test._id);

  const [takeCountMap, participantCountMap] = await Promise.all([
    testSessionRepository.countByTestIds(testIds),
    leaderboardRepository.getParticipantCounts(testIds)
  ]);

  const lines = tests.flatMap((test, index) => {
    const participantCount = participantCountMap.get(String(test._id)) ?? 0;
    const participantHint =
      participantCount === 0
        ? t(lang, "mytests.not_taken")
        : participantCount === 1
        ? t(lang, "mytests.one_taken")
        : undefined;

    const row = [
      t(lang, "mytests.testRow", {
        n: index + 1,
        title: test.title?.trim() || t(lang, "common.untitled"),
        q: test.questions.length,
        types: formatQuestionTypes(test.questions.map((question) => question.type), lang)
      }),
      t(lang, "mytests.testRowMeta", { n: takeCountMap.get(String(test._id)) ?? 0, date: formatDate(test.createdAt, false, lang) })
    ];

    if (participantHint) row.push(participantHint);
    row.push("");
    return row;
  });

  const keyboard = new InlineKeyboard();
  tests.forEach((test, index) => {
    const testId = String(test._id);
    const participantCount = participantCountMap.get(testId) ?? 0;
    keyboard
      .text(t(lang, "mytests.btn.take", { n: index + 1 }), `${MYTESTS_TAKE_CALLBACK_PREFIX}${testId}`)
      .text(t(lang, "mytests.btn.share"), `${MYTESTS_SHARE_CALLBACK_PREFIX}${testId}:${currentPage}`)
      .text(t(lang, "mytests.btn.delete"), `${MYTESTS_DELETE_CALLBACK_PREFIX}${testId}:${currentPage}`)
      .row()
      .text(t(lang, "mytests.btn.preview"), `${MYTESTS_PREVIEW_CALLBACK_PREFIX}${testId}:${currentPage}`)
      .text(t(lang, "mytests.btn.edit"), `${MYTESTS_EDIT_CALLBACK_PREFIX}${testId}`)
      .text(t(lang, "mytests.btn.duplicate"), `${MYTESTS_DUPLICATE_CALLBACK_PREFIX}${testId}:${currentPage}`);

    if (participantCount >= 2) {
      keyboard.text(t(lang, "leaderboard.btn"), `${LEADERBOARD_CALLBACK_PREFIX}${testId}`);
    }

    keyboard.row();
  });

  keyboard.append(buildPaginationRow(currentPage, totalPages, lang));

  return {
    text: [t(lang, "mytests.header"), "", ...lines].join("\n").trim(),
    keyboard
  };
};

const renderPreview = async (testId: string, page: number, lang: Language): Promise<{ text: string; keyboard: InlineKeyboard }> => {
  const test = await testRepository.findById(testId);
  if (!test || !test.isActive) {
    return {
      text: t(lang, "mytests.testUnavailable"),
      keyboard: new InlineKeyboard().text(t(lang, "btn.back"), `${MYTESTS_BACK_CALLBACK_PREFIX}${page}`)
    };
  }

  return {
    text: [
      t(lang, "mytests.preview.title", { title: test.title?.trim() || t(lang, "common.untitledTest") }),
      t(lang, "mytests.preview.questions", { n: test.questions.length }),
      t(lang, "mytests.preview.types", { types: formatQuestionTypes(test.questions.map((question) => question.type), lang) })
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text(t(lang, "mytests.btn.takeTest"), `${MYTESTS_TAKE_CALLBACK_PREFIX}${testId}`)
      .text(t(lang, "btn.back"), `${MYTESTS_BACK_CALLBACK_PREFIX}${page}`)
  };
};

const renderShareView = async (testId: string, page: number, lang: Language, botUsername?: string): Promise<{ text: string; keyboard: InlineKeyboard }> => {
  const test = await testRepository.ensureShareCode(testId);
  const code = `TEST-${test.shareCode}`;
  const link = `https://t.me/${botUsername ?? "your_bot"}?start=${code}`;

  const instructions = t(lang, "share.instructions", { code, link });
  return {
    text: t(lang, "mytests.shareCard", { instructions }),
    keyboard: new InlineKeyboard()
      .url(t(lang, "mytests.btn.copyLink"), link)
      .row()
      .text(t(lang, "btn.back"), `${MYTESTS_BACK_CALLBACK_PREFIX}${page}`)
  };
};

const renderDeleteConfirm = async (testId: string, page: number, lang: Language): Promise<{ text: string; keyboard: InlineKeyboard }> => {
  const test = await testRepository.findById(testId);

  return {
    text: t(lang, "mytests.deleteConfirm", { title: test?.title?.trim() || t(lang, "common.untitledTest") }),
    keyboard: new InlineKeyboard()
      .text(t(lang, "mytests.btn.confirmDelete"), `${MYTESTS_DELETE_CONFIRM_CALLBACK_PREFIX}${testId}:${page}`)
      .text(t(lang, "btn.cancel"), `${MYTESTS_DELETE_CANCEL_CALLBACK_PREFIX}${page}`)
  };
};

const startOwnedTest = async (ctx: BotContext, testId: string): Promise<void> => {
  resetSession(ctx.session);
  await enterTestFlow(ctx, testId);
};

export const registerMyTestsHandler = (bot: Bot<BotContext>): void => {
  bot.command("mytests", async (ctx) => {
    if (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") {
      await ctx.reply(t(ctx.lang(), "cmd.private_only"));
      return;
    }
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.reply(t(lang, "error.userLoad"));
      return;
    }

    const totalItems = await testRepository.countByCreator(ctx.user._id);
    if (totalItems === 0) {
      await ctx.reply(t(lang, "mytests.noTests"));
      return;
    }

    const { text, keyboard } = await renderMyTestsPage(String(ctx.user._id), 1, lang);
    await ctx.reply(text, { reply_markup: keyboard });
  });

  bot.callbackQuery(new RegExp(`^${MYTESTS_PAGE_CALLBACK_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }

    const payload = ctx.callbackQuery.data.slice(MYTESTS_PAGE_CALLBACK_PREFIX.length);
    const [pageStr, currentPageStr] = payload.split(":");
    const page = Number(pageStr);
    const currentPage = Number(currentPageStr ?? pageStr);

    if (page === currentPage) {
      await ctx.answerCallbackQuery({
        text: t(lang, page <= 1 ? "pagination.already_first" : "pagination.already_last")
      });
      return;
    }

    const { text, keyboard } = await renderMyTestsPage(String(ctx.user._id), page, lang);
    await ctx.answerCallbackQuery();
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });

  bot.callbackQuery(new RegExp(`^${MYTESTS_PREVIEW_CALLBACK_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    const payload = ctx.callbackQuery.data.slice(MYTESTS_PREVIEW_CALLBACK_PREFIX.length);
    const [testId, pageValue] = payload.split(":");
    const { text, keyboard } = await renderPreview(testId ?? "", Number(pageValue ?? "1"), lang);
    await ctx.answerCallbackQuery();
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });

  bot.callbackQuery(new RegExp(`^${MYTESTS_SHARE_CALLBACK_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }

    const payload = ctx.callbackQuery.data.slice(MYTESTS_SHARE_CALLBACK_PREFIX.length);
    const [testId, pageValue] = payload.split(":");
    const owned = await testRepository.findByIdAndCreator(testId ?? "", ctx.user._id);
    if (!owned) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.not_owner"), show_alert: true });
      return;
    }

    const { text, keyboard } = await renderShareView(testId ?? "", Number(pageValue ?? "1"), lang, ctx.me.username);
    await ctx.answerCallbackQuery();
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });

  bot.callbackQuery(/^mytests:delete:[^:]+:\d+$/, async (ctx) => {
    const lang = ctx.lang();
    const payload = ctx.callbackQuery.data.slice(MYTESTS_DELETE_CALLBACK_PREFIX.length);
    const [testId, pageValue] = payload.split(":");
    const { text, keyboard } = await renderDeleteConfirm(testId ?? "", Number(pageValue ?? "1"), lang);
    await ctx.answerCallbackQuery();
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });

  bot.callbackQuery(/^mytests:delete:confirm:[^:]+:\d+$/, async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }

    const payload = ctx.callbackQuery.data.slice(MYTESTS_DELETE_CONFIRM_CALLBACK_PREFIX.length);
    const [testId, pageValue] = payload.split(":");
    const owned = await testRepository.findByIdAndCreator(testId ?? "", ctx.user._id);
    if (!owned) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.not_owner"), show_alert: true });
      return;
    }

    await testRepository.softDelete(testId ?? "");
    const { text, keyboard } = await renderMyTestsPage(String(ctx.user._id), Number(pageValue ?? "1"), lang);
    await ctx.answerCallbackQuery({ text: t(lang, "mytests.deleted"), show_alert: false });
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });

  bot.callbackQuery(/^mytests:delete:cancel:\d+$/, async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }

    const page = Number(ctx.callbackQuery.data.slice(MYTESTS_DELETE_CANCEL_CALLBACK_PREFIX.length));
    const { text, keyboard } = await renderMyTestsPage(String(ctx.user._id), page, lang);
    await ctx.answerCallbackQuery();
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });

  bot.callbackQuery(new RegExp(`^${MYTESTS_BACK_CALLBACK_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }

    const page = Number(ctx.callbackQuery.data.slice(MYTESTS_BACK_CALLBACK_PREFIX.length));
    const { text, keyboard } = await renderMyTestsPage(String(ctx.user._id), page, lang);
    await ctx.answerCallbackQuery();
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });

  bot.callbackQuery(new RegExp(`^${MYTESTS_TAKE_CALLBACK_PREFIX}`), async (ctx) => {
    const testId = ctx.callbackQuery.data.slice(MYTESTS_TAKE_CALLBACK_PREFIX.length);
    await ctx.answerCallbackQuery();
    await startOwnedTest(ctx, testId);
  });

  bot.callbackQuery(MYTESTS_NOOP_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(new RegExp(`^${MYTESTS_EDIT_CALLBACK_PREFIX}`), async (ctx) => {
    const testId = ctx.callbackQuery.data.slice(MYTESTS_EDIT_CALLBACK_PREFIX.length);
    await ctx.answerCallbackQuery();
    await enterEditFlow(ctx, testId);
  });

  bot.callbackQuery(new RegExp(`^${MYTESTS_DUPLICATE_CALLBACK_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }

    const payload = ctx.callbackQuery.data.slice(MYTESTS_DUPLICATE_CALLBACK_PREFIX.length);
    const [testId, pageValue] = payload.split(":");
    const owned = await testRepository.findByIdAndCreator(testId ?? "", ctx.user._id);
    if (!owned) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.not_owner"), show_alert: true });
      return;
    }

    const originalTitle = owned.title?.trim() || t(lang, "common.untitledTest");
    const newTitle = `${originalTitle}${t(lang, "mytests.duplicate.title_suffix")}`;
    const newTest = await testRepository.duplicate(testId ?? "", ctx.user._id, newTitle);

    const page = Number(pageValue ?? "1");
    const { text, keyboard } = await renderMyTestsPage(String(ctx.user._id), page, lang);
    await ctx.answerCallbackQuery({ text: t(lang, "mytests.duplicate.success", { title: newTest.title ?? newTitle }), show_alert: false });
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });
};
