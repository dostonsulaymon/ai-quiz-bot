import type { Types } from "mongoose";
import { GroupSessionModel, type GroupSessionDocument } from "../models/group-session.model.js";
import { ValidationError } from "../../shared/errors/ValidationError.js";

type CreateGroupSessionInput = {
  chatId: string;
  testId: string | Types.ObjectId;
  startedBy: string;
  hostLanguage?: string;
};

export class GroupSessionRepository {
  async create(input: CreateGroupSessionInput): Promise<GroupSessionDocument> {
    try {
      return await GroupSessionModel.create(input);
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: number }).code === 11000
      ) {
        throw new ValidationError("A quiz is already running in this group.", "GROUP_SESSION_ACTIVE");
      }
      throw error;
    }
  }

  async findActiveByChat(chatId: string): Promise<GroupSessionDocument | null> {
    return GroupSessionModel.findOne({ chatId, status: "active" }).exec();
  }

  async findById(id: string | Types.ObjectId): Promise<GroupSessionDocument | null> {
    return GroupSessionModel.findById(id).exec();
  }

  /**
   * Atomically records a user's answer for a question.
   * Returns true if the answer was newly recorded, false if the user already answered.
   */
  async addAnswer(
    sessionId: string | Types.ObjectId,
    questionId: string,
    userId: string,
    firstName: string,
    answer: string,
    isCorrect: boolean,
    username?: string
  ): Promise<boolean> {
    const answerDoc = { questionId, userId, firstName, answer, isCorrect, ...(username !== undefined ? { username } : {}) };
    const result = await GroupSessionModel.findOneAndUpdate(
      {
        _id: sessionId,
        status: "active",
        answers: { $not: { $elemMatch: { questionId, userId } } }
      },
      { $push: { answers: answerDoc } }
    ).exec();
    return result !== null;
  }

  async setQuestionMessageId(sessionId: string | Types.ObjectId, messageId: number): Promise<void> {
    await GroupSessionModel.updateOne({ _id: sessionId }, { $set: { questionMessageId: messageId } }).exec();
  }

  async setProgressMessageId(sessionId: string | Types.ObjectId, messageId: number | null): Promise<void> {
    await GroupSessionModel.updateOne({ _id: sessionId }, { $set: { progressMessageId: messageId } }).exec();
  }

  async setQuestionSentAt(sessionId: string | Types.ObjectId, sentAt: Date): Promise<void> {
    await GroupSessionModel.updateOne({ _id: sessionId }, { $set: { questionSentAt: sentAt } }).exec();
  }

  async findAllActive(): Promise<GroupSessionDocument[]> {
    return GroupSessionModel.find({ status: "active" }).exec();
  }

  async advance(sessionId: string | Types.ObjectId): Promise<GroupSessionDocument | null> {
    return GroupSessionModel.findByIdAndUpdate(
      sessionId,
      { $inc: { currentQuestionIndex: 1 } },
      { new: true }
    ).exec();
  }

  async complete(sessionId: string | Types.ObjectId): Promise<GroupSessionDocument | null> {
    return GroupSessionModel.findByIdAndUpdate(
      sessionId,
      { $set: { status: "completed" } },
      { new: true }
    ).exec();
  }

  async completeByChat(chatId: string): Promise<void> {
    await GroupSessionModel.updateMany({ chatId, status: "active" }, { $set: { status: "completed" } }).exec();
  }

  async abandonStaleSessions(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await GroupSessionModel.updateMany(
      { status: "active", startedAt: { $lt: cutoff } },
      { $set: { status: "completed" } }
    ).exec();
    return result.modifiedCount;
  }
}
