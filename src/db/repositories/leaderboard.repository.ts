import type { Types } from "mongoose";
import { LeaderboardEntryModel, type LeaderboardEntry } from "../models/leaderboard.model.js";

type UpsertEntryInput = {
  testId: string | Types.ObjectId;
  userId: string | Types.ObjectId;
  firstName: string;
  score: number;
  correctCount: number;
  totalQuestions: number;
  timeTakenSeconds: number;
};

export class LeaderboardRepository {
  /** Upsert: only update if the new score beats the existing one, or ties on score but is faster. */
  async upsertEntry(entry: UpsertEntryInput): Promise<void> {
    const { testId, userId, ...fields } = entry;

    await LeaderboardEntryModel.findOneAndUpdate(
      {
        testId,
        userId,
        $or: [
          { score: { $lt: fields.score } },
          { score: fields.score, timeTakenSeconds: { $gt: fields.timeTakenSeconds } },
          // No existing entry yet — covered by upsert:true
        ]
      },
      {
        $set: {
          ...fields,
          completedAt: new Date()
        }
      },
      { upsert: true }
    ).exec().catch((error: unknown) => {
      // Ignore duplicate key errors that can occur on concurrent upserts
      // when no existing document matched the filter but another request
      // already inserted one. The better score will win on the next update.
      const isDuplicate =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: number }).code === 11000;
      if (!isDuplicate) throw error;
    });
  }

  /** Top N entries for a test, ranked by score desc then timeTakenSeconds asc. */
  async getTopEntries(testId: string | Types.ObjectId, limit: number): Promise<LeaderboardEntry[]> {
    return LeaderboardEntryModel.find({ testId })
      .sort({ score: -1, timeTakenSeconds: 1 })
      .limit(limit)
      .lean()
      .exec() as Promise<LeaderboardEntry[]>;
  }

  /** Return the user's entry and their 1-based rank for a given test. */
  async getUserRank(
    testId: string | Types.ObjectId,
    userId: string | Types.ObjectId
  ): Promise<{ entry: LeaderboardEntry | null; rank: number; totalParticipants: number }> {
    const entry = (await LeaderboardEntryModel.findOne({ testId, userId }).lean().exec()) as LeaderboardEntry | null;

    const totalParticipants = await LeaderboardEntryModel.countDocuments({ testId }).exec();

    if (!entry) {
      return { entry: null, rank: 0, totalParticipants };
    }

    // Rank = number of entries that strictly beat this one + 1
    const ahead = await LeaderboardEntryModel.countDocuments({
      testId,
      $or: [
        { score: { $gt: entry.score } },
        { score: entry.score, timeTakenSeconds: { $lt: entry.timeTakenSeconds } }
      ]
    }).exec();

    return { entry, rank: ahead + 1, totalParticipants };
  }

  /** Total number of participants who have a leaderboard entry for a test. */
  async getParticipantCount(testId: string | Types.ObjectId): Promise<number> {
    return LeaderboardEntryModel.countDocuments({ testId }).exec();
  }

  /** Delete all leaderboard entries for a test (called when test is edited). */
  async deleteByTestId(testId: string | Types.ObjectId): Promise<void> {
    await LeaderboardEntryModel.deleteMany({ testId }).exec();
  }
}
