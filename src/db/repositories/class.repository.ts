import { customAlphabet } from "nanoid";
import type { Types } from "mongoose";
import { AppError } from "../../shared/errors/AppError.js";
import { ClassModel, type ClassDocument } from "../models/class.model.js";

const createShareSuffix = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 6);
const MAX_SHARE_CODE_RETRIES = 5;

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: number }).code === 11000;

export class ClassRepository {
  async findById(id: string | Types.ObjectId): Promise<ClassDocument | null> {
    return ClassModel.findById(id).exec();
  }

  async create(title: string, creatorId: string | Types.ObjectId): Promise<ClassDocument> {
    return ClassModel.create({ title, creatorId });
  }

  async findByCreatorPaginated(
    creatorId: string | Types.ObjectId,
    page: number,
    limit: number
  ): Promise<ClassDocument[]> {
    const skip = Math.max(0, page - 1) * limit;

    return ClassModel.find({ creatorId, isActive: true })
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();
  }

  async countByCreator(creatorId: string | Types.ObjectId): Promise<number> {
    return ClassModel.countDocuments({ creatorId, isActive: true }).exec();
  }

  async findByShareCode(code: string): Promise<ClassDocument | null> {
    return ClassModel.findOne({ shareCode: code.toUpperCase(), isActive: true }).exec();
  }

  async addTest(classId: string | Types.ObjectId, testId: string | Types.ObjectId): Promise<void> {
    await ClassModel.updateOne(
      { _id: classId, testIds: { $ne: testId }, isActive: true },
      { $push: { testIds: testId } }
    ).exec();
  }

  async removeTest(classId: string | Types.ObjectId, testId: string | Types.ObjectId): Promise<void> {
    await ClassModel.updateOne({ _id: classId }, { $pull: { testIds: testId } }).exec();
  }

  async findByIdAndCreator(
    id: string | Types.ObjectId,
    creatorId: string | Types.ObjectId
  ): Promise<ClassDocument | null> {
    return ClassModel.findOne({ _id: id, creatorId, isActive: true }).exec();
  }

  async softDelete(classId: string | Types.ObjectId): Promise<void> {
    await ClassModel.updateOne({ _id: classId }, { $set: { isActive: false } }).exec();
  }

  async ensureShareCode(classId: string | Types.ObjectId): Promise<string> {
    const existing = await ClassModel.findById(classId).exec();
    if (!existing) {
      throw new AppError("Class not found", 404);
    }

    if (existing.shareCode) {
      return existing.shareCode;
    }

    for (let attempt = 1; attempt <= MAX_SHARE_CODE_RETRIES; attempt += 1) {
      const code = `CLASS-${createShareSuffix()}`;
      try {
        const updated = await ClassModel.findOneAndUpdate(
          {
            _id: classId,
            $or: [{ shareCode: { $exists: false } }, { shareCode: null }, { shareCode: "" }]
          },
          { $set: { shareCode: code } },
          { new: true }
        ).exec();

        if (updated?.shareCode) {
          return updated.shareCode;
        }

        const reloaded = await ClassModel.findById(classId).exec();
        if (reloaded?.shareCode) {
          return reloaded.shareCode;
        }
      } catch (error) {
        if (isDuplicateKeyError(error) && attempt < MAX_SHARE_CODE_RETRIES) {
          continue;
        }

        if (isDuplicateKeyError(error)) {
          throw new AppError("Failed to generate a unique class share code", 500, error);
        }

        throw error;
      }
    }

    throw new AppError("Failed to assign a class share code", 500);
  }

  async updateTitle(classId: string | Types.ObjectId, title: string): Promise<void> {
    await ClassModel.updateOne({ _id: classId, isActive: true }, { $set: { title } }).exec();
  }
}
