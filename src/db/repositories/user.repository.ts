import type { Types } from "mongoose";
import type { QuestionType } from "../../shared/types/index.js";
import { UserModel, type UserDocument } from "../models/user.model.js";

type UpdateUserSettingsInput = {
  username?: string;
  firstName?: string;
  defaultQuestionTypes?: QuestionType[];
  defaultQuestionCount?: number;
};

export class UserRepository {
  async findOrCreate(telegramId: number): Promise<UserDocument> {
    return UserModel.findOneAndUpdate(
      { telegramId },
      { $setOnInsert: { telegramId } },
      { upsert: true, new: true }
    ).exec();
  }

  async findById(id: string | Types.ObjectId): Promise<UserDocument | null> {
    return UserModel.findById(id).exec();
  }

  async updateSettings(id: string | Types.ObjectId, updates: UpdateUserSettingsInput): Promise<UserDocument | null> {
    return UserModel.findByIdAndUpdate(id, updates, { new: true }).exec();
  }
}
