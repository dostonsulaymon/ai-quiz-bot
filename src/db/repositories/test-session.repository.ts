import type { Types } from "mongoose";
import type { QuestionAnswer, TestSessionStatus } from "../../shared/types/index.js";
import { TestSessionModel, type TestSessionDocument } from "../models/test-session.model.js";

type CreateTestSessionInput = {
  testId: string | Types.ObjectId;
  userId: string | Types.ObjectId;
  totalQuestions: number;
  answers?: QuestionAnswer[];
  score?: number;
  correctCount?: number;
  completedAt?: Date;
  startedAt?: Date;
  status?: TestSessionStatus;
};

type CompleteTestSessionInput = {
  score: number;
  correctCount: number;
  totalQuestions: number;
  completedAt?: Date;
};

export class TestSessionRepository {
  async create(input: CreateTestSessionInput): Promise<TestSessionDocument> {
    return TestSessionModel.create({
      ...input,
      answers: input.answers ?? [],
      score: input.score ?? 0,
      correctCount: input.correctCount ?? 0,
      startedAt: input.startedAt ?? new Date(),
      status: input.status ?? "in_progress"
    });
  }

  async updateAnswer(
    id: string | Types.ObjectId,
    answer: QuestionAnswer
  ): Promise<TestSessionDocument | null> {
    return TestSessionModel.findOneAndUpdate(
      { _id: id, "answers.questionId": { $ne: answer.questionId } },
      { $push: { answers: answer } },
      { new: true }
    ).exec();
  }

  async complete(
    id: string | Types.ObjectId,
    input: CompleteTestSessionInput
  ): Promise<TestSessionDocument | null> {
    return TestSessionModel.findByIdAndUpdate(
      id,
      {
        score: input.score,
        correctCount: input.correctCount,
        totalQuestions: input.totalQuestions,
        completedAt: input.completedAt ?? new Date(),
        status: "completed"
      },
      { new: true }
    ).exec();
  }

  async findByUser(userId: string | Types.ObjectId): Promise<TestSessionDocument[]> {
    // Only return completed sessions so in-progress runs are not exposed.
    return TestSessionModel.find({ userId, status: "completed" }).sort({ startedAt: -1 }).exec();
  }

  async findByUserPaginated(
    userId: string | Types.ObjectId,
    page: number,
    pageSize: number
  ): Promise<TestSessionDocument[]> {
    const skip = Math.max(0, page - 1) * pageSize;

    // Only return completed sessions so in-progress runs are not exposed.
    return TestSessionModel.find({ userId, status: "completed" })
      .sort({ startedAt: -1 })
      .populate("testId")
      .skip(skip)
      .limit(pageSize)
      .exec();
  }

  async countByUser(userId: string | Types.ObjectId): Promise<number> {
    // Count only completed sessions to match what findByUserPaginated returns.
    return TestSessionModel.countDocuments({ userId, status: "completed" }).exec();
  }

  async findByIdWithTest(id: string | Types.ObjectId): Promise<TestSessionDocument | null> {
    return TestSessionModel.findById(id).populate("testId").exec();
  }

  async countByTestId(testId: string | Types.ObjectId): Promise<number> {
    return TestSessionModel.countDocuments({ testId }).exec();
  }

  async findByIdAndUser(
    id: string | Types.ObjectId,
    userId: Types.ObjectId
  ): Promise<TestSessionDocument | null> {
    return TestSessionModel.findOne({ _id: id, userId }).populate("testId").exec();
  }

  async abandon(sessionId: string | Types.ObjectId): Promise<void> {
    await TestSessionModel.findByIdAndUpdate(sessionId, {
      status: "abandoned",
      completedAt: new Date()
    }).exec();
  }

  async countByTestIds(testIds: Types.ObjectId[]): Promise<Map<string, number>> {
    const results = await TestSessionModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { testId: { $in: testIds }, status: "completed" } },
      { $group: { _id: "$testId", count: { $sum: 1 } } }
    ]).exec();

    const map = new Map<string, number>();
    for (const result of results) {
      map.set(result._id.toString(), result.count);
    }
    return map;
  }
}
