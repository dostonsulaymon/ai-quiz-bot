/// <reference types="vitest" />

import { describe, expect, it } from "vitest";
import { normalizeWhitespace, truncateText } from "./format.js";

describe("truncateText", () => {
  it("returns short text unchanged", () => {
    expect(truncateText("Quiz", 10)).toBe("Quiz");
  });

  it("truncates long text and appends ellipsis", () => {
    expect(truncateText("This is a very long sentence", 10)).toBe("This is...");
  });

  it("handles an empty string", () => {
    expect(truncateText("", 10)).toBe("");
  });
});

describe("normalizeWhitespace", () => {
  it("collapses multiple newlines to at most two", () => {
    expect(normalizeWhitespace("Line 1\n\n\n\nLine 2")).toBe("Line 1\n\nLine 2");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeWhitespace("  Hello world  ")).toBe("Hello world");
  });

  it("normalizes Windows line endings", () => {
    expect(normalizeWhitespace("Line 1\r\n\r\n\r\nLine 2")).toBe("Line 1\n\nLine 2");
  });
});
