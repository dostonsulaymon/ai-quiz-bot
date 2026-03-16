/// <reference types="vitest" />

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LeaderboardRepository } from "./leaderboard.repository.js";
import { LeaderboardEntryModel } from "../models/leaderboard.model.js";

vi.mock("../models/leaderboard.model.js", () => {
  const state = {
    entries: [] as Array<Record<string, unknown>>
  };

  const normalizeId = (value: unknown): string => String(value);
  const matchesCandidate = (
    entry: Record<string, unknown>,
    filter: Record<string, unknown>
  ): boolean => {
    const sameRecord =
      normalizeId(entry.testId) === normalizeId(filter.testId) &&
      normalizeId(entry.userId) === normalizeId(filter.userId);

    if (!sameRecord) return false;

    const clauses = Array.isArray(filter.$or) ? filter.$or as Array<Record<string, unknown>> : [];
    if (clauses.length === 0) return true;

    return clauses.some((clause) => {
      const score = Number(entry.score);
      const timeTakenSeconds = Number(entry.timeTakenSeconds);
      const scoreFilter = clause.score;
      const lowerScore = typeof scoreFilter === "object" && scoreFilter !== null && "$lt" in scoreFilter
        ? Number((scoreFilter as { $lt: number }).$lt)
        : undefined;
      const slowerTime = typeof clause.timeTakenSeconds === "object" && clause.timeTakenSeconds !== null && "$gt" in clause.timeTakenSeconds
        ? Number((clause.timeTakenSeconds as { $gt: number }).$gt)
        : undefined;

      if (lowerScore !== undefined) {
        return score < lowerScore;
      }

      if (typeof scoreFilter === "number" && slowerTime !== undefined) {
        return score === scoreFilter && timeTakenSeconds > slowerTime;
      }

      return false;
    });
  };

  const findOneAndUpdate = vi.fn((filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => ({
    exec: vi.fn(async () => {
      const existingIndex = state.entries.findIndex((entry) =>
        normalizeId(entry.testId) === normalizeId(filter.testId) &&
        normalizeId(entry.userId) === normalizeId(filter.userId)
      );

      if (existingIndex === -1) {
        state.entries.push({
          testId: filter.testId,
          userId: filter.userId,
          ...update.$set
        });
        return null;
      }

      if (matchesCandidate(state.entries[existingIndex] as Record<string, unknown>, filter)) {
        state.entries[existingIndex] = {
          ...state.entries[existingIndex],
          ...update.$set
        };
      }

      return null;
    })
  }));

  return {
    LeaderboardEntryModel: {
      findOneAndUpdate,
      __state: state
    }
  };
});

describe("LeaderboardRepository.upsertEntry", () => {
  const repository = new LeaderboardRepository();
  const mockedModel = LeaderboardEntryModel as typeof LeaderboardEntryModel & {
    __state: { entries: Array<Record<string, unknown>> };
  };

  beforeEach(() => {
    mockedModel.__state.entries.length = 0;
    vi.clearAllMocks();
  });

  it("inserts a new entry", async () => {
    await repository.upsertEntry({
      testId: "test-1",
      userId: "user-1",
      firstName: "Alice",
      score: 8,
      correctCount: 8,
      totalQuestions: 10,
      timeTakenSeconds: 60
    });

    expect(mockedModel.__state.entries).toHaveLength(1);
    expect(mockedModel.__state.entries[0]).toMatchObject({
      testId: "test-1",
      userId: "user-1",
      firstName: "Alice",
      score: 8,
      timeTakenSeconds: 60
    });
  });

  it("replaces an existing entry with a better score", async () => {
    await repository.upsertEntry({
      testId: "test-1",
      userId: "user-1",
      firstName: "Alice",
      score: 7,
      correctCount: 7,
      totalQuestions: 10,
      timeTakenSeconds: 70
    });

    await repository.upsertEntry({
      testId: "test-1",
      userId: "user-1",
      firstName: "Alice",
      score: 9,
      correctCount: 9,
      totalQuestions: 10,
      timeTakenSeconds: 80
    });

    expect(mockedModel.__state.entries[0]).toMatchObject({ score: 9, timeTakenSeconds: 80 });
  });

  it("does not replace an existing entry with a worse score", async () => {
    await repository.upsertEntry({
      testId: "test-1",
      userId: "user-1",
      firstName: "Alice",
      score: 9,
      correctCount: 9,
      totalQuestions: 10,
      timeTakenSeconds: 60
    });

    await repository.upsertEntry({
      testId: "test-1",
      userId: "user-1",
      firstName: "Alice",
      score: 8,
      correctCount: 8,
      totalQuestions: 10,
      timeTakenSeconds: 30
    });

    expect(mockedModel.__state.entries[0]).toMatchObject({ score: 9, timeTakenSeconds: 60 });
  });

  it("replaces an existing entry on equal score with faster time", async () => {
    await repository.upsertEntry({
      testId: "test-1",
      userId: "user-1",
      firstName: "Alice",
      score: 9,
      correctCount: 9,
      totalQuestions: 10,
      timeTakenSeconds: 75
    });

    await repository.upsertEntry({
      testId: "test-1",
      userId: "user-1",
      firstName: "Alice",
      score: 9,
      correctCount: 9,
      totalQuestions: 10,
      timeTakenSeconds: 50
    });

    expect(mockedModel.__state.entries[0]).toMatchObject({ score: 9, timeTakenSeconds: 50 });
  });

  it("does not replace an existing entry on equal score with slower time", async () => {
    await repository.upsertEntry({
      testId: "test-1",
      userId: "user-1",
      firstName: "Alice",
      score: 9,
      correctCount: 9,
      totalQuestions: 10,
      timeTakenSeconds: 45
    });

    await repository.upsertEntry({
      testId: "test-1",
      userId: "user-1",
      firstName: "Alice",
      score: 9,
      correctCount: 9,
      totalQuestions: 10,
      timeTakenSeconds: 55
    });

    expect(mockedModel.__state.entries[0]).toMatchObject({ score: 9, timeTakenSeconds: 45 });
  });
});
