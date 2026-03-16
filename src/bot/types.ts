import type { Context, SessionFlavor } from "grammy";
import type { Redis } from "ioredis";
import type { UserDocument } from "../db/models/user.model.js";
import type { Question, QuestionType } from "../shared/types/index.js";
import type { Language } from "../shared/i18n/index.js";

export type BotSessionState = "idle" | "uploading" | "configuring" | "reviewing" | "testing" | "done" | "editing";

export type UploadStep = "waiting_file" | "waiting_text" | "waiting_count" | "waiting_count_custom" | "waiting_types" | "waiting_shuffle" | "waiting_timer" | "waiting_title" | "waiting_action";

export type ReviewSubState = "idle" | "editing_answer";

export type EditingQuestionSubState =
  | "idle"
  | "editing_answer"
  | "adding_type"
  | "adding_text"
  | "adding_opt_a"
  | "adding_opt_b"
  | "adding_opt_c"
  | "adding_opt_d"
  | "adding_answer";

export type EditingNewQuestion = {
  id?: string;
  type?: import("../shared/types/index.js").QuestionType;
  question?: string;
  optionA?: string;
  optionB?: string;
  optionC?: string;
  optionD?: string;
};

export type TestSubState = "answering" | "self_grading" | "completed";

export type UploadedFile = {
  type: "pdf" | "image";
  fileId: string;
  /** Redis key where the base64 content is stored (short-lived, TTL 1 hour). */
  storageKey: string;
  /** Actual MIME type of the image (e.g. "image/jpeg", "image/png"). Absent for PDFs. */
  mimeType?: string;
};

export type BotSession = {
  state: BotSessionState;
  language?: Language;
  sessionRecovered?: boolean;
  uploadedFiles?: UploadedFile[];
  uploadSourceType?: "pdf" | "images" | "text";
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
  questionCount?: number;
  questionTypes?: QuestionType[];
  draftQuestions?: Question[];
  reviewIndex?: number;
  activeTestId?: string;
  currentQuestionIndex?: number;
  sessionId?: string;
  activeTestSlotId?: string;
  pendingJoinCode?: string;
  uploadedText?: string;
  settingsDraftTypes?: QuestionType[];
  // Upload sub-state
  uploadStep?: UploadStep;
  uploadTypesMessageId?: number;
  // Review sub-state
  reviewMessageId?: number;
  reviewSubState?: ReviewSubState;
  reviewEditQuestionIndex?: number;
  // Test sub-state
  testQuestions?: Question[];
  testCorrectCount?: number;
  testQuestionMessageId?: number;
  testSubState?: TestSubState;
  testSelfGradePromptMessageId?: number;
  testPendingTextAnswer?: string;
  testStartedAt?: number;  // Date.now() when the first question is sent
  questionStartedAt?: number;  // Date.now() when the current question was sent
  timeLimitSeconds?: number;  // Per-question time limit for this test (0 = no limit)
  // Edit flow
  editingTestId?: string;
  editingDraft?: import("../shared/types/index.js").Question[];
  editingTitle?: string;
  editingShuffle?: { questions: boolean; options: boolean };
  editingStep?: "menu" | "title" | "shuffle" | "questions" | "save_confirm";
  editingQuestionIndex?: number;
  editingMessageId?: number;
  editingQuestionSubState?: EditingQuestionSubState;
  editingNewQuestion?: EditingNewQuestion;
  // Onboarding
  awaitingLangForWelcome?: boolean;
};

export type BotContext = Context &
  SessionFlavor<BotSession> & {
    user?: UserDocument;
    redis: Redis;
    /** Returns the resolved UI language for this user. Always call after userMiddleware. */
    lang: () => Language;
    /** True when the user document was created in this request (first-ever interaction). */
    isNewUser?: boolean;
    /** True when /start should show a language selection prompt before the welcome screen. */
    shouldPromptLanguage?: boolean;
  };

export const createInitialSession = (): BotSession => ({
  state: "idle",
  language: undefined,
  sessionRecovered: undefined,
  uploadedFiles: undefined,
  uploadedText: undefined,
  settingsDraftTypes: undefined,
  uploadSourceType: undefined,
  shuffleQuestions: undefined,
  shuffleOptions: undefined,
  questionCount: undefined,
  questionTypes: undefined,
  draftQuestions: undefined,
  reviewIndex: undefined,
  activeTestId: undefined,
  currentQuestionIndex: undefined,
  sessionId: undefined,
  activeTestSlotId: undefined,
  pendingJoinCode: undefined,
  uploadStep: undefined,
  uploadTypesMessageId: undefined,
  reviewMessageId: undefined,
  reviewSubState: undefined,
  reviewEditQuestionIndex: undefined,
  testQuestions: undefined,
  testCorrectCount: undefined,
  testQuestionMessageId: undefined,
  testSubState: undefined,
  testSelfGradePromptMessageId: undefined,
  testPendingTextAnswer: undefined,
  testStartedAt: undefined,
  questionStartedAt: undefined,
  timeLimitSeconds: undefined,
  editingTestId: undefined,
  editingDraft: undefined,
  editingTitle: undefined,
  editingShuffle: undefined,
  editingStep: undefined,
  editingQuestionIndex: undefined,
  editingMessageId: undefined,
  editingQuestionSubState: undefined,
  editingNewQuestion: undefined,
  awaitingLangForWelcome: undefined
});

export const resetSession = (session: BotSession): BotSession => {
  Object.assign(session, createInitialSession());
  return session;
};
