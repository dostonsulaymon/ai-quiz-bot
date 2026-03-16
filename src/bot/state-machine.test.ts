/// <reference types="vitest" />

import { describe, expect, it } from "vitest";
import { assertValidTransition, VALID_TRANSITIONS } from "./state-machine.js";
import type { BotSessionState } from "./types.js";

describe("assertValidTransition", () => {
  it("allows valid transitions", () => {
    expect(() => assertValidTransition("idle", "uploading", "unit-test")).not.toThrow();
    expect(() => assertValidTransition("reviewing", "testing", "unit-test")).not.toThrow();
  });

  it("throws descriptive errors for invalid transitions", () => {
    expect(() => assertValidTransition("uploading", "editing", "unit-test")).toThrow(
      "Invalid transition uploading → editing"
    );
  });

  it("defines transitions for every state", () => {
    const states: BotSessionState[] = ["idle", "uploading", "configuring", "reviewing", "testing", "editing", "done"];

    expect(Object.keys(VALID_TRANSITIONS).sort()).toEqual(states.slice().sort());
    for (const state of states) {
      expect(Array.isArray(VALID_TRANSITIONS[state])).toBe(true);
    }
  });
});
