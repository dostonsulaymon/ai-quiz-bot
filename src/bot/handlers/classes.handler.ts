import { InlineKeyboard, type Bot } from "grammy";
import type { Types } from "mongoose";
import { ClassRepository } from "../../db/repositories/class.repository.js";
import { TestRepository } from "../../db/repositories/test.repository.js";
import { UserRepository } from "../../db/repositories/user.repository.js";
import type { BotContext } from "../types.js";
import { enterTestFlow } from "./test.handler.js";
import { t, type Language } from "../../shared/i18n/index.js";
import { safeEditMessage } from "../utils/telegram.js";

const MYCLASSES_PAGE_SIZE = 5;
const CLASS_TESTS_PAGE_SIZE = 5;

const MYCLASSES_PAGE_PREFIX = "myclasses:page:";
const MYCLASSES_LIST_PREFIX = "myclasses:list:";
const MYCLASSES_NEW_CB = "myclasses:new";
const MYCLASSES_OPEN_PREFIX = "myclasses:open:";
const MYCLASSES_VIEW_PREFIX = "myclasses:view:";
const MYCLASSES_EDIT_PREFIX = "myclasses:edit:";
const MYCLASSES_SHARE_PREFIX = "myclasses:share:";
const MYCLASSES_DELETE_PREFIX = "myclasses:delete:";
const MYCLASSES_ADD_TEST_PREFIX = "myclasses:add_test:";
const MYCLASSES_ADD_TEST_PAGE_PREFIX = "myclasses:add_test_page:";
const MYCLASSES_ADD_PICK_PREFIX = "myclasses:add_pick:";
const MYCLASSES_PREVIEW_BROWSE_PREFIX = "myclasses:preview:browse:";
const MYCLASSES_PREVIEW_TAKE_PREFIX = "myclasses:preview:take:";
const MYCLASSES_SHARE_BACK_CLASS_PREFIX = "myclasses:share_back_class:";
const MYCLASSES_SHARE_BACK_LIST_PREFIX = "myclasses:share_back_list:";
const MYCLASSES_NOOP_CB = "myclasses:noop";

const classRepository = new ClassRepository();
const testRepository = new TestRepository();
const userRepository = new UserRepository();

const normalizeClassShareCode = (value: string | undefined): string | undefined => {
  const code = value?.trim().toUpperCase();
  return code?.startsWith("CLASS-") ? code : undefined;
};

const buildPaginationRow = (page: number, totalPages: number, prefix: string, extra: string | undefined, lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text("◀", `${prefix}${Math.max(1, page - 1)}${extra ? `:${extra}` : ""}`)
    .text(t(lang, "pagination.page", { page, total: totalPages }), MYCLASSES_NOOP_CB)
    .text("▶", `${prefix}${Math.min(totalPages, page + 1)}${extra ? `:${extra}` : ""}`);

const buildClassPreviewPaginationRow = (classId: string, page: number, totalPages: number, lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text("◀", `${MYCLASSES_PREVIEW_BROWSE_PREFIX}${classId}:${Math.max(1, page - 1)}`)
    .text(t(lang, "pagination.page", { page, total: totalPages }), MYCLASSES_NOOP_CB)
    .text("▶", `${MYCLASSES_PREVIEW_BROWSE_PREFIX}${classId}:${Math.min(totalPages, page + 1)}`);

const loadTestsByIds = async (testIds: Types.ObjectId[]) => testRepository.findByIdsOrdered(testIds);

const renderMyClassesPage = async (
  userId: string,
  page: number,
  lang: Language
): Promise<{ text: string; keyboard: InlineKeyboard }> => {
  const totalItems = await classRepository.countByCreator(userId);
  if (totalItems === 0) {
    return {
      text: `${t(lang, "myclasses.title")}\n\n${t(lang, "myclasses.empty")}`,
      keyboard: new InlineKeyboard().text(t(lang, "myclasses.btn.new"), MYCLASSES_NEW_CB)
    };
  }

  const totalPages = Math.max(1, Math.ceil(totalItems / MYCLASSES_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const classes = await classRepository.findByCreatorPaginated(userId, currentPage, MYCLASSES_PAGE_SIZE);

  const lines = [
    "━━━━━━━━━━━━━━━━",
    t(lang, "myclasses.title"),
    "━━━━━━━━━━━━━━━━",
    ...classes.map((item, index) =>
      `${index + 1}. ${item.title} (${t(lang, "myclasses.test_count", { count: item.testIds.length })})`
    ),
    "━━━━━━━━━━━━━━━━"
  ];

  const keyboard = new InlineKeyboard().text(t(lang, "myclasses.btn.new"), MYCLASSES_NEW_CB).row();
  classes.forEach((item) => {
    const classId = String(item._id);
    keyboard
      .text(t(lang, "myclasses.btn.open_class"), `${MYCLASSES_OPEN_PREFIX}${classId}:${currentPage}`)
      .text(t(lang, "myclasses.btn.edit"), `${MYCLASSES_EDIT_PREFIX}${classId}:${currentPage}`)
      .text(t(lang, "myclasses.btn.share"), `${MYCLASSES_SHARE_PREFIX}${classId}:${currentPage}`)
      .text(t(lang, "myclasses.btn.delete"), `${MYCLASSES_DELETE_PREFIX}${classId}:${currentPage}`)
      .row();
  });
  keyboard.append(buildPaginationRow(currentPage, totalPages, MYCLASSES_PAGE_PREFIX, undefined, lang));

  return { text: lines.join("\n"), keyboard };
};

const renderClassView = async (
  classId: string,
  userId: Types.ObjectId,
  page: number,
  lang: Language
): Promise<{ text: string; keyboard: InlineKeyboard } | null> => {
  const item = await classRepository.findByIdAndCreator(classId, userId);
  if (!item) return null;

  const tests = await loadTestsByIds(item.testIds);
  const lines = [
    "━━━━━━━━━━━━━━━━",
    `${t(lang, "myclasses.preview.title", { title: item.title })}`,
    "━━━━━━━━━━━━━━━━"
  ];

  if (tests.length === 0) {
    lines.push(t(lang, "myclasses.empty_class"));
  } else {
    lines.push(
      ...tests.map((test, index) =>
        `${index + 1}. ${test?.title?.trim() || t(lang, "common.untitledTest")} (${test?.questions.length ?? 0} ${t(lang, "myclasses.question_count")})`
      )
    );
  }

  lines.push("━━━━━━━━━━━━━━━━");

  const keyboard = new InlineKeyboard()
    .text(t(lang, "myclasses.btn.add_test"), `${MYCLASSES_ADD_TEST_PREFIX}1:${page}`)
    .text(t(lang, "myclasses.btn.share_class"), `${MYCLASSES_SHARE_PREFIX}${classId}:${page}`)
    .row()
    .text(t(lang, "btn.back"), `${MYCLASSES_LIST_PREFIX}${page}`);

  return { text: lines.join("\n"), keyboard };
};

const renderAvailableTestsPage = async (
  classId: string,
  userId: Types.ObjectId,
  page: number,
  backPage: number,
  lang: Language
): Promise<{ text: string; keyboard: InlineKeyboard } | null> => {
  const item = await classRepository.findByIdAndCreator(classId, userId);
  if (!item) return null;

  const allTests = await testRepository.findByCreator(userId);
  const existingIds = new Set(item.testIds.map((id) => String(id)));
  const availableTests = allTests.filter((test) => !existingIds.has(String(test._id)));

  const totalPages = Math.max(1, Math.ceil(availableTests.length / CLASS_TESTS_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const slice = availableTests.slice((currentPage - 1) * CLASS_TESTS_PAGE_SIZE, currentPage * CLASS_TESTS_PAGE_SIZE);

  const lines = [
    t(lang, "myclasses.add_test.choose"),
    "",
    ...(slice.length === 0
      ? [t(lang, "myclasses.add_test.none")]
      : slice.map((test, index) => `${index + 1}. ${test.title?.trim() || t(lang, "common.untitledTest")}`))
  ];

  const keyboard = new InlineKeyboard();
  slice.forEach((test) => {
    keyboard
      .text(`➕ ${test.title?.trim() || t(lang, "common.untitledTest")}`, `${MYCLASSES_ADD_PICK_PREFIX}${String(test._id)}:${backPage}`)
      .row();
  });

  keyboard
    .text(t(lang, "btn.back"), `${MYCLASSES_VIEW_PREFIX}${backPage}`)
    .row()
    .append(buildPaginationRow(currentPage, totalPages, MYCLASSES_ADD_TEST_PAGE_PREFIX, String(backPage), lang));

  return { text: lines.join("\n"), keyboard };
};

const renderPublicClassPreview = async (
  shareCode: string,
  lang: Language
): Promise<{ text: string; keyboard: InlineKeyboard } | null> => {
  const item = await classRepository.findByShareCode(shareCode);
  if (!item) return null;

  const creator = await userRepository.findById(item.creatorId);
  const creatorName = creator?.username ? `@${creator.username}` : creator?.firstName ?? t(lang, "common.unknownCreator");

  return {
    text: [
      t(lang, "myclasses.preview.title", { title: item.title }),
      t(lang, "myclasses.preview.by", { name: creatorName }),
      t(lang, "myclasses.preview.tests", { count: item.testIds.length })
    ].join("\n"),
    keyboard: new InlineKeyboard().text(t(lang, "myclasses.preview.btn.browse"), `${MYCLASSES_PREVIEW_BROWSE_PREFIX}${String(item._id)}:1`)
  };
};

const renderPublicClassBrowse = async (
  classId: string,
  page: number,
  lang: Language
): Promise<{ text: string; keyboard: InlineKeyboard } | null> => {
  const item = await classRepository.findById(classId);
  if (!item || !item.isActive) return null;

  const tests = await loadTestsByIds(item.testIds);
  const totalPages = Math.max(1, Math.ceil(tests.length / CLASS_TESTS_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const slice = tests.slice((currentPage - 1) * CLASS_TESTS_PAGE_SIZE, currentPage * CLASS_TESTS_PAGE_SIZE);

  const lines = [
    t(lang, "myclasses.preview.title", { title: item.title }),
    t(lang, "myclasses.preview.tests", { count: tests.length }),
    ""
  ];

  if (slice.length === 0) {
    lines.push(t(lang, "myclasses.empty_class"));
  } else {
    lines.push(...slice.map((test, index) =>
      `${(currentPage - 1) * CLASS_TESTS_PAGE_SIZE + index + 1}. ${test?.title?.trim() || t(lang, "common.untitledTest")}`
    ));
  }

  const keyboard = new InlineKeyboard();
  slice.forEach((test) => {
    keyboard.text(`▶️ ${test.title?.trim() || t(lang, "common.untitledTest")}`, `${MYCLASSES_PREVIEW_TAKE_PREFIX}${String(test._id)}`).row();
  });
  keyboard.append(buildClassPreviewPaginationRow(classId, currentPage, totalPages, lang));

  return { text: lines.join("\n"), keyboard };
};

export const showMyClassesPage = async (ctx: BotContext, page = 1): Promise<void> => {
  const lang = ctx.lang();
  ctx.session.activeClassId = undefined;
  if (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") {
    await ctx.reply(t(lang, "cmd.private_only"));
    return;
  }
  if (!ctx.user) {
    await ctx.reply(t(lang, "error.userLoad"));
    return;
  }

  const { text, keyboard } = await renderMyClassesPage(String(ctx.user._id), page, lang);
  await ctx.reply(text, { reply_markup: keyboard });
};

export const showClassPreviewFromShareCode = async (ctx: BotContext, rawCode: string): Promise<void> => {
  const shareCode = normalizeClassShareCode(rawCode);
  if (!shareCode) {
    await ctx.reply(t(ctx.lang(), "commands.testLinkInvalid"));
    return;
  }

  const result = await renderPublicClassPreview(shareCode, ctx.lang());
  if (!result) {
    await ctx.reply(t(ctx.lang(), "commands.testLinkInvalid"));
    return;
  }

  await ctx.reply(result.text, { reply_markup: result.keyboard });
};

export const registerClassesHandler = (bot: Bot<BotContext>): void => {
  bot.command("myclasses", async (ctx) => {
    await showMyClassesPage(ctx, 1);
  });

  bot.callbackQuery(new RegExp(`^${MYCLASSES_PAGE_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }
    const payload = ctx.callbackQuery.data.slice(MYCLASSES_PAGE_PREFIX.length);
    const page = Number(payload || "1");
    const { text, keyboard } = await renderMyClassesPage(String(ctx.user._id), page, lang);
    await ctx.answerCallbackQuery();
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });

  bot.callbackQuery(MYCLASSES_NEW_CB, async (ctx) => {
    if (!ctx.user) { await ctx.answerCallbackQuery(); return; }
    ctx.session.classEditorMode = "create";
    ctx.session.classEditingId = undefined;
    ctx.session.activeClassId = undefined;
    await ctx.answerCallbackQuery();
    await ctx.reply(t(ctx.lang(), "myclasses.new.prompt"));
  });

  bot.callbackQuery(new RegExp(`^${MYCLASSES_OPEN_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }
    const payload = ctx.callbackQuery.data.slice(MYCLASSES_OPEN_PREFIX.length);
    const [classId, pageValue] = payload.split(":");
    ctx.session.activeClassId = classId;
    const result = await renderClassView(classId ?? "", ctx.user._id, Number(pageValue ?? "1"), lang);
    if (!result) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.not_owner"), show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await safeEditMessage(ctx, result.text, { reply_markup: result.keyboard });
  });

  bot.callbackQuery(new RegExp(`^${MYCLASSES_VIEW_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }
    const classId = ctx.session.activeClassId;
    if (!classId) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.session_not_found"), show_alert: false });
      return;
    }
    const page = Number(ctx.callbackQuery.data.slice(MYCLASSES_VIEW_PREFIX.length));
    const result = await renderClassView(classId, ctx.user._id, page, lang);
    await ctx.answerCallbackQuery();
    if (!result) {
      await ctx.reply(t(lang, "error.not_owner"));
      return;
    }
    await safeEditMessage(ctx, result.text, { reply_markup: result.keyboard });
  });

  bot.callbackQuery(new RegExp(`^${MYCLASSES_LIST_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }
    ctx.session.activeClassId = undefined;
    const page = Number(ctx.callbackQuery.data.slice(MYCLASSES_LIST_PREFIX.length));
    const { text, keyboard } = await renderMyClassesPage(String(ctx.user._id), page, lang);
    await ctx.answerCallbackQuery();
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });

  bot.callbackQuery(new RegExp(`^${MYCLASSES_EDIT_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }
    const payload = ctx.callbackQuery.data.slice(MYCLASSES_EDIT_PREFIX.length);
    const [classId] = payload.split(":");
    const owned = await classRepository.findByIdAndCreator(classId ?? "", ctx.user._id);
    if (!owned) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.not_owner"), show_alert: true });
      return;
    }
    ctx.session.classEditorMode = "edit";
    ctx.session.classEditingId = String(owned._id);
    ctx.session.activeClassId = String(owned._id);
    await ctx.answerCallbackQuery();
    await ctx.reply(t(lang, "myclasses.edit.prompt", { title: owned.title }));
  });

  bot.callbackQuery(new RegExp(`^${MYCLASSES_SHARE_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }
    const payload = ctx.callbackQuery.data.slice(MYCLASSES_SHARE_PREFIX.length);
    const [classId, pageValue] = payload.split(":");
    const owned = await classRepository.findByIdAndCreator(classId ?? "", ctx.user._id);
    if (!owned) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.not_owner"), show_alert: true });
      return;
    }
    const page = Number(pageValue ?? "1");
    ctx.session.activeClassId = String(owned._id);
    const shareCode = await classRepository.ensureShareCode(owned._id);
    const link = `https://t.me/${ctx.me.username ?? "your_bot"}?start=${shareCode}`;
    await ctx.answerCallbackQuery();
    await ctx.reply(t(lang, "myclasses.share.link", { code: shareCode, link }), {
      reply_markup: new InlineKeyboard()
        .text(t(lang, "deadend.btn.back_to_class"), `${MYCLASSES_SHARE_BACK_CLASS_PREFIX}${page}`)
        .text(t(lang, "deadend.btn.my_classes"), `${MYCLASSES_SHARE_BACK_LIST_PREFIX}${page}`)
    });
  });

  bot.callbackQuery(new RegExp(`^${MYCLASSES_DELETE_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }
    const payload = ctx.callbackQuery.data.slice(MYCLASSES_DELETE_PREFIX.length);
    const [classId, pageValue] = payload.split(":");
    const owned = await classRepository.findByIdAndCreator(classId ?? "", ctx.user._id);
    if (!owned) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.not_owner"), show_alert: true });
      return;
    }
    await classRepository.softDelete(owned._id);
    const { text, keyboard } = await renderMyClassesPage(String(ctx.user._id), Number(pageValue ?? "1"), lang);
    await ctx.answerCallbackQuery({ text: t(lang, "myclasses.deleted"), show_alert: false });
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });

  bot.callbackQuery(new RegExp(`^${MYCLASSES_ADD_TEST_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }
    const classId = ctx.session.activeClassId;
    if (!classId) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.session_not_found"), show_alert: false });
      return;
    }
    const payload = ctx.callbackQuery.data.slice(MYCLASSES_ADD_TEST_PREFIX.length);
    const [pageValue, backPageValue] = payload.split(":");
    const result = await renderAvailableTestsPage(classId, ctx.user._id, Number(pageValue ?? "1"), Number(backPageValue ?? "1"), lang);
    if (!result) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.not_owner"), show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await safeEditMessage(ctx, result.text, { reply_markup: result.keyboard });
  });

  bot.callbackQuery(new RegExp(`^${MYCLASSES_ADD_TEST_PAGE_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }
    const classId = ctx.session.activeClassId;
    if (!classId) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.session_not_found"), show_alert: false });
      return;
    }
    const payload = ctx.callbackQuery.data.slice(MYCLASSES_ADD_TEST_PAGE_PREFIX.length);
    const [pageValue, backPageValue] = payload.split(":");
    const result = await renderAvailableTestsPage(classId, ctx.user._id, Number(pageValue ?? "1"), Number(backPageValue ?? "1"), lang);
    if (!result) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.not_owner"), show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await safeEditMessage(ctx, result.text, { reply_markup: result.keyboard });
  });

  bot.callbackQuery(new RegExp(`^${MYCLASSES_ADD_PICK_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }
    const classId = ctx.session.activeClassId;
    if (!classId) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.session_not_found"), show_alert: false });
      return;
    }
    const payload = ctx.callbackQuery.data.slice(MYCLASSES_ADD_PICK_PREFIX.length);
    const [testId, backPageValue] = payload.split(":");
    const ownedClass = await classRepository.findByIdAndCreator(classId, ctx.user._id);
    const ownedTest = await testRepository.findByIdAndCreator(testId ?? "", ctx.user._id);
    if (!ownedClass || !ownedTest) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.not_owner"), show_alert: true });
      return;
    }
    await classRepository.addTest(ownedClass._id, ownedTest._id);
    const result = await renderClassView(String(ownedClass._id), ctx.user._id, Number(backPageValue ?? "1"), lang);
    await ctx.answerCallbackQuery({ text: t(lang, "myclasses.added_test"), show_alert: false });
    if (result) {
      await safeEditMessage(ctx, result.text, { reply_markup: result.keyboard });
    }
  });

  bot.callbackQuery(new RegExp(`^${MYCLASSES_PREVIEW_BROWSE_PREFIX}`), async (ctx) => {
    const payload = ctx.callbackQuery.data.slice(MYCLASSES_PREVIEW_BROWSE_PREFIX.length);
    const [classId, pageValue] = payload.split(":");
    const result = await renderPublicClassBrowse(classId ?? "", Number(pageValue ?? "1"), ctx.lang());
    await ctx.answerCallbackQuery();
    if (!result) {
      await ctx.reply(t(ctx.lang(), "commands.testLinkInvalid"));
      return;
    }
    await safeEditMessage(ctx, result.text, { reply_markup: result.keyboard });
  });

  bot.callbackQuery(new RegExp(`^${MYCLASSES_PREVIEW_TAKE_PREFIX}`), async (ctx) => {
    const testId = ctx.callbackQuery.data.slice(MYCLASSES_PREVIEW_TAKE_PREFIX.length);
    await ctx.answerCallbackQuery();
    await enterTestFlow(ctx, testId);
  });

  bot.callbackQuery(new RegExp(`^${MYCLASSES_SHARE_BACK_CLASS_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }
    const classId = ctx.session.activeClassId;
    if (!classId) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.session_not_found"), show_alert: false });
      return;
    }
    const page = Number(ctx.callbackQuery.data.slice(MYCLASSES_SHARE_BACK_CLASS_PREFIX.length));
    const result = await renderClassView(classId, ctx.user._id, page, lang);
    await ctx.answerCallbackQuery();
    if (!result) {
      await ctx.reply(t(lang, "error.not_owner"));
      return;
    }
    await safeEditMessage(ctx, result.text, { reply_markup: result.keyboard });
  });

  bot.callbackQuery(new RegExp(`^${MYCLASSES_SHARE_BACK_LIST_PREFIX}`), async (ctx) => {
    const lang = ctx.lang();
    if (!ctx.user) {
      await ctx.answerCallbackQuery({ text: t(lang, "error.userSession"), show_alert: false });
      return;
    }
    ctx.session.activeClassId = undefined;
    const page = Number(ctx.callbackQuery.data.slice(MYCLASSES_SHARE_BACK_LIST_PREFIX.length));
    const { text, keyboard } = await renderMyClassesPage(String(ctx.user._id), page, lang);
    await ctx.answerCallbackQuery();
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });

  bot.callbackQuery(MYCLASSES_NOOP_CB, async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.on("message:text", async (ctx, next) => {
    const mode = ctx.session.classEditorMode;
    if (!mode) {
      await next();
      return;
    }

    if (!ctx.user) {
      ctx.session.classEditorMode = undefined;
      ctx.session.classEditingId = undefined;
      await next();
      return;
    }

    const title = ctx.message.text.trim();
    if (!title || title.startsWith("/")) {
      await next();
      return;
    }

    if (mode === "create") {
      const created = await classRepository.create(title, ctx.user._id);
      ctx.session.classEditorMode = undefined;
      ctx.session.activeClassId = String(created._id);
      const result = await renderClassView(String(created._id), ctx.user._id, 1, ctx.lang());
      await ctx.reply(t(ctx.lang(), "myclasses.created", { title }));
      if (result) {
        await ctx.reply(result.text, { reply_markup: result.keyboard });
      }
      return;
    }

    const classId = ctx.session.classEditingId;
    if (classId) {
      await classRepository.updateTitle(classId, title);
      ctx.session.activeClassId = classId;
      const result = await renderClassView(classId, ctx.user._id, 1, ctx.lang());
      if (result) {
        await ctx.reply(result.text, { reply_markup: result.keyboard });
      }
    }

    ctx.session.classEditorMode = undefined;
    ctx.session.classEditingId = undefined;
  });
};
