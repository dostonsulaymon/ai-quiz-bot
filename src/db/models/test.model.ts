import mongoose, { model, Schema, type HydratedDocument, type InferSchemaType, type Model, type Types } from "mongoose";
import { DEFAULT_QUESTION_TYPES } from "../../shared/types/index.js";

const questionOptionsSchema = new Schema(
  {
    A: { type: String, required: false },
    B: { type: String, required: false },
    C: { type: String, required: false },
    D: { type: String, required: false }
  },
  { _id: false }
);

const questionSchema = new Schema(
  {
    id: {
      type: String,
      required: true
    },
    type: {
      type: String,
      enum: DEFAULT_QUESTION_TYPES,
      required: true
    },
    question: {
      type: String,
      required: true
    },
    options: {
      type: questionOptionsSchema,
      required: false
    },
    correctAnswer: {
      type: String,
      required: true
    },
    explanation: {
      type: String
    }
  },
  { _id: false }
);

const testSchema = new Schema(
  {
    shareCode: {
      type: String,
      required: false,
      unique: true,
      sparse: true,
      uppercase: true,
      minlength: 6,
      maxlength: 6,
      match: /^[A-Z0-9]{6}$/
    },
    creatorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    title: {
      type: String,
      trim: true
    },
    questions: {
      type: [questionSchema],
      required: true
    },
    sourceType: {
      type: String,
      enum: ["pdf", "images", "text"],
      required: true
    },
    questionCount: {
      type: Number,
      required: true
    },
    isActive: {
      type: Boolean,
      default: true
    },
    shuffleQuestions: {
      type: Boolean,
      default: false
    },
    shuffleOptions: {
      type: Boolean,
      default: false
    },
    timeLimitSeconds: {
      type: Number,
      default: 0
    }
  },
  {
    timestamps: true
  }
);

export type Test = InferSchemaType<typeof testSchema> & {
  _id: Types.ObjectId;
};
export type TestDocument = HydratedDocument<Test>;
type TestModel = Model<Test>;

export const TestModel = (mongoose.models.Test as TestModel | undefined) ?? model<Test>("Test", testSchema);
