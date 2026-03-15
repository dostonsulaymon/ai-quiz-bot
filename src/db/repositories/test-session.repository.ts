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
    return TestSessionModel.findByIdAndUpdate(
      id,
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
    return TestSessionModel.find({ userId }).sort({ startedAt: -1 }).exec();
  }
}
