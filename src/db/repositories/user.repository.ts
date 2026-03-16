import type { Types } from "mongoose";
import type { QuestionType } from "../../shared/types/index.js";
import { UserModel, type UserDocument } from "../models/user.model.js";

type UpdateUserSettingsInput = {
  username?: string;
  firstName?: string;
  defaultQuestionTypes?: QuestionType[];
  defaultQuestionCount?: number;
  language?: string;
  languagePrompted?: boolean;
};

export class UserRepository {
  async findOrCreate(telegramId: number): Promise<UserDocument> {
    // upsert: true + new: true guarantees a document is returned; the non-null
    // assertion is safe here and avoids forcing all callers to handle null.
    const doc = await UserModel.findOneAndUpdate(
      { telegramId },
      { $setOnInsert: { telegramId } },
      { upsert: true, new: true }
    ).exec();

    if (!doc) {
      // Should never happen with upsert: true + new: true, but satisfies types
      // and gives a clear error if MongoDB behaves unexpectedly.
      throw new Error(`findOrCreate failed to return a document for telegramId ${telegramId}`);
    }

    return doc;
  }

  async findById(id: string | Types.ObjectId): Promise<UserDocument | null> {
    return UserModel.findById(id).exec();
  }

  async findByTelegramId(telegramId: number): Promise<UserDocument | null> {
    return UserModel.findOne({ telegramId }).exec();
  }

  async updateSettings(id: string | Types.ObjectId, updates: UpdateUserSettingsInput): Promise<UserDocument | null> {
    return UserModel.findByIdAndUpdate(id, updates, { new: true }).exec();
  }

  async incrementTotalTestsTaken(id: string | Types.ObjectId): Promise<UserDocument | null> {
    return UserModel.findByIdAndUpdate(id, { $inc: { totalTestsTaken: 1 } }, { new: true }).exec();
  }
}
