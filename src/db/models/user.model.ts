import mongoose, { model, Schema, type InferSchemaType, type HydratedDocument, type Model } from "mongoose";
import { DEFAULT_QUESTION_TYPES } from "../../shared/types/index.js";

const userSchema = new Schema(
  {
    telegramId: {
      type: Number,
      required: true,
      unique: true,
      index: true
    },
    username: {
      type: String,
      trim: true
    },
    firstName: {
      type: String,
      trim: true
    },
    defaultQuestionTypes: {
      type: [String],
      enum: DEFAULT_QUESTION_TYPES,
      default: DEFAULT_QUESTION_TYPES
    },
    defaultQuestionCount: {
      type: Number,
      default: 10
    },
    totalTestsTaken: {
      type: Number,
      default: 0
    },
    language: {
      type: String,
      enum: ["en", "uz"],
      default: "en"
    }
  },
  {
    timestamps: true
  }
);

export type User = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<User>;
type UserModel = Model<User>;

export const UserModel = (mongoose.models.User as UserModel | undefined) ?? model<User>("User", userSchema);
