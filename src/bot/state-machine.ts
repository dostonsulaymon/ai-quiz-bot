/**
 * Session State Machine
 * =====================
 * Single source of truth for all valid state transitions in the quiz-bot session.
 *
 * State diagram:
 *
 *   ┌──────────────────────────────────────────────────────────────────────────────┐
 *   │                                                                              │
 *   │  [idle] ──upload cmd──► [uploading] ──file received──► [configuring]        │
 *   │    │                                                        │                │
 *   │    │◄──────────────────────── /cancel ───────────────────┘ │                │
 *   │    │                                                        ▼                │
 *   │    │                                                   [reviewing] ──┐       │
 *   │    │                                                        │   self │       │
 *   │    │                          ┌─── save ───────────────────┘◄───────┘       │
 *   │    │                          │    (start or join)                           │
 *   │    ├──────────────────────────┤                                              │
 *   │    │     (start own test /    │                                              │
 *   │    │      join, retake)       ▼                                              │
 *   │    │                      [testing] ──────────── retake ──► [testing]       │
 *   │    │                          │                                              │
 *   │    │◄──────────── complete ───┘                                              │
 *   │    │                                                                         │
 *   │    ├──────────────────────────────────────── edit cmd ──► [editing]         │
 *   │    │                                                           │             │
 *   │    │◄──────────────────────────── save / cancel ──────────────┘             │
 *   │                                                                              │
 *   └──────────────────────────────────────────────────────────────────────────────┘
 *
 * Note: "done" is defined in BotSessionState for legacy reasons but is never assigned.
 */

import type { BotSession, BotSessionState } from "./types.js";
import { logger } from "../shared/logger.js";

/** All legal from→to pairs. Same-state is treated as a no-op (allowed everywhere). */
export const VALID_TRANSITIONS: Record<BotSessionState, BotSessionState[]> = {
  idle:        ["uploading", "testing", "editing"],
  uploading:   ["configuring", "idle"],
  configuring: ["reviewing", "testing", "idle"],
  reviewing:   ["reviewing", "testing", "idle"],
  testing:     ["testing", "idle"],
  editing:     ["idle"],
  done:        ["idle"],
};

/**
 * Throws in development / test environments if `from → to` is not in VALID_TRANSITIONS.
 * In production it logs a warning instead so a bad state never crashes a live session.
 */
export function assertValidTransition(
  from: BotSessionState,
  to: BotSessionState,
  context: string
): void {
  // Same-state is always a no-op, not an error.
  if (from === to) return;

  const allowed = VALID_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    const msg = `[state-machine] Invalid transition ${from} → ${to} (context: ${context})`;
    if (process.env.NODE_ENV !== "production") {
      throw new Error(msg);
    }
    logger.warn(msg, { event: "state.invalid_transition", from, to, context });
  }
}

/**
 * Transition `session.state` to `newState`.
 * Validates the transition and logs it. Use this instead of direct assignment.
 */
export function transitionTo(
  session: BotSession,
  newState: BotSessionState,
  context: string
): void {
  const from = session.state;
  assertValidTransition(from, newState, context);
  if (from !== newState) {
    logger.debug(`[state-machine] ${from} → ${newState} (${context})`, {
      event: "state.transition",
      from,
      to: newState,
      context,
    });
  }
  session.state = newState;
}

/**
 * Assert that the session is in the expected state.
 * Throws in dev; logs and returns `false` in production.
 */
export function assertSessionState(
  session: BotSession,
  expected: BotSessionState,
  context: string
): boolean {
  if (session.state === expected) return true;
  const msg = `[state-machine] Expected state "${expected}" but got "${session.state}" (context: ${context})`;
  if (process.env.NODE_ENV !== "production") {
    throw new Error(msg);
  }
  logger.warn(msg, { event: "state.unexpected", expected, actual: session.state, context });
  return false;
}
