import { customAlphabet } from "nanoid";
import type { Types } from "mongoose";
import type { Question, TestSourceType } from "../../shared/types/index.js";
import { AppError } from "../../shared/errors/AppError.js";
import { TestModel, type TestDocument } from "../models/test.model.js";

const createShareCode = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 6);
const MAX_SHARE_CODE_RETRIES = 5;

type CreateTestInput = {
  creatorId: string | Types.ObjectId;
  title?: string;
  questions: Question[];
  sourceType: TestSourceType;
  questionCount: number;
};

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: number }).code === 11000;

export class TestRepository {
  async create(input: CreateTestInput): Promise<TestDocument> {
    for (let attempt = 1; attempt <= MAX_SHARE_CODE_RETRIES; attempt += 1) {
      try {
        const test = await TestModel.create({
          ...input,
          shareCode: createShareCode()
        });

        return test;
      } catch (error) {
        if (isDuplicateKeyError(error) && attempt < MAX_SHARE_CODE_RETRIES) {
          continue;
        }

        if (isDuplicateKeyError(error)) {
          throw new AppError("Failed to generate a unique share code", 500, error);
        }

        throw error;
      }
    }

    throw new AppError("Failed to create test", 500);
  }

  async findByShareCode(shareCode: string): Promise<TestDocument | null> {
    return TestModel.findOne({ shareCode: shareCode.toUpperCase(), isActive: true }).exec();
  }

  async findByCreator(creatorId: string | Types.ObjectId): Promise<TestDocument[]> {
    return TestModel.find({ creatorId, isActive: true }).sort({ createdAt: -1 }).exec();
  }

  async softDelete(id: string | Types.ObjectId): Promise<TestDocument | null> {
    return TestModel.findByIdAndUpdate(id, { isActive: false }, { new: true }).exec();
  }
}
