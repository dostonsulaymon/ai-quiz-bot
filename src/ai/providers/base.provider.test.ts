/// <reference types="vitest" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseQuestionsResponse } from "./base.provider.js";

describe("parseQuestionsResponse", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0.1234);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps unique IDs unchanged", () => {
    const result = parseQuestionsResponse(JSON.stringify([
      { id: "q1", type: "short", question: "One?", correctAnswer: "A" },
      { id: "q2", type: "truefalse", question: "Two?", correctAnswer: "True" }
    ]));

    expect(result.map((question) => question.id)).toEqual(["q1", "q2"]);
  });

  it("deduplicates duplicate IDs", () => {
    const result = parseQuestionsResponse(JSON.stringify([
      { id: "dup", type: "short", question: "One?", correctAnswer: "A" },
      { id: "dup", type: "short", question: "Two?", correctAnswer: "B" }
    ]));

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("dup");
    expect(result[1]?.id).toMatch(/^dup_/);
    expect(new Set(result.map((question) => question.id)).size).toBe(2);
  });

  it("assigns fallback IDs for empty or null IDs", () => {
    const result = parseQuestionsResponse(JSON.stringify([
      { id: "", type: "short", question: "One?", correctAnswer: "A" },
      { id: null, type: "short", question: "Two?", correctAnswer: "B" }
    ]));

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("q_0_1700000000000");
    expect(result[1]?.id).toBe("q_1_1700000000000");
  });

  it("returns an empty array for zero questions", () => {
    expect(parseQuestionsResponse("[]")).toEqual([]);
  });
});
