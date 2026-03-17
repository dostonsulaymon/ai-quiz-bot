import mongoose, { model, Schema, type HydratedDocument, type InferSchemaType, type Model, type Types } from "mongoose";

const groupAnswerSchema = new Schema(
  {
    questionId: { type: String, required: true },
    userId: { type: String, required: true },
    firstName: { type: String, required: true },
    username: { type: String, required: false },
    answer: { type: String, required: true },
    isCorrect: { type: Boolean, required: true }
  },
  { _id: false }
);

const groupSessionSchema = new Schema(
  {
    chatId: { type: String, required: true },
    testId: { type: Schema.Types.ObjectId, ref: "Test", required: true },
    startedBy: { type: String, required: true },
    hostLanguage: { type: String, default: "en" },
    currentQuestionIndex: { type: Number, default: 0 },
    status: { type: String, enum: ["active", "completed"], default: "active" },
    answers: { type: [groupAnswerSchema], default: [] },
    questionMessageId: { type: Number },
    progressMessageId: { type: Number },
    questionSentAt: { type: Date },
    startedAt: { type: Date, default: Date.now }
  },
  { timestamps: false }
);

groupSessionSchema.index({ chatId: 1, status: 1 });
groupSessionSchema.index({ testId: 1 });
groupSessionSchema.index(
  { chatId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "active" },
    name: "unique_active_session_per_chat"
  }
);

export type GroupAnswer = {
  questionId: string;
  userId: string;
  firstName: string;
  username?: string;
  answer: string;
  isCorrect: boolean;
};

export type GroupSession = InferSchemaType<typeof groupSessionSchema> & {
  _id: Types.ObjectId;
};
export type GroupSessionDocument = HydratedDocument<GroupSession>;
type GroupSessionModel = Model<GroupSession>;

export const GroupSessionModel =
  (mongoose.models.GroupSession as GroupSessionModel | undefined) ??
  model<GroupSession>("GroupSession", groupSessionSchema);
