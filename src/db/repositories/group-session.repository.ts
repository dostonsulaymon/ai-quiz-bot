import type { Types } from "mongoose";
import { GroupSessionModel, type GroupSessionDocument } from "../models/group-session.model.js";

type CreateGroupSessionInput = {
  chatId: string;
  testId: string | Types.ObjectId;
  startedBy: string;
};

export class GroupSessionRepository {
  async create(input: CreateGroupSessionInput): Promise<GroupSessionDocument> {
    return GroupSessionModel.create(input);
  }

  async findActiveByChat(chatId: string): Promise<GroupSessionDocument | null> {
    return GroupSessionModel.findOne({ chatId, status: "active" }).exec();
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
    isCorrect: boolean
  ): Promise<boolean> {
    const result = await GroupSessionModel.findOneAndUpdate(
      {
        _id: sessionId,
        status: "active",
        answers: { $not: { $elemMatch: { questionId, userId } } }
      },
      { $push: { answers: { questionId, userId, firstName, answer, isCorrect } } }
    ).exec();
    return result !== null;
  }

  async setQuestionMessageId(sessionId: string | Types.ObjectId, messageId: number): Promise<void> {
    await GroupSessionModel.updateOne({ _id: sessionId }, { $set: { questionMessageId: messageId } }).exec();
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
}
