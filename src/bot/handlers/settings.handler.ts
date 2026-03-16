import { InlineKeyboard, type Bot } from "grammy";
import { UserRepository } from "../../db/repositories/user.repository.js";
import type { BotContext } from "../types.js";
import { t, formatQuestionTypes, type Language } from "../../shared/i18n/index.js";
import type { QuestionType } from "../../shared/types/index.js";
import { safeEditMessage } from "../utils/telegram.js";
import { userCache } from "../middlewares/userMiddleware.js";
import type { UserDocument } from "../../db/models/user.model.js";

// ---------------------------------------------------------------------------
// Callback constants
// ---------------------------------------------------------------------------

export const SETTINGS_MENU_CB = "settings:menu";
const SETTINGS_COUNT_CB = "settings:count";
const SETTINGS_COUNT_PREFIX = "settings:count:";
const SETTINGS_TYPES_CB = "settings:types";
const SETTINGS_TYPES_TOGGLE_PREFIX = "settings:types:toggle:";
const SETTINGS_TYPES_CONFIRM_CB = "settings:types:confirm";
const SETTINGS_TIMER_CB = "settings:timer";
const SETTINGS_TIMER_PREFIX = "settings:timer:";
const SETTINGS_SHUFFLE_CB = "settings:shuffle";
const SETTINGS_SHUFFLE_PREFIX = "settings:shuffle:";
const SETTINGS_LANGUAGE_CB = "settings:language";
const SETTINGS_LANG_PREFIX = "settings:lang:";
const SETTINGS_DONE_CB = "settings:done";

const userRepository = new UserRepository();

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

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

const formatShuffleLabel = (shuffleQ: boolean, shuffleO: boolean, lang: Language): string => {
  if (shuffleQ && shuffleO) return t(lang, "upload.shuffle.both");
  if (shuffleQ) return t(lang, "upload.shuffle.questions");
  return t(lang, "upload.shuffle.none");
};

const buildSettingsText = (user: UserDocument, lang: Language): string => {
  const SEP = "━━━━━━━━━━━━━━━━";
  const count = user.defaultQuestionCount ?? 10;
  const types = (user.defaultQuestionTypes ?? []) as QuestionType[];
  const timer = user.defaultTimeLimitSeconds ?? 0;
  const shuffleQ = user.defaultShuffleQuestions ?? false;
  const shuffleO = user.defaultShuffleOptions ?? false;

  const typesLabel = types.length > 0 ? formatQuestionTypes(types, lang) : "—";

  return [
    t(lang, "settings.title"),
    SEP,
    t(lang, "settings.default_count", { count }),
    t(lang, "settings.default_types", { types: typesLabel }),
    t(lang, "settings.default_timer", { timer: formatTimerLabel(timer, lang) }),
    t(lang, "settings.default_shuffle", { shuffle: formatShuffleLabel(shuffleQ, shuffleO, lang) }),
    SEP
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Keyboard builders
// ---------------------------------------------------------------------------

const buildSettingsKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "settings.btn.count"), SETTINGS_COUNT_CB)
    .text(t(lang, "settings.btn.types"), SETTINGS_TYPES_CB)
    .row()
    .text(t(lang, "settings.btn.timer"), SETTINGS_TIMER_CB)
    .text(t(lang, "settings.btn.shuffle"), SETTINGS_SHUFFLE_CB)
    .row()
    .text(t(lang, "settings.btn.language"), SETTINGS_LANGUAGE_CB)
    .row()
    .text(t(lang, "settings.btn.done"), SETTINGS_DONE_CB);

const buildCountKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text("5", `${SETTINGS_COUNT_PREFIX}5`)
    .text("10", `${SETTINGS_COUNT_PREFIX}10`)
    .text("15", `${SETTINGS_COUNT_PREFIX}15`)
    .text("20", `${SETTINGS_COUNT_PREFIX}20`)
    .row()
    .text(t(lang, "btn.back"), SETTINGS_MENU_CB);

const buildTypesKeyboard = (selectedTypes: QuestionType[], lang: Language): InlineKeyboard => {
  const selected = new Set(selectedTypes);
  const toggle = (type: QuestionType): string =>
    `${selected.has(type) ? "[x]" : "[ ]"} ${t(lang, `upload.type.${type}` as Parameters<typeof t>[1])}`;

  return new InlineKeyboard()
    .text(toggle("mcq"), `${SETTINGS_TYPES_TOGGLE_PREFIX}mcq`)
    .text(toggle("truefalse"), `${SETTINGS_TYPES_TOGGLE_PREFIX}truefalse`)
    .row()
    .text(toggle("short"), `${SETTINGS_TYPES_TOGGLE_PREFIX}short`)
    .text(toggle("fill"), `${SETTINGS_TYPES_TOGGLE_PREFIX}fill`)
    .row()
    .text(t(lang, "upload.btn.confirmTypes"), SETTINGS_TYPES_CONFIRM_CB)
    .text(t(lang, "btn.back"), SETTINGS_MENU_CB);
};

const buildTimerKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "upload.timer.btn.15"), `${SETTINGS_TIMER_PREFIX}15`)
    .text(t(lang, "upload.timer.btn.30"), `${SETTINGS_TIMER_PREFIX}30`)
    .row()
    .text(t(lang, "upload.timer.btn.60"), `${SETTINGS_TIMER_PREFIX}60`)
    .text(t(lang, "upload.timer.btn.180"), `${SETTINGS_TIMER_PREFIX}180`)
    .row()
    .text(t(lang, "upload.timer.btn.none"), `${SETTINGS_TIMER_PREFIX}0`)
    .row()
    .text(t(lang, "btn.back"), SETTINGS_MENU_CB);

const buildShuffleKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "upload.shuffle.both"), `${SETTINGS_SHUFFLE_PREFIX}both`)
    .row()
    .text(t(lang, "upload.shuffle.questions"), `${SETTINGS_SHUFFLE_PREFIX}questions`)
    .row()
    .text(t(lang, "upload.shuffle.none"), `${SETTINGS_SHUFFLE_PREFIX}none`)
    .row()
    .text(t(lang, "btn.back"), SETTINGS_MENU_CB);

const buildLanguageKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "language.btn.en"), `${SETTINGS_LANG_PREFIX}en`)
    .text(t(lang, "language.btn.uz"), `${SETTINGS_LANG_PREFIX}uz`)
    .row()
    .text(t(lang, "btn.back"), SETTINGS_MENU_CB);

// ---------------------------------------------------------------------------
// Public: build settings message (used by command handler too)
// ---------------------------------------------------------------------------

export const buildSettingsPage = async (
  userId: string,
  lang: Language
): Promise<{ text: string; keyboard: InlineKeyboard }> => {
  const user = await userRepository.findById(userId);
  if (!user) throw new Error("User not found for settings page");
  return { text: buildSettingsText(user, lang), keyboard: buildSettingsKeyboard(lang) };
};

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export const registerSettingsHandler = (bot: Bot<BotContext>): void => {
  // Back to menu (used as "Back" button inside all sub-menus)
  bot.callbackQuery(SETTINGS_MENU_CB, async (ctx) => {
    if (!ctx.user) { await ctx.answerCallbackQuery(); return; }
    const lang = ctx.lang();
    await ctx.answerCallbackQuery();
    const { text, keyboard } = await buildSettingsPage(String(ctx.user._id), lang);
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });

  // ── Count ────────────────────────────────────────────────────────────────

  bot.callbackQuery(SETTINGS_COUNT_CB, async (ctx) => {
    if (!ctx.user) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery();
    await safeEditMessage(ctx, t(ctx.lang(), "upload.howManyQuestions"), {
      reply_markup: buildCountKeyboard(ctx.lang())
    });
  });

  bot.callbackQuery(new RegExp(`^${SETTINGS_COUNT_PREFIX}\\d+$`), async (ctx) => {
    if (!ctx.user) { await ctx.answerCallbackQuery(); return; }
    const lang = ctx.lang();
    const count = parseInt(ctx.callbackQuery.data.slice(SETTINGS_COUNT_PREFIX.length), 10);
    await userRepository.updatePreferences(ctx.user._id, { defaultQuestionCount: count });
    if (ctx.from) userCache.delete(ctx.from.id);
    await ctx.answerCallbackQuery();
    const { text, keyboard } = await buildSettingsPage(String(ctx.user._id), lang);
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });

  // ── Types ────────────────────────────────────────────────────────────────

  bot.callbackQuery(SETTINGS_TYPES_CB, async (ctx) => {
    if (!ctx.user) { await ctx.answerCallbackQuery(); return; }
    const lang = ctx.lang();
    ctx.session.settingsDraftTypes = (ctx.user.defaultQuestionTypes as QuestionType[]) ?? [];
    await ctx.answerCallbackQuery();
    await safeEditMessage(ctx, t(lang, "upload.whichTypes"), {
      reply_markup: buildTypesKeyboard(ctx.session.settingsDraftTypes, lang)
    });
  });

  bot.callbackQuery(new RegExp(`^${SETTINGS_TYPES_TOGGLE_PREFIX}`), async (ctx) => {
    if (!ctx.user) { await ctx.answerCallbackQuery(); return; }
    const lang = ctx.lang();
    const type = ctx.callbackQuery.data.slice(SETTINGS_TYPES_TOGGLE_PREFIX.length) as QuestionType;
    const current = new Set<QuestionType>(ctx.session.settingsDraftTypes ?? []);
    if (current.has(type)) { current.delete(type); } else { current.add(type); }
    ctx.session.settingsDraftTypes = [...current];
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({
      reply_markup: buildTypesKeyboard(ctx.session.settingsDraftTypes, lang)
    }).catch(() => undefined);
  });

  bot.callbackQuery(SETTINGS_TYPES_CONFIRM_CB, async (ctx) => {
    if (!ctx.user) { await ctx.answerCallbackQuery(); return; }
    const lang = ctx.lang();
    const types = ctx.session.settingsDraftTypes ?? [];
    if (types.length === 0) {
      await ctx.answerCallbackQuery({ text: t(lang, "upload.selectAtLeastOneType"), show_alert: false });
      return;
    }
    await userRepository.updatePreferences(ctx.user._id, { defaultQuestionTypes: types });
    if (ctx.from) userCache.delete(ctx.from.id);
    ctx.session.settingsDraftTypes = undefined;
    await ctx.answerCallbackQuery();
    const { text, keyboard } = await buildSettingsPage(String(ctx.user._id), lang);
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });

  // ── Timer ────────────────────────────────────────────────────────────────

  bot.callbackQuery(SETTINGS_TIMER_CB, async (ctx) => {
    if (!ctx.user) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery();
    await safeEditMessage(ctx, t(ctx.lang(), "upload.timer.prompt"), {
      reply_markup: buildTimerKeyboard(ctx.lang())
    });
  });

  bot.callbackQuery(new RegExp(`^${SETTINGS_TIMER_PREFIX}\\d+$`), async (ctx) => {
    if (!ctx.user) { await ctx.answerCallbackQuery(); return; }
    const lang = ctx.lang();
    const seconds = parseInt(ctx.callbackQuery.data.slice(SETTINGS_TIMER_PREFIX.length), 10);
    await userRepository.updatePreferences(ctx.user._id, { defaultTimeLimitSeconds: seconds });
    if (ctx.from) userCache.delete(ctx.from.id);
    await ctx.answerCallbackQuery();
    const { text, keyboard } = await buildSettingsPage(String(ctx.user._id), lang);
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });

  // ── Shuffle ──────────────────────────────────────────────────────────────

  bot.callbackQuery(SETTINGS_SHUFFLE_CB, async (ctx) => {
    if (!ctx.user) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery();
    await safeEditMessage(ctx, t(ctx.lang(), "upload.shuffle.prompt"), {
      reply_markup: buildShuffleKeyboard(ctx.lang())
    });
  });

  bot.callbackQuery(new RegExp(`^${SETTINGS_SHUFFLE_PREFIX}(both|questions|none)$`), async (ctx) => {
    if (!ctx.user) { await ctx.answerCallbackQuery(); return; }
    const lang = ctx.lang();
    const mode = ctx.callbackQuery.data.slice(SETTINGS_SHUFFLE_PREFIX.length);
    const shuffleQ = mode === "both" || mode === "questions";
    const shuffleO = mode === "both";
    await userRepository.updatePreferences(ctx.user._id, {
      defaultShuffleQuestions: shuffleQ,
      defaultShuffleOptions: shuffleO
    });
    if (ctx.from) userCache.delete(ctx.from.id);
    await ctx.answerCallbackQuery();
    const { text, keyboard } = await buildSettingsPage(String(ctx.user._id), lang);
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });

  // ── Language ─────────────────────────────────────────────────────────────

  bot.callbackQuery(SETTINGS_LANGUAGE_CB, async (ctx) => {
    if (!ctx.user) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery();
    await safeEditMessage(ctx, t(ctx.lang(), "language.prompt"), {
      reply_markup: buildLanguageKeyboard(ctx.lang())
    });
  });

  bot.callbackQuery(new RegExp(`^${SETTINGS_LANG_PREFIX}(en|uz)$`), async (ctx) => {
    if (!ctx.user) { await ctx.answerCallbackQuery(); return; }
    const newLang = ctx.callbackQuery.data.slice(SETTINGS_LANG_PREFIX.length) as Language;
    await userRepository.updateSettings(ctx.user._id, { language: newLang, languagePrompted: true });
    if (ctx.from) userCache.delete(ctx.from.id);
    ctx.session.language = newLang;
    ctx.lang = () => newLang;
    await ctx.answerCallbackQuery();
    const { text, keyboard } = await buildSettingsPage(String(ctx.user._id), newLang);
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });

  // ── Done ─────────────────────────────────────────────────────────────────

  bot.callbackQuery(SETTINGS_DONE_CB, async (ctx) => {
    if (!ctx.user) { await ctx.answerCallbackQuery(); return; }
    const lang = ctx.lang();
    await ctx.answerCallbackQuery({ text: t(lang, "settings.saved"), show_alert: false });
    const { text, keyboard } = await buildSettingsPage(String(ctx.user._id), lang);
    await safeEditMessage(ctx, text, { reply_markup: keyboard });
  });
};
