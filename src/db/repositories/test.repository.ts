import { customAlphabet } from "nanoid";
import type { Types } from "mongoose";
import type { Question, TestSourceType } from "../../shared/types/index.js";
import { AppError } from "../../shared/errors/AppError.js";
import { NotFoundError } from "../../shared/errors/NotFoundError.js";
import { TestModel, type TestDocument } from "../models/test.model.js";

const createShareCode = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 6);
const MAX_SHARE_CODE_RETRIES = 5;

type CreateTestInput = {
  creatorId: string | Types.ObjectId;
  title?: string;
  questions: Question[];
  sourceType: TestSourceType;
  questionCount: number;
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
  timeLimitSeconds?: number;
};

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: number }).code === 11000;

export class TestRepository {
  async create(input: CreateTestInput): Promise<TestDocument> {
    return TestModel.create(input);
  }

  async findByShareCode(shareCode: string): Promise<TestDocument | null> {
    return TestModel.findOne({ shareCode: shareCode.toUpperCase(), isActive: true }).exec();
  }

  async findById(id: string | Types.ObjectId): Promise<TestDocument | null> {
    return TestModel.findById(id).exec();
  }

  async ensureShareCode(id: string | Types.ObjectId): Promise<TestDocument> {
    const existingTest = await TestModel.findById(id).exec();
    if (!existingTest) {
      throw new AppError("Test not found", 404);
    }

    if (existingTest.shareCode) {
      return existingTest;
    }

    for (let attempt = 1; attempt <= MAX_SHARE_CODE_RETRIES; attempt += 1) {
      try {
        const updatedTest = await TestModel.findOneAndUpdate(
          {
            _id: id,
            $or: [{ shareCode: { $exists: false } }, { shareCode: null }, { shareCode: "" }]
          },
          { $set: { shareCode: createShareCode() } },
          { new: true }
        ).exec();

        if (updatedTest?.shareCode) {
          return updatedTest;
        }

        const reloadedTest = await TestModel.findById(id).exec();
        if (reloadedTest?.shareCode) {
          return reloadedTest;
        }
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

    throw new AppError("Failed to assign a share code", 500);
  }

  async findByCreator(creatorId: string | Types.ObjectId): Promise<TestDocument[]> {
    return TestModel.find({ creatorId, isActive: true }).sort({ createdAt: -1 }).exec();
  }

  async findByCreatorPaginated(
    creatorId: string | Types.ObjectId,
    page: number,
    pageSize: number
  ): Promise<TestDocument[]> {
    const skip = Math.max(0, page - 1) * pageSize;

    return TestModel.find({ creatorId, isActive: true })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .exec();
  }

  async countByCreator(creatorId: string | Types.ObjectId): Promise<number> {
    return TestModel.countDocuments({ creatorId, isActive: true }).exec();
  }

  async findByIdAndCreator(
    id: string | Types.ObjectId,
    creatorId: string | Types.ObjectId
  ): Promise<TestDocument | null> {
    return TestModel.findOne({ _id: id, creatorId, isActive: true }).exec();
  }

  async softDelete(id: string | Types.ObjectId): Promise<TestDocument | null> {
    return TestModel.findByIdAndUpdate(id, { isActive: false }, { new: true }).exec();
  }

  async duplicate(
    testId: string | Types.ObjectId,
    creatorId: Types.ObjectId,
    newTitle: string
  ): Promise<TestDocument> {
    const original = await TestModel.findById(testId).exec();
    if (!original) throw new NotFoundError("Test not found", "TEST_NOT_FOUND");

    const copy = new TestModel({
      title: newTitle,
      questions: original.questions.map((q) => ({ ...q.toObject() })),
      creatorId,
      sourceType: original.sourceType,
      questionCount: original.questionCount,
      shuffleQuestions: original.shuffleQuestions,
      shuffleOptions: original.shuffleOptions,
      timeLimitSeconds: original.timeLimitSeconds,
      isActive: true
    });

    return copy.save();
  }

  async updateTest(
    id: string | Types.ObjectId,
    updates: {
      title?: string;
      questions: Question[];
      questionCount: number;
      shuffleQuestions: boolean;
      shuffleOptions: boolean;
    }
  ): Promise<TestDocument | null> {
    const $set: Record<string, unknown> = {
      questions: updates.questions,
      questionCount: updates.questionCount,
      shuffleQuestions: updates.shuffleQuestions,
      shuffleOptions: updates.shuffleOptions
    };
    if (updates.title !== undefined) {
      $set["title"] = updates.title;
    }
    return TestModel.findByIdAndUpdate(id, { $set }, { new: true }).exec();
  }
}
