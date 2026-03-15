import mongoose, { model, Schema, type HydratedDocument, type InferSchemaType, type Model, type Types } from "mongoose";

const answerSchema = new Schema(
  {
    questionId: {
      type: String,
      required: true
    },
    userAnswer: {
      type: String,
      required: true
    },
    isCorrect: {
      type: Boolean,
      required: true
    },
    selfGraded: {
      type: Boolean
    }
  },
  { _id: false }
);

const testSessionSchema = new Schema({
  testId: {
    type: Schema.Types.ObjectId,
    ref: "Test",
    required: true,
    index: true  // needed for countByTestId queries
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true  // needed for findByUser / countByUser queries
  },
  answers: {
    type: [answerSchema],
    default: []
  },
  score: {
    type: Number,
    default: 0
  },
  correctCount: {
    type: Number,
    default: 0
  },
  totalQuestions: {
    type: Number,
    required: true
  },
  completedAt: {
    type: Date
  },
  startedAt: {
    type: Date,
    default: Date.now
  },
  status: {
    type: String,
    enum: ["in_progress", "completed", "abandoned"],
    default: "in_progress"
  }
}, {
  timestamps: false
});

export type TestSession = InferSchemaType<typeof testSessionSchema> & {
  _id: Types.ObjectId;
};
export type TestSessionDocument = HydratedDocument<TestSession>;
type TestSessionModel = Model<TestSession>;

export const TestSessionModel =
  (mongoose.models.TestSession as TestSessionModel | undefined) ?? model<TestSession>("TestSession", testSessionSchema);
