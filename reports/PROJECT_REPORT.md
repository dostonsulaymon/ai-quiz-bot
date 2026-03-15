# Quiz Bot — Project Report

## What It Does

Quiz Bot is a Telegram bot that lets users upload study material (PDF or images), configure question parameters, and receive an AI-generated quiz. Users can review and edit questions before taking the test, share tests with others via a link or code, and view their test history. Three AI backends are supported: Anthropic Claude, Google Gemini, and a local Ollama instance.

## Architecture Overview

```
src/
├── index.ts               — Bootstrap: connects Redis + MongoDB, starts bot
├── config/                — Validated env config loaded at startup
├── redis/                 — ioredis client factory
├── db/
│   ├── connection.ts      — Mongoose connect with retry
│   ├── models/            — Mongoose schemas: User, Test, TestSession
│   └── repositories/      — Data-access layer (findOrCreate, paginated queries, etc.)
├── ai/
│   ├── ai.factory.ts      — Singleton provider factory
│   ├── ai.interface.ts    — IAIProvider contract
│   └── providers/         — Claude, Gemini, Ollama implementations + base utilities
├── shared/
│   ├── errors/            — AppError hierarchy (AIError, ValidationError, …)
│   ├── logger.ts          — Structured JSON logger
│   └── types/             — Domain types (Question, QuestionAnswer, …)
└── bot/
    ├── index.ts           — Bot wiring: middleware order, conversation registration
    ├── types.ts           — BotContext, BotSession, resetSession
    ├── storage/           — RedisSessionStorage (grammY StorageAdapter)
    ├── middlewares/       — errorMiddleware, rateLimitMiddleware, userMiddleware
    ├── handlers/          — commands.ts, history.handler.ts, mytests.handler.ts
    └── scenes/            — upload.scene.ts, review.scene.ts, test.scene.ts
```

**Data flow:** Telegram update → grammY middleware chain (Redis attach → session → user → conversations → command/callback handlers) → AI provider → MongoDB.

**Session state machine:** `idle → uploading → configuring → reviewing → testing → idle`. State is persisted in Redis-backed grammY session; conversations use `conversation.external()` for all side-effects and session mutations.

## Current State

| Area | Status |
|------|--------|
| Upload flow (PDF + images) | Working — fully wired with rate-limit checks |
| Question configuration (count + type) | Working |
| AI generation (Claude / Gemini / Ollama) | Working — one malformed-JSON auto-retry |
| Review/edit scene | Working — prev/next/edit/delete/regenerate all present |
| Test-taking scene (MCQ, T/F, short/fill) | Working — self-grading for text questions |
| Share codes | Working — nanoid, collision-retry, sparse unique index |
| /history command | Working after status-filter fix |
| /mytests command | Working |
| /join command | Working |
| Rate limiting (Redis) | Working — hourly + daily AI limits, concurrent session cap |
| Session recovery on corrupt Redis data | Working |
| MongoDB indexes | Previously missing on creatorId, userId, testId — now fixed |

## Bugs Fixed

| File | Issue | Bug | Fix Applied |
|------|-------|-----|-------------|
| `bot/index.ts` | Line 75 (original) | `userMiddleware` was registered **after** the conversations middleware. Conversations intercept updates before downstream middleware runs, so `ctx.user` was always `undefined` inside all three conversation bodies. The `askForQuestionTypes` fallback to `DEFAULT_QUESTION_TYPES` masked the symptom. | Moved `bot.use(userMiddleware)` to run **before** `conversations()`. |
| `bot/scenes/upload.scene.ts` | `handleCancel` | `resetSession(ctx.session)` called directly on `ctx.session` inside a conversation body (outside `conversation.external()`). During grammY replay this mutation is re-applied each replay, corrupting the session with a premature reset. | Wrapped `resetSession` in `conversation.external((liveCtx) => { resetSession(liveCtx.session); })`. |
| `bot/scenes/review.scene.ts` | `waitForReviewUpdate` | Same grammY conversations violation: `resetSession(ctx.session)` called directly on the replayed context. | Same fix — wrapped in `conversation.external()`. |
| `bot/scenes/test.scene.ts` | `waitForUpdate` | Same grammY conversations violation: `resetSession(ctx.session)` called directly on the replayed context. | Same fix — wrapped in `conversation.external()`. |
| `bot/handlers/commands.ts` | `/newtest` handler | After calling `resetSession()` (which sets `state = "idle"`), the handler then checked `if (ctx.session.state === "reviewing")` and attempted to enter the review conversation. This condition was always false — dead code. Additionally, named conversation exits happened before the blanket `exit()`. | Removed the dead branch. Moved `ctx.conversation.exit()` before `resetSession()` to ensure grammY history is cleared before session is wiped. |
| `bot/handlers/commands.ts` | `/cancel` handler | Blanket `ctx.conversation.exit()` was called, then `resetSession()`, then individual named exits were called again (redundant and wrong order). | Replaced with a single `ctx.conversation.exit()` (exits all) before `resetSession()`. Removed the redundant named exits. |
| `bot/handlers/commands.ts` | `startPreviewedTest` | Used individual named `exit()` calls and did not clear `sessionId` or `currentQuestionIndex`, leaving stale values from a previous test run. | Replaced with single `ctx.conversation.exit()`, and explicitly reset `sessionId = undefined` and `currentQuestionIndex = 0`. |
| `bot/handlers/mytests.handler.ts` | `startOwnedTest` | Same stale-session-field bug as `startPreviewedTest`. | Same fix. |
| `bot/scenes/review.scene.ts` | `REVIEW_REGENERATE_ALL_CALLBACK` | `regenerated[0]!` with non-null assertion on line 502. If the AI returned an empty array, accessing index 0 would throw a runtime error with no user-facing message. | Added an explicit empty-array guard that throws a caught error, which routes to the existing `catch` block that shows the user a friendly retry message. |
| `db/models/test.model.ts` | `testSchema` | `creatorId` field had no index. `findByCreator` and `countByCreator` queries do a full collection scan at scale. | Added `index: true` to `creatorId`. |
| `db/models/test-session.model.ts` | `testSessionSchema` | `userId` and `testId` fields had no indexes. `findByUser`, `countByUser`, and `countByTestId` all do full collection scans at scale. | Added `index: true` to both fields. |
| `db/repositories/test-session.repository.ts` | `findByUser`, `findByUserPaginated`, `countByUser` | All three methods returned or counted ALL sessions regardless of status, so in-progress (incomplete) sessions appeared in history and inflated the count, causing pagination mismatch. | Added `status: "completed"` filter to all three methods. |
| `db/repositories/user.repository.ts` | `findOrCreate` | TypeScript return type was `Promise<UserDocument>` but `findOneAndUpdate` returns `UserDocument | null`. The mismatch suppressed a type error and would crash callers that rely on the non-null guarantee if Mongoose ever returns null. | Added an explicit null-guard that throws a descriptive error; non-null assertion removed from the return. |

## Remaining Issues

### Needs design decision

1. **No `uploadScene` state-resume across restarts.** The auto-restore middleware only re-enters the review and test conversations on bot restart. If the bot restarts while a user is in the middle of uploading or configuring, they see no message and must send `/newtest` manually. Fixing this would require persisting the upload wizard state and adding a resume path.

2. **Claude image media_type is hard-coded to `image/png`.** In `claude.provider.ts` all base64 images are sent as `image/png` regardless of actual format. A JPEG sent by a user will be misidentified; the Claude API may reject it or return degraded results. The fix requires preserving the detected MIME type through `UploadedFile` and threading it to the provider.

3. **No conversation timeout.** A user who starts a flow and then goes silent will hold an open conversation indefinitely, accumulating grammY replay history. A TTL-based auto-cancel (e.g., 30 minutes of inactivity) is recommended.

4. **`acquireActiveTestSessionSlot` session write outside `external()`** (partial concern). The function writes `ctx.session.activeTestSlotId` on the `ctx` it receives. When called from `conversation.external((ctx) => acquireActiveTestSessionSlot(ctx))` this is the live external context, so it IS correct. However, the function signature accepts any `BotContext`, making it easy to accidentally call it with a replayed context in future code. Refactoring the slot-id write into the `external()` call site would make the invariant explicit.

5. **Replay history growth.** Every question answer appended during a test adds an event to the grammY conversation log stored in Redis. For a 50-question test this is manageable, but very long tests will produce large replay logs that slow down subsequent message processing. `conversation.checkpoint()` (grammY v2) can be used to prune history mid-conversation.

6. **`testsessionSchema` has `timestamps: false`** but `startedAt` is set manually at create time. There is no `updatedAt` field, making it impossible to track when a session was last modified (e.g., for abandonment detection).

7. **No `/start` deep-link for `UPLOADING` or `CONFIGURING` states.** If a user shares a bot link while mid-upload, the deep-link resets their session without warning.

## Conversation Flow

```
User sends /newtest
        │
        ▼
  [uploadScene]
  ┌──────────────────────────────────────────────────────────────┐
  │  askForUpload → waitForUpdate loop                           │
  │    • receives PDF → collectPdfUpload (download + base64)     │
  │    • receives image(s) → collectImageUploads (loop, max 10)  │
  │  askForQuestionCount → button or custom number               │
  │  askForQuestionTypes → toggle buttons + confirm              │
  │  generateUntilSuccessOrCancel → AI call, retry on failure    │
  │  → writes draftQuestions + state="reviewing" to session      │
  └──────────────────────────────────────────────────────────────┘
        │ (uploadScene exits, auto-restore middleware enters reviewScene)
        ▼
  [reviewScene]
  ┌──────────────────────────────────────────────────────────────┐
  │  Shows question card with Prev / Next / Edit / Regen / Delete│
  │  Edit → prompts for new answer text                          │
  │  Regenerate → AI call for single replacement                 │
  │  Regenerate all → AI call for full set                       │
  │  Start Test → saves Test to MongoDB, writes activeTestId     │
  │             → state="testing"                                │
  └──────────────────────────────────────────────────────────────┘
        │ (reviewScene exits, auto-restore middleware enters testScene)
        ▼
  [testScene]
  ┌──────────────────────────────────────────────────────────────┐
  │  outer while(true) — supports retake                         │
  │  createOrReuseSession → creates TestSession in MongoDB       │
  │  For each question:                                          │
  │    MCQ / T/F → inline keyboard, immediate feedback           │
  │    Short / Fill → text input + self-grade keyboard           │
  │    each answer → testSessionRepository.updateAnswer()        │
  │  completeSession → score, mark completed, increment user stat│
  │  showCompletionCard → Share / Retake / Main menu             │
  │    Share → generates shareCode if absent, shows deep-link    │
  │    Retake → resets sessionId, loops back                     │
  │    Main menu → resetSession, exits conversation              │
  └──────────────────────────────────────────────────────────────┘
        │
        ▼
  [IDLE] — user can /newtest, /join, /mytests, /history
```

`/cancel` at any point exits all conversations and resets session to idle.
`/join CODE` previews a shared test and enters testScene directly.
`/mytests` lists created tests with Take / Share / Delete actions.
`/history` shows completed test sessions with per-question breakdown.

## Risk Areas

1. **Replay storm on bot restart during long test.** If the bot restarts mid-test after 40 questions have been answered, grammY must replay all 40 answer checkpoints before the conversation body catches up with the current update. This is O(n) in question count and will be slow.

2. **Redis session as sole conversation store.** The grammY conversation log is stored alongside the session in Redis with no TTL. A user abandoning a conversation partway through leaves an ever-growing session key.

3. **AI provider is a module-level singleton.** `getAIProvider()` caches the instance in a module variable. If config ever changes at runtime (e.g., hot-reload), the old instance is reused. This is low-risk for the current architecture but worth noting.

4. **Share code uniqueness collision at scale.** The 6-character alphanumeric space (36^6 ≈ 2.2 billion) is large, but the retry loop maxes out at 5 attempts. Under heavy concurrent use the `findOneAndUpdate` race condition could exhaust retries. The sparse unique index makes this safe at DB level (it will throw), but the error surface to the user is an internal 500.

5. **No auth on test operations.** Any user can delete any test by guessing the MongoDB ObjectId in the callback payload (`mytests:delete:confirm:<objectid>:<page>`). The delete handler checks `ctx.user` is populated but does not verify the user owns the test.

6. **`pdf-parse` has a known vulnerability warning** — it shells out to a system binary in some configurations. Should be audited before production deployment.

## Recommendations

Priority order:

1. **[Critical]** Add ownership check in the delete-confirm callback handler in `mytests.handler.ts` — verify `test.creatorId.equals(ctx.user._id)` before calling `softDelete`.

2. **[High]** Add a conversation inactivity timeout (30-minute TTL). Without it, abandoned conversations accumulate replay history indefinitely and prevent clean state transitions for the user.

3. **[High]** Fix the Claude image MIME type — preserve the actual content-type (`image/jpeg` vs `image/png`) through `UploadedFile` and pass it to the provider's content block builder.

4. **[Medium]** Add `conversation.checkpoint()` calls after each question is answered in `testScene` to prune replay history and speed up recovery after bot restarts.

5. **[Medium]** Add `timestamps: true` to `testSessionSchema` (or at minimum an `updatedAt` field) to enable abandoned-session cleanup jobs.

6. **[Medium]** Add resume support for the `uploading` and `configuring` states to the auto-restore middleware so users don't silently lose progress after a bot restart.

7. **[Low]** Replace module-level repository `new` instantiations in scene files (e.g., `const testRepository = new TestRepository()`) with a shared service/container to make testing easier and avoid hidden coupling.

8. **[Low]** Add an integration test harness using grammY's `InMemorySessionStorage` and a mocked AI provider to cover the conversation state machine end-to-end.
