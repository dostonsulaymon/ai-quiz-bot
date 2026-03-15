import type { Context, SessionFlavor } from "grammy";
import type { ConversationFlavor } from "@grammyjs/conversations";
import type { Redis } from "ioredis";
import type { UserDocument } from "../db/models/user.model.js";
import type { Question, QuestionType } from "../shared/types/index.js";

export type BotSessionState = "idle" | "uploading" | "configuring" | "reviewing" | "testing" | "done";

export type UploadedFile = {
  type: "pdf" | "image";
  fileId: string;
  base64?: string;
  /** Actual MIME type of the image (e.g. "image/jpeg", "image/png"). Absent for PDFs. */
  mimeType?: string;
};

export type BotSession = {
  state: BotSessionState;
  sessionRecovered?: boolean;
  uploadedFiles?: UploadedFile[];
  questionCount?: number;
  questionTypes?: QuestionType[];
  draftQuestions?: Question[];
  reviewIndex?: number;
  activeTestId?: string;
  currentQuestionIndex?: number;
  sessionId?: string;
  activeTestSlotId?: string;
  pendingJoinCode?: string;
};

export type BotContext = ConversationFlavor<
  Context &
    SessionFlavor<BotSession> & {
      user?: UserDocument;
      redis: Redis;
      retryAction?: string;
    }
>;

export const createInitialSession = (): BotSession => ({
  state: "idle"
});

export const resetSession = (session: BotSession): BotSession => {
  Object.assign(session, createInitialSession());
  return session;
};
