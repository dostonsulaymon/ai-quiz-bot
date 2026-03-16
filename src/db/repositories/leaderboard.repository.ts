import { Types } from "mongoose";
import { LeaderboardEntryModel, type LeaderboardEntry } from "../models/leaderboard.model.js";

type UpsertEntryInput = {
  testId: string | Types.ObjectId;
  userId: string | Types.ObjectId;
  firstName: string;
  username?: string;
  score: number;
  correctCount: number;
  totalQuestions: number;
  timeTakenSeconds: number;
};

export class LeaderboardRepository {
  /** Upsert: only update if the new score beats the existing one, or ties on score but is faster. */
  async upsertEntry(entry: UpsertEntryInput): Promise<void> {
    const { testId, userId, username, ...fields } = entry;
    const setDoc = { ...fields, completedAt: new Date(), ...(username !== undefined ? { username } : {}) };

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
        $set: setDoc
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
    // Explicit ObjectId cast: aggregation pipelines bypass Mongoose's auto-casting.
    const testOid = new Types.ObjectId(testId.toString());
    const userOid = new Types.ObjectId(userId.toString());

    // Query 1: fetch the user's entry and total participant count in one $facet round-trip.
    type FacetResult = { userEntry: LeaderboardEntry[]; total: Array<{ count: number }> };
    const [facet] = await LeaderboardEntryModel.aggregate<FacetResult>([
      { $match: { testId: testOid } },
      {
        $facet: {
          userEntry: [{ $match: { userId: userOid } }, { $limit: 1 }],
          total: [{ $count: "count" }]
        }
      }
    ]);

    const totalParticipants = facet?.total[0]?.count ?? 0;
    const entry = (facet?.userEntry[0] ?? null) as LeaderboardEntry | null;

    if (!entry) {
      return { entry: null, rank: 0, totalParticipants };
    }

    // Query 2: count entries that strictly outrank this user.
    // Tiebreaker rules:
    //   timeTakenSeconds === 0 → "no timer used"; ranks after any timed entry at the same score.
    //   timeTakenSeconds > 0  → timed entry; lower time ranks higher among tied scores.
    const aboveFilter =
      entry.timeTakenSeconds === 0
        ? {
            testId: testOid,
            $or: [
              { score: { $gt: entry.score } },
              // Any timed entry (time > 0) at the same score beats an untimed entry
              { score: entry.score, timeTakenSeconds: { $gt: 0 } }
            ]
          }
        : {
            testId: testOid,
            $or: [
              { score: { $gt: entry.score } },
              // Faster timed entries at the same score; exclude untimed (time === 0) entries
              { score: entry.score, timeTakenSeconds: { $gt: 0, $lt: entry.timeTakenSeconds } }
            ]
          };

    const rank = (await LeaderboardEntryModel.countDocuments(aboveFilter).exec()) + 1;

    return { entry, rank, totalParticipants };
  }

  /** Total number of participants who have a leaderboard entry for a test. */
  async getParticipantCount(testId: string | Types.ObjectId): Promise<number> {
    return LeaderboardEntryModel.countDocuments({ testId }).exec();
  }

  /** Batch variant of getParticipantCount — one aggregation for all requested test IDs. */
  async getParticipantCounts(testIds: Types.ObjectId[]): Promise<Map<string, number>> {
    if (testIds.length === 0) return new Map();

    const results = await LeaderboardEntryModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { testId: { $in: testIds } } },
      { $group: { _id: "$testId", count: { $sum: 1 } } }
    ]);

    const map = new Map<string, number>();
    for (const r of results) {
      map.set(r._id.toString(), r.count);
    }
    return map;
  }

  /** Delete all leaderboard entries for a test (called when test is edited). */
  async deleteByTestId(testId: string | Types.ObjectId): Promise<void> {
    await LeaderboardEntryModel.deleteMany({ testId }).exec();
  }
}
