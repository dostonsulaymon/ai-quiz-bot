import { InlineKeyboard } from "grammy";
import { TestRepository } from "../../db/repositories/test.repository.js";
import { LeaderboardRepository } from "../../db/repositories/leaderboard.repository.js";
import { logger } from "../../shared/logger.js";
import { resetSession, type BotContext, type EditingNewQuestion } from "../types.js";
import { transitionTo } from "../state-machine.js";
import { t, type Language } from "../../shared/i18n/index.js";
import type { Question, QuestionType } from "../../shared/types/index.js";
import { safeEditMessageViaApi } from "../utils/telegram.js";

// ---------------------------------------------------------------------------
// Callback data constants
// ---------------------------------------------------------------------------

const EDIT_TITLE_CB = "edit:title";
const EDIT_TIMER_CB = "edit:timer";
const EDIT_SHUFFLE_CB = "edit:shuffle";
const EDIT_QUESTIONS_CB = "edit:questions";
const EDIT_SAVE_CB = "edit:save";
const EDIT_CANCEL_CB = "edit:cancel";
const EDIT_SAVE_YES_CB = "edit:save:yes";
const EDIT_SAVE_NO_CB = "edit:save:no";
const EDIT_MENU_BACK_CB = "edit:menu";
const EDIT_SHUFFLE_PREFIX = "edit:sh:";
const EDIT_TITLE_CANCEL_CB = "edit:title:cancel";
const EDIT_Q_PREV_CB = "edit:q:prev";
const EDIT_Q_NEXT_CB = "edit:q:next";
const EDIT_Q_EDIT_CB = "edit:q:edit";
const EDIT_Q_ANSWER_CANCEL_CB = "edit:q:answer:cancel";
const EDIT_Q_DELETE_CB = "edit:q:del";
const EDIT_Q_BACK_CB = "edit:q:back";
const EDIT_Q_ADD_CB = "edit:q:add";
const EDIT_Q_ADD_CANCEL_CB = "edit:q:add:cancel";
const EDIT_Q_NOOP_CB = "edit:q:noop";
const EDIT_Q_ADD_TYPE_PREFIX = "edit:q:add:type:";

const testRepository = new TestRepository();
const leaderboardRepository = new LeaderboardRepository();

const SEPARATOR = "━━━━━━━━━━━━━━━━";

// ---------------------------------------------------------------------------
// Keyboard builders
// ---------------------------------------------------------------------------

const buildEditMenuKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "edit.btn.title"), EDIT_TITLE_CB)
    .row()
    .text(t(lang, "edit.btn.shuffle"), EDIT_SHUFFLE_CB)
    .row()
    .text(t(lang, "edit.btn.questions"), EDIT_QUESTIONS_CB)
    .row()
    .text(t(lang, "edit.btn.save"), EDIT_SAVE_CB)
    .text(t(lang, "edit.btn.cancel"), EDIT_CANCEL_CB);

const buildShuffleKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "upload.shuffle.both"), `${EDIT_SHUFFLE_PREFIX}both`)
    .row()
    .text(t(lang, "upload.shuffle.questions"), `${EDIT_SHUFFLE_PREFIX}questions`)
    .row()
    .text(t(lang, "upload.shuffle.none"), `${EDIT_SHUFFLE_PREFIX}none`)
    .row()
    .text(t(lang, "btn.back"), EDIT_MENU_BACK_CB);

const buildQuestionCardKeyboard = (index: number, total: number, lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "review.btn.prev"), EDIT_Q_PREV_CB)
    .text(`${index + 1} / ${total}`, EDIT_Q_NOOP_CB)
    .text(t(lang, "review.btn.next"), EDIT_Q_NEXT_CB)
    .row()
    .text(t(lang, "review.btn.editAnswer"), EDIT_Q_EDIT_CB)
    .text(t(lang, "review.btn.delete"), EDIT_Q_DELETE_CB)
    .row()
    .text(t(lang, "edit.questions.btn.add"), EDIT_Q_ADD_CB)
    .text(t(lang, "edit.questions.btn.back"), EDIT_Q_BACK_CB);

const buildSaveConfirmKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "edit.save.btn.confirm_reset"), EDIT_SAVE_YES_CB)
    .row()
    .text(t(lang, "btn.cancel"), EDIT_SAVE_NO_CB);

const buildAddTypeKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard()
    .text(t(lang, "upload.type.mcq"), `${EDIT_Q_ADD_TYPE_PREFIX}mcq`)
    .text(t(lang, "upload.type.truefalse"), `${EDIT_Q_ADD_TYPE_PREFIX}truefalse`)
    .row()
    .text(t(lang, "upload.type.short"), `${EDIT_Q_ADD_TYPE_PREFIX}short`)
    .text(t(lang, "upload.type.fill"), `${EDIT_Q_ADD_TYPE_PREFIX}fill`);

const buildTitleCancelKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard().text(t(lang, "edit.cancel_btn"), EDIT_TITLE_CANCEL_CB);

const buildEditAnswerCancelKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard().text(t(lang, "edit.cancel_btn"), EDIT_Q_ANSWER_CANCEL_CB);

const buildAddQuestionCancelKeyboard = (lang: Language): InlineKeyboard =>
  new InlineKeyboard().text(t(lang, "edit.cancel_btn"), EDIT_Q_ADD_CANCEL_CB);

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const formatEditMenu = (title: string, questionCount: number, lang: Language): string =>
  [
    SEPARATOR,
    t(lang, "edit.menu.title", { title }),
    t(lang, "edit.menu.questions", { count: questionCount }),
    SEPARATOR
  ].join("\n");

const formatQuestionCard = (question: Question, index: number, total: number, lang: Language): string => {
  const lines = [t(lang, "review.card.header", { n: index + 1, total }), "", question.question];

  if (question.type === "mcq" && question.options) {
    lines.push(
      "",
      `A. ${question.options.A}`,
      `B. ${question.options.B}`,
      `C. ${question.options.C}`,
      `D. ${question.options.D}`
    );
  }

  lines.push("", t(lang, "review.card.answer", { answer: question.correctAnswer }));

  if (question.explanation) {
    lines.push("", t(lang, "review.card.explanation", { explanation: question.explanation }));
  }

  return lines.join("\n");
};

const generateQuestionId = (): string =>
  `q_edit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

// ---------------------------------------------------------------------------
// Enter edit flow
// ---------------------------------------------------------------------------

export const enterEditFlow = async (ctx: BotContext, testId: string): Promise<void> => {
  const lang = ctx.lang();

  if (!ctx.user) {
    await ctx.reply(t(lang, "error.userLoad"));
    return;
  }

  const test = await testRepository.findByIdAndCreator(testId, ctx.user._id);
  if (!test) {
    await ctx.reply(t(lang, "error.not_owner"));
    return;
  }

  transitionTo(ctx.session, "editing", "enterEditFlow");
  ctx.session.editingTestId = testId;
  ctx.session.editingDraft = test.questions as Question[];
  ctx.session.editingTitle = test.title ?? undefined;
  ctx.session.editingShuffle = {
    questions: test.shuffleQuestions ?? false,
    options: test.shuffleOptions ?? false
  };
  ctx.session.editingStep = "menu";
  ctx.session.editingQuestionIndex = 0;
  ctx.session.editingMessageId = undefined;
  ctx.session.editingQuestionSubState = "idle";
  ctx.session.editingNewQuestion = undefined;

  logger.info("Edit flow entered", { event: "edit.flow.enter", userId: ctx.from?.id, testId });

  await showEditMenu(ctx);
};

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

export const editRouter = async (ctx: BotContext): Promise<void> => {
  const step = ctx.session.editingStep ?? "menu";

  if (step === "title") {
    await handleTitle(ctx);
    return;
  }

  if (step === "shuffle") {
    await handleShuffle(ctx);
    return;
  }

  if (step === "questions") {
    await handleQuestions(ctx);
    return;
  }

  if (step === "save_confirm") {
    await handleSaveConfirm(ctx);
    return;
  }

  await handleMenu(ctx);
};

// ---------------------------------------------------------------------------
// Show edit menu
// ---------------------------------------------------------------------------

const showEditMenu = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  ctx.session.editingStep = "menu";
  ctx.session.editingQuestionSubState = "idle";
  ctx.session.editingMessageId = undefined;
  ctx.session.editingNewQuestion = undefined;

  const title = ctx.session.editingTitle ?? t(lang, "common.untitledTest");
  const count = ctx.session.editingDraft?.length ?? 0;

  await ctx.reply(formatEditMenu(title, count, lang), { reply_markup: buildEditMenuKeyboard(lang) });
};

const restoreQuestionsView = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const questions = ctx.session.editingDraft ?? [];
  const messageId = ctx.session.editingMessageId;

  if (questions.length === 0 || !messageId) {
    await showEditMenu(ctx);
    return;
  }

  const index = Math.min(ctx.session.editingQuestionIndex ?? 0, questions.length - 1);
  ctx.session.editingQuestionIndex = index;
  await safeEditMessageViaApi(
    ctx.api,
    ctx.chatId!,
    messageId,
    formatQuestionCard(questions[index]!, index, questions.length, lang),
    { reply_markup: buildQuestionCardKeyboard(index, questions.length, lang) }
  );
};

// ---------------------------------------------------------------------------
// Step: menu
// ---------------------------------------------------------------------------

const handleMenu = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const data = ctx.callbackQuery?.data;

  if (!data) {
    await ctx.reply(t(lang, "review.useButtons"));
    return;
  }

  if (data === EDIT_TITLE_CB) {
    await ctx.answerCallbackQuery();
    ctx.session.editingStep = "title";
    await ctx.reply(t(lang, "edit.title.prompt"), { reply_markup: buildTitleCancelKeyboard(lang) });
    return;
  }

  if (data === EDIT_SHUFFLE_CB) {
    await ctx.answerCallbackQuery();
    ctx.session.editingStep = "shuffle";
    await ctx.reply(t(lang, "upload.shuffle.prompt"), { reply_markup: buildShuffleKeyboard(lang) });
    return;
  }

  if (data === EDIT_QUESTIONS_CB) {
    await ctx.answerCallbackQuery();
    await enterQuestionsView(ctx);
    return;
  }

  if (data === EDIT_SAVE_CB) {
    await ctx.answerCallbackQuery();
    await initiateSave(ctx);
    return;
  }

  if (data === EDIT_CANCEL_CB) {
    await ctx.answerCallbackQuery();
    resetSession(ctx.session);
    await ctx.reply(t(lang, "edit.save.cancelled"));
    return;
  }

  if (data === EDIT_TIMER_CB) {
    await ctx.answerCallbackQuery({ text: t(lang, "edit.btn.timer"), show_alert: false });
    return;
  }

  await ctx.answerCallbackQuery();
};

// ---------------------------------------------------------------------------
// Step: title
// ---------------------------------------------------------------------------

const handleTitle = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();

  if (ctx.callbackQuery?.data === EDIT_TITLE_CANCEL_CB) {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => undefined);
    await showEditMenu(ctx);
    return;
  }

  const text = ctx.msg?.text?.trim();

  if (!text) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    await ctx.reply(t(lang, "edit.title.prompt"), { reply_markup: buildTitleCancelKeyboard(lang) });
    return;
  }

  ctx.session.editingTitle = text;
  logger.info("Edit title updated", { event: "edit.title.updated", userId: ctx.from?.id });
  await ctx.reply(t(lang, "edit.title_updated"));
  await showEditMenu(ctx);
};

// ---------------------------------------------------------------------------
// Step: shuffle
// ---------------------------------------------------------------------------

const handleShuffle = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const data = ctx.callbackQuery?.data;

  if (data === EDIT_MENU_BACK_CB) {
    await ctx.answerCallbackQuery();
    await showEditMenu(ctx);
    return;
  }

  if (!data?.startsWith(EDIT_SHUFFLE_PREFIX)) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    await ctx.reply(t(lang, "upload.useShuffleButtons"));
    return;
  }

  await ctx.answerCallbackQuery();
  const choice = data.slice(EDIT_SHUFFLE_PREFIX.length);

  ctx.session.editingShuffle = {
    questions: choice === "both" || choice === "questions",
    options: choice === "both"
  };

  logger.info("Edit shuffle updated", { event: "edit.shuffle.updated", userId: ctx.from?.id, choice });
  await showEditMenu(ctx);
};

// ---------------------------------------------------------------------------
// Step: questions — entry
// ---------------------------------------------------------------------------

const enterQuestionsView = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const questions = ctx.session.editingDraft ?? [];

  ctx.session.editingStep = "questions";
  ctx.session.editingQuestionIndex = 0;
  ctx.session.editingQuestionSubState = "idle";

  if (questions.length === 0) {
    ctx.session.editingQuestionSubState = "adding_type";
    ctx.session.editingNewQuestion = { id: generateQuestionId() };
    await ctx.reply(t(lang, "edit.add.type_prompt"), { reply_markup: buildAddTypeKeyboard(lang) });
    return;
  }

  const msg = await ctx.reply(formatQuestionCard(questions[0]!, 0, questions.length, lang), {
    reply_markup: buildQuestionCardKeyboard(0, questions.length, lang)
  });
  ctx.session.editingMessageId = msg.message_id;
};

// ---------------------------------------------------------------------------
// Step: questions — router
// ---------------------------------------------------------------------------

const handleQuestions = async (ctx: BotContext): Promise<void> => {
  const subState = ctx.session.editingQuestionSubState ?? "idle";

  if (subState === "editing_answer") {
    await handleEditingAnswer(ctx);
    return;
  }

  if (subState !== "idle") {
    await handleAddingQuestion(ctx);
    return;
  }

  await handleQuestionsIdle(ctx);
};

// ---------------------------------------------------------------------------
// Questions idle — card button handling
// ---------------------------------------------------------------------------

const handleQuestionsIdle = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const data = ctx.callbackQuery?.data;
  const questions = ctx.session.editingDraft ?? [];
  const index = ctx.session.editingQuestionIndex ?? 0;
  const messageId = ctx.session.editingMessageId;

  if (!data) {
    await ctx.reply(t(lang, "review.useButtons"));
    return;
  }

  if (data === EDIT_Q_NOOP_CB) {
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === EDIT_Q_BACK_CB) {
    await ctx.answerCallbackQuery();
    await showEditMenu(ctx);
    return;
  }

  if (data === EDIT_Q_ADD_CB) {
    await ctx.answerCallbackQuery();
    ctx.session.editingQuestionSubState = "adding_type";
    ctx.session.editingNewQuestion = { id: generateQuestionId() };
    await ctx.reply(t(lang, "edit.add.type_prompt"), { reply_markup: buildAddTypeKeyboard(lang) });
    return;
  }

  if (questions.length === 0) {
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === EDIT_Q_PREV_CB) {
    await ctx.answerCallbackQuery();
    const nextIndex = index === 0 ? questions.length - 1 : index - 1;
    ctx.session.editingQuestionIndex = nextIndex;
    if (messageId) {
      await safeEditMessageViaApi(
        ctx.api, ctx.chatId!, messageId,
        formatQuestionCard(questions[nextIndex]!, nextIndex, questions.length, lang),
        { reply_markup: buildQuestionCardKeyboard(nextIndex, questions.length, lang) }
      );
    }
    return;
  }

  if (data === EDIT_Q_NEXT_CB) {
    await ctx.answerCallbackQuery();
    const nextIndex = (index + 1) % questions.length;
    ctx.session.editingQuestionIndex = nextIndex;
    if (messageId) {
      await safeEditMessageViaApi(
        ctx.api, ctx.chatId!, messageId,
        formatQuestionCard(questions[nextIndex]!, nextIndex, questions.length, lang),
        { reply_markup: buildQuestionCardKeyboard(nextIndex, questions.length, lang) }
      );
    }
    return;
  }

  if (data === EDIT_Q_EDIT_CB) {
    await ctx.answerCallbackQuery();
    const question = questions[index];
    if (!question) return;

    ctx.session.editingQuestionSubState = "editing_answer";

    const hint =
      question.type === "mcq"
        ? t(lang, "review.editHintMcq")
        : question.type === "truefalse"
          ? t(lang, "review.editHintTrueFalse")
          : t(lang, "review.editHintOpen");

    await ctx.reply(hint, { reply_markup: buildEditAnswerCancelKeyboard(lang) });
    return;
  }

  if (data === EDIT_Q_DELETE_CB) {
    await ctx.answerCallbackQuery();
    questions.splice(index, 1);
    ctx.session.editingDraft = questions;
    logger.info("Edit question deleted", { event: "edit.question.deleted", userId: ctx.from?.id, remaining: questions.length });

    if (questions.length === 0) {
      ctx.session.editingQuestionIndex = 0;
      ctx.session.editingMessageId = undefined;
      ctx.session.editingQuestionSubState = "adding_type";
      ctx.session.editingNewQuestion = { id: generateQuestionId() };
      if (messageId) {
        await safeEditMessageViaApi(ctx.api, ctx.chatId!, messageId, t(lang, "review.noQuestionsRemain"));
      }
      await ctx.reply(t(lang, "edit.add.type_prompt"), { reply_markup: buildAddTypeKeyboard(lang) });
      return;
    }

    const nextIndex = Math.min(index, questions.length - 1);
    ctx.session.editingQuestionIndex = nextIndex;
    if (messageId) {
      await safeEditMessageViaApi(
        ctx.api, ctx.chatId!, messageId,
        formatQuestionCard(questions[nextIndex]!, nextIndex, questions.length, lang),
        { reply_markup: buildQuestionCardKeyboard(nextIndex, questions.length, lang) }
      );
    }
    return;
  }

  await ctx.answerCallbackQuery();
};

// ---------------------------------------------------------------------------
// Editing answer sub-state
// ---------------------------------------------------------------------------

const handleEditingAnswer = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();

  if (ctx.callbackQuery?.data === EDIT_Q_ANSWER_CANCEL_CB) {
    ctx.session.editingQuestionSubState = "idle";
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => undefined);
    await restoreQuestionsView(ctx);
    return;
  }

  const rawAnswer = ctx.msg?.text?.trim();

  if (!rawAnswer) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    await ctx.reply(t(lang, "review.typeValidAnswer"));
    return;
  }

  const questions = ctx.session.editingDraft ?? [];
  const index = ctx.session.editingQuestionIndex ?? 0;
  const question = questions[index];

  if (!question) {
    ctx.session.editingQuestionSubState = "idle";
    await ctx.reply(t(lang, "review.questionGone"));
    return;
  }

  if (question.type === "mcq") {
    const normalized = rawAnswer.toUpperCase();
    if (!["A", "B", "C", "D"].includes(normalized)) {
      await ctx.reply(t(lang, "review.mcqAnswerInvalid"));
      return;
    }
    question.correctAnswer = normalized;
  } else if (question.type === "truefalse") {
    const lower = rawAnswer.toLowerCase();
    if (lower !== "true" && lower !== "false") {
      await ctx.reply(t(lang, "review.tfAnswerInvalid"));
      return;
    }
    question.correctAnswer = lower === "true" ? "True" : "False";
  } else {
    question.correctAnswer = rawAnswer;
  }

  questions[index] = question;
  ctx.session.editingDraft = questions;
  ctx.session.editingQuestionSubState = "idle";
  logger.info("Edit answer updated", { event: "edit.answer.updated", userId: ctx.from?.id, questionIndex: index });
  await ctx.reply(t(lang, "edit.answer_updated"));

  const messageId = ctx.session.editingMessageId;
  if (messageId) {
    await safeEditMessageViaApi(
      ctx.api, ctx.chatId!, messageId,
      formatQuestionCard(question, index, questions.length, lang),
      { reply_markup: buildQuestionCardKeyboard(index, questions.length, lang) }
    );
  }
};

// ---------------------------------------------------------------------------
// Add question flow
// ---------------------------------------------------------------------------

const handleAddingQuestion = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const subState = ctx.session.editingQuestionSubState ?? "adding_type";
  const data = ctx.callbackQuery?.data;
  const text = ctx.msg?.text?.trim();

  if (data === EDIT_Q_ADD_CANCEL_CB) {
    ctx.session.editingQuestionSubState = "idle";
    ctx.session.editingNewQuestion = undefined;
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => undefined);
    await restoreQuestionsView(ctx);
    return;
  }

  if (subState === "adding_type") {
    if (!data?.startsWith(EDIT_Q_ADD_TYPE_PREFIX)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      await ctx.reply(t(lang, "edit.add.type_prompt"), { reply_markup: buildAddTypeKeyboard(lang) });
      return;
    }
    await ctx.answerCallbackQuery();
    const type = data.slice(EDIT_Q_ADD_TYPE_PREFIX.length) as QuestionType;
    ctx.session.editingNewQuestion = { ...ctx.session.editingNewQuestion, type };
    ctx.session.editingQuestionSubState = "adding_text";
    await ctx.reply(t(lang, "edit.add.question_prompt"), { reply_markup: buildAddQuestionCancelKeyboard(lang) });
    return;
  }

  if (subState === "adding_text") {
    if (!text) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      await ctx.reply(t(lang, "edit.add.question_prompt"), { reply_markup: buildAddQuestionCancelKeyboard(lang) });
      return;
    }
    ctx.session.editingNewQuestion = { ...ctx.session.editingNewQuestion, question: text };
    const type = ctx.session.editingNewQuestion?.type;
    if (type === "mcq") {
      ctx.session.editingQuestionSubState = "adding_opt_a";
      await ctx.reply(t(lang, "edit.add.option_a_prompt"), { reply_markup: buildAddQuestionCancelKeyboard(lang) });
    } else {
      ctx.session.editingQuestionSubState = "adding_answer";
      await ctx.reply(t(lang, "edit.add.answer_prompt"), { reply_markup: buildAddQuestionCancelKeyboard(lang) });
    }
    return;
  }

  if (subState === "adding_opt_a") {
    if (!text) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      await ctx.reply(t(lang, "edit.add.option_a_prompt"), { reply_markup: buildAddQuestionCancelKeyboard(lang) });
      return;
    }
    ctx.session.editingNewQuestion = { ...ctx.session.editingNewQuestion, optionA: text };
    ctx.session.editingQuestionSubState = "adding_opt_b";
    await ctx.reply(t(lang, "edit.add.option_b_prompt"), { reply_markup: buildAddQuestionCancelKeyboard(lang) });
    return;
  }

  if (subState === "adding_opt_b") {
    if (!text) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      await ctx.reply(t(lang, "edit.add.option_b_prompt"), { reply_markup: buildAddQuestionCancelKeyboard(lang) });
      return;
    }
    ctx.session.editingNewQuestion = { ...ctx.session.editingNewQuestion, optionB: text };
    ctx.session.editingQuestionSubState = "adding_opt_c";
    await ctx.reply(t(lang, "edit.add.option_c_prompt"), { reply_markup: buildAddQuestionCancelKeyboard(lang) });
    return;
  }

  if (subState === "adding_opt_c") {
    if (!text) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      await ctx.reply(t(lang, "edit.add.option_c_prompt"), { reply_markup: buildAddQuestionCancelKeyboard(lang) });
      return;
    }
    ctx.session.editingNewQuestion = { ...ctx.session.editingNewQuestion, optionC: text };
    ctx.session.editingQuestionSubState = "adding_opt_d";
    await ctx.reply(t(lang, "edit.add.option_d_prompt"), { reply_markup: buildAddQuestionCancelKeyboard(lang) });
    return;
  }

  if (subState === "adding_opt_d") {
    if (!text) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      await ctx.reply(t(lang, "edit.add.option_d_prompt"), { reply_markup: buildAddQuestionCancelKeyboard(lang) });
      return;
    }
    ctx.session.editingNewQuestion = { ...ctx.session.editingNewQuestion, optionD: text };
    ctx.session.editingQuestionSubState = "adding_answer";
    await ctx.reply(t(lang, "edit.add.answer_prompt"), { reply_markup: buildAddQuestionCancelKeyboard(lang) });
    return;
  }

  if (subState === "adding_answer") {
    if (!text) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      await ctx.reply(t(lang, "edit.add.answer_prompt"), { reply_markup: buildAddQuestionCancelKeyboard(lang) });
      return;
    }

    const draft = ctx.session.editingNewQuestion;
    if (!draft?.type || !draft?.question || !draft?.id) {
      ctx.session.editingQuestionSubState = "idle";
      await showEditMenu(ctx);
      return;
    }

    let answer = text;
    if (draft.type === "mcq") {
      answer = text.toUpperCase();
      if (!["A", "B", "C", "D"].includes(answer)) {
        await ctx.reply(t(lang, "review.mcqAnswerInvalid"));
        return;
      }
    } else if (draft.type === "truefalse") {
      const lower = text.toLowerCase();
      if (lower !== "true" && lower !== "false") {
        await ctx.reply(t(lang, "review.tfAnswerInvalid"));
        return;
      }
      answer = lower === "true" ? "True" : "False";
    }

    const newQuestion: Question = {
      id: draft.id,
      type: draft.type as QuestionType,
      question: draft.question,
      correctAnswer: answer,
      ...(draft.type === "mcq" && {
        options: {
          A: draft.optionA ?? "",
          B: draft.optionB ?? "",
          C: draft.optionC ?? "",
          D: draft.optionD ?? ""
        }
      })
    };

    const questions = ctx.session.editingDraft ?? [];
    questions.push(newQuestion);
    ctx.session.editingDraft = questions;

    const newIndex = questions.length - 1;
    ctx.session.editingQuestionIndex = newIndex;
    ctx.session.editingNewQuestion = undefined;
    ctx.session.editingQuestionSubState = "idle";

    logger.info("Edit question added", {
      event: "edit.question.added",
      userId: ctx.from?.id,
      type: newQuestion.type,
      total: questions.length
    });

    const msg = await ctx.reply(
      formatQuestionCard(newQuestion, newIndex, questions.length, lang),
      { reply_markup: buildQuestionCardKeyboard(newIndex, questions.length, lang) }
    );
    ctx.session.editingMessageId = msg.message_id;
    return;
  }

  // Unknown sub-state — fall back to menu
  ctx.session.editingQuestionSubState = "idle";
  await showEditMenu(ctx);
};

// ---------------------------------------------------------------------------
// Save flow
// ---------------------------------------------------------------------------

const initiateSave = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const testId = ctx.session.editingTestId;

  if (!testId || !ctx.user) {
    resetSession(ctx.session);
    await ctx.reply(t(lang, "error.session_corrupted"));
    return;
  }

  const participantCount = await leaderboardRepository.getParticipantCount(testId);

  if (participantCount > 0) {
    ctx.session.editingStep = "save_confirm";
    await ctx.reply(
      t(lang, "edit.save.leaderboard_warning", { count: participantCount }),
      { reply_markup: buildSaveConfirmKeyboard(lang) }
    );
    return;
  }

  await performSave(ctx);
};

const handleSaveConfirm = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const data = ctx.callbackQuery?.data;

  if (data === EDIT_SAVE_YES_CB) {
    await ctx.answerCallbackQuery();
    await performSave(ctx);
    return;
  }

  if (data === EDIT_SAVE_NO_CB) {
    await ctx.answerCallbackQuery();
    await showEditMenu(ctx);
    return;
  }

  if (ctx.callbackQuery) await ctx.answerCallbackQuery();
};

const performSave = async (ctx: BotContext): Promise<void> => {
  const lang = ctx.lang();
  const testId = ctx.session.editingTestId;

  if (!testId || !ctx.user) {
    resetSession(ctx.session);
    await ctx.reply(t(lang, "error.session_corrupted"));
    return;
  }

  const questions = ctx.session.editingDraft ?? [];
  const title = ctx.session.editingTitle;
  const shuffle = ctx.session.editingShuffle;

  await testRepository.updateTest(testId, {
    title,
    questions,
    questionCount: questions.length,
    shuffleQuestions: shuffle?.questions ?? false,
    shuffleOptions: shuffle?.options ?? false
  });

  await leaderboardRepository.deleteByTestId(testId);

  logger.info("Test edited and saved", {
    event: "edit.saved",
    userId: ctx.from?.id,
    testId,
    questionCount: questions.length
  });

  resetSession(ctx.session);
  await ctx.reply(t(lang, "edit.save.confirm"));
};
