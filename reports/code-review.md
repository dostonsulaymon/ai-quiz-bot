# Code Review — Quiz Bot
_Reviewed: 2026-03-16_

Findings are grouped by category and ordered by severity within each group.
File locations use `path:line` notation.

---

## 1. Security

### S1 — CRITICAL: No ownership check on test delete
**File:** `src/bot/handlers/mytests.handler.ts:215`

`softDelete(testId)` is called with an ID taken directly from callback data, with
no check that `ctx.user._id === test.creatorId`. Any user who intercepts or guesses
a test ObjectId can delete someone else's test by forging a `mytests:delete:confirm:`
callback. Fix: load the test first and compare `creatorId` before deleting.

---

### S2 — HIGH: No ownership check on history session details
**File:** `src/bot/handlers/history.handler.ts:132–139`

The `history:details:<sessionId>:<page>` callback fetches the session by ID without
checking that `session.userId === ctx.user._id`. Any user who knows another user's
session ObjectId can read their full answer breakdown. Fix: add an ownership check in
`renderHistoryDetails`.

---

### S3 — HIGH: No ownership check on share-code generation via `/mytests`
**File:** `src/bot/handlers/mytests.handler.ts:116, 191–197`

`renderShareView` calls `testRepository.ensureShareCode(testId)` with the ID from
callback data. A user can force share-code generation on tests they don't own. The
share code itself is random, so they cannot use it, but they cause a DB write on
another user's document. Fix: verify ownership before calling `ensureShareCode`.

---

### S4 — MEDIUM: Gemini API key exposed in request URL
**File:** `src/ai/providers/gemini.provider.ts:34`

```ts
url.searchParams.set("key", config.GEMINI_API_KEY!);
```

The API key is placed in the URL query string. It will appear in access logs, reverse
proxy logs, and browser history if the bot is ever debugged via a proxy. The Gemini
API accepts the key in the `x-goog-api-key` header instead, which keeps it out of
URLs entirely.

---

### S5 — LOW: Base64 file content stored in Redis session
**File:** `src/bot/handlers/upload.handler.ts` (upload flow), `src/bot/types.ts:31`

`UploadedFile.base64` stores the full base64-encoded file in `BotSession`, which is
serialised to Redis. A 4 MB JPEG becomes ~5.3 MB in base64; 10 images = ~53 MB in
a single Redis key. Beyond the memory risk, the raw file data (PDF text, image bytes)
is held at rest in Redis with no TTL, which is a broader data-retention concern.

---

## 2. Code Quality

### Q1 — Dead export clutters the upload handler
**File:** `src/bot/handlers/upload.handler.ts:127–150`

`uploadRouter` is defined and exported but never imported anywhere. Only
`uploadRouterFull` is used (by `router.ts`). The dead export adds confusion about
which function callers should use.

---

### Q2 — Dynamic import in the middleware hot path
**File:** `src/bot/router.ts:33`

```ts
const { enterTestFlow } = await import("./handlers/test.handler.js");
```

This dynamic import runs on every update where a review is just confirmed. Node.js
module cache means it doesn't re-parse the file, but it still invokes the module
resolution machinery on every call and is confusing to read. Move it to a static
import at the top of the file.

---

### Q3 — `formatQuestionTypes` copy-pasted in two files
**Files:** `src/bot/handlers/commands.ts:48–62`, `src/bot/handlers/mytests.handler.ts:32–46`

Identical function bodies. If the type labels ever change, only one copy will be
updated. Move to a shared utility (e.g. `src/bot/utils/format.ts`).

---

### Q4 — `formatDate` duplicated with divergent options
**Files:** `src/bot/handlers/history.handler.ts:14–21`, `src/bot/handlers/mytests.handler.ts:24–30`

Both format a `Date` with `Intl.DateTimeFormat`, but history includes `year` and
mytests doesn't. The inconsistency will confuse users comparing timestamps across
views. Consolidate into one helper with a `showYear` option.

---

### Q5 — Repository instances created per handler file (N instances)
**Files:** `commands.ts`, `mytests.handler.ts`, `history.handler.ts`, `upload.handler.ts`, `review.handler.ts`, `test.handler.ts`

Every handler file calls `new TestRepository()`, `new UserRepository()`, etc. at
module scope, resulting in 4–5 separate `TestRepository` instances. Repositories are
stateless so there's no correctness bug, but it wastes memory and makes dependency
injection impossible if needed later. Pass repositories as constructor arguments or
use a module-level singleton.

---

### Q6 — `userRepository.findOrCreate` called redundantly inside handlers
**Files:** `src/bot/handlers/test.handler.ts:130, 163`, `src/bot/handlers/review.handler.ts:203`

`ctx.user` is already populated by `userMiddleware` before any handler runs. Despite
this, `test.handler.ts` and `review.handler.ts` call `userRepository.findOrCreate`
again to get the user object for session creation and test saving. This doubles the
DB round-trips. Replace with `ctx.user` (add a guard for the rare `ctx.user == null`
case).

---

### Q7 — `resetSession` does not clear new sub-state fields
**File:** `src/bot/types.ts:55–58`

```ts
export const resetSession = (session: BotSession): BotSession => {
  Object.assign(session, createInitialSession()); // only sets state: "idle"
  return session;
};
```

`createInitialSession` returns `{ state: "idle" }`. All new fields added for the
state machine (`uploadStep`, `reviewMessageId`, `testSubState`, `testCorrectCount`,
etc.) are left untouched after a cancel. The `enter*Flow` functions re-initialise
them on the next flow, so it's not immediately broken, but a partially initialised
session is a latent bug. `createInitialSession` should explicitly zero all sub-state
fields.

---

### Q8 — Non-null assertion on `activeTestId` in `router.ts`
**File:** `src/bot/router.ts:34`

```ts
await enterTestFlow(ctx, ctx.session.activeTestId!);
```

This runs when `state === "testing"` but `testQuestionMessageId` is undefined and
`sessionId` is undefined. If `activeTestId` is somehow also undefined (e.g., session
corrupted), this crashes with an unhandled exception. Add an explicit guard.

---

### Q9 — `testSessionRepository.complete` return value never checked
**File:** `src/bot/handlers/test.handler.ts:172–176`

`complete()` returns `TestSessionDocument | null`. If the session document is not
found (already deleted, or wrong ID), the method returns null silently. The caller
doesn't check the return value, so the score card is shown to the user even though
nothing was written to the DB.

---

### Q10 — `/cancel` leaves TestSession in `status: "in_progress"` forever
**File:** `src/bot/handlers/commands.ts:135–143`

When the user cancels during a test, `releaseActiveTestSessionSlot` is called and the
session is reset, but the MongoDB `TestSession` document is never updated from
`"in_progress"` to `"abandoned"`. These orphaned records accumulate indefinitely and
skew `countByTestId` stats (the "taken N times" counter includes unfinished sessions).

---

### Q11 — Duplicate answer records possible on network retry
**File:** `src/bot/handlers/test.handler.ts` (`handleChoiceAnswer`, `handleSelfGrading`)

`testSessionRepository.updateAnswer` uses `$push` with no deduplication. If Telegram
delivers the same `callback_query` twice (network timeout + retry), the answer is
pushed twice. `testCorrectCount` (session field) tracks only one increment, so the
session score and the DB answers array diverge. Fix: use `$addToSet` on `questionId`
or upsert by question ID.

---

## 3. Missing Error Handling

### E1 — No HTTP timeout on Telegram file downloads
**File:** `src/bot/handlers/upload.handler.ts:80–95`

The `fetch` call to `api.telegram.org/file/bot…` has no `signal: AbortSignal.timeout(…)`.
A slow or hung Telegram CDN response will stall the entire middleware chain for that
user indefinitely (until the Node.js process is restarted). Add a 30-second timeout.

---

### E2 — No HTTP timeout on AI provider calls
**Files:** `src/ai/providers/claude.provider.ts:28`, `src/ai/providers/gemini.provider.ts:36`

Same problem. Neither `fetch` call specifies a timeout. A hung Claude or Gemini
connection blocks the bot worker for that user without bound. Add
`signal: AbortSignal.timeout(120_000)` (2 minutes is generous for AI).

---

### E3 — `ctx.user` is not checked before use in the `history:details` callback
**File:** `src/bot/handlers/history.handler.ts:132–139`

Unlike the other callbacks in this file, the `history:details:` handler has no `if (!ctx.user)` guard. If `userMiddleware` fails (DB down, `ctx.from` undefined), it
proceeds to call `renderHistoryDetails` with no user context. The function doesn't
need `ctx.user`, but the asymmetry is a maintenance hazard — a future change that
adds an ownership check will silently crash.

---

### E4 — `releaseActiveTestSessionSlot` throw breaks the completion card
**File:** `src/bot/handlers/test.handler.ts:178–183`

`releaseActiveTestSessionSlot` can throw (Redis error). If it does, the error bubbles
up through `errorMiddleware` and the user gets a generic error instead of their score
card, even though the test was completed successfully in MongoDB. Wrap the slot
release in a try/catch and log the error without re-throwing.

---

### E5 — `findByIdWithTest` populate failure is silent
**File:** `src/bot/handlers/history.handler.ts:65`

If the test document referenced by `session.testId` has been soft-deleted,
`populate("testId")` sets the field to `null`. `renderHistoryDetails` casts it
without checking:

```ts
const test = session.testId as { title?: string; questions?: Question[] } | null;
const questions = test?.questions ?? [];
```

The breakdown renders as all "No answer" entries with an empty question list. The
user sees a broken history detail page with no explanation.

---

## 4. UX Issues

### U1 — Bot is completely unresponsive during AI generation (up to 30s)
**File:** `src/bot/handlers/upload.handler.ts:runGeneration`

AI generation runs synchronously in the middleware chain. grammy processes updates
sequentially per-user, so the user cannot send any message or press any button during
generation. If the API takes 20–30 seconds, the bot appears frozen with only the
"Generating..." message visible. At minimum, send a follow-up "Still working..." after
10 seconds. Better: send the generation to a background task and poll.

---

### U2 — File download is also synchronous and unresponsive
**File:** `src/bot/handlers/upload.handler.ts:handlePdfUpload`, `handleFirstImage`

Same issue: downloading and base64-encoding large files (up to 20 MB) blocks the
middleware chain. The "Processing your file... ⏳" message is sent before the
download, so the user sees feedback, but any button press during download is queued
and processed after the download completes — which can be confusing.

---

### U3 — After a test is complete, `/cancel` leaves the user in `state: "done"`
**File:** `src/bot/types.ts`, `src/bot/handlers/test.handler.ts:completeTest`

`completeTest` sets `testSubState = "completed"` but leaves `state = "testing"`.
After the user taps "Main menu" (`MAIN_MENU_CALLBACK`), `resetSession` sets
`state = "idle"` correctly. But if the user types `/cancel` instead, the cancel
command checks `state === "testing"`, releases the slot (already released), and resets
— which is fine, but `releaseActiveTestSessionSlot` is called on an already-released
slot (idempotent due to `slotId` check, so not a crash, but noisy).

---

### U4 — No feedback when tapping ◀/▶ pagination with only one page
**Files:** `src/bot/handlers/mytests.handler.ts:50–52`, `src/bot/handlers/history.handler.ts:23–27`

When there is only one page, ◀ and ▶ both navigate to page 1 (clamped by `Math.min`/
`Math.max`). Tapping ▶ when already on the last page re-renders the same page silently.
Users may think the button is broken. Show a toast via `answerCallbackQuery({ text: "Already on the last page." })`.

---

### U5 — Test question re-sent on every update if session creation fails mid-flow
**File:** `src/bot/handlers/test.handler.ts:120–123`

In `handleAnswering`, if `sessionId` is null:
```ts
await sendCurrentQuestion(ctx);
return;
```

`sendCurrentQuestion` calls `ensureSession` which sets `ctx.session.sessionId`. But
if `ensureSession` throws (Redis down, DB down), the next update again has no
`sessionId`, calls `sendCurrentQuestion` again, and the user sees duplicate question
messages accumulating.

---

### U6 — Review flow "Regenerate all" after deletion shows blank card on failure
**File:** `src/bot/handlers/review.handler.ts:158–175`

If `REVIEW_REGENERATE_ALL_CALLBACK` fails, the handler edits the message to the
"No questions remain" text, then sends a second reply "I couldn't regenerate…". The
user is left with two conflicting messages — the edited card says "regenerate all"
and the reply says "please try again". The reply is redundant since the card already
has the "Regenerate all" button.

---

### U7 — Uploading a PDF after already adding images gives a confusing rejection
**File:** `src/bot/handlers/upload.handler.ts:handleAdditionalImage`

Once image collection starts (`uploadedFiles.length > 0`), the handler is
`handleAdditionalImage`. If the user sends a PDF at this point, `extractImageFileInfo`
returns null and the bot says "Please send a photo or image file, or tap Done…".
There is no way to switch to PDF mode. This is a correct design choice, but the
message should explicitly say "You're in image mode. To use a PDF, use /cancel and
start over with /newtest."

---

## 5. Performance

### P1 — N+1 query: `countByTestId` called per test in `/mytests`
**File:** `src/bot/handlers/mytests.handler.ts:66`

```ts
const takeCounts = await Promise.all(tests.map((test) => testSessionRepository.countByTestId(test._id)));
```

This fires up to 5 separate `countDocuments` queries per page render. Replace with a
single aggregation:
```ts
db.testSessions.aggregate([
  { $match: { testId: { $in: testIds } } },
  { $group: { _id: "$testId", count: { $sum: 1 } } }
])
```

---

### P2 — Missing compound index on `TestSession {userId, status}`
**File:** `src/db/models/test-session.model.ts:34–36`

`findByUserPaginated` and `countByUser` query `{ userId, status: "completed" }`.
Only a single-field index on `userId` exists. MongoDB uses it to find all sessions
for the user, then filters by status in memory. As session volume grows this
degrades. Add: `testSessionSchema.index({ userId: 1, status: 1 })`.

---

### P3 — Test document fetched from DB on every answer
**File:** `src/bot/handlers/test.handler.ts:handleAnswering:99–103`, `sendCurrentQuestion:80–82`

`testRepository.findById(activeTestId)` is called once per answer to retrieve the
questions array and find the current question. For a 20-question test that is 20
round-trips to MongoDB. Cache the questions array in the session (the questions are
immutable once the test is saved) or at least cache `test.questions` in a Redis key
for the duration of the test.

---

### P4 — `userMiddleware` runs a DB upsert on every single update
**File:** `src/bot/middlewares/userMiddleware.ts:13`

`findOrCreate` executes `findOneAndUpdate` with `upsert: true` on every message and
callback. User profile data changes infrequently. Add a short in-memory or Redis
cache (e.g. 60-second TTL per `telegramId`) to skip the DB round-trip for repeat
updates from the same user.

---

### P5 — Base64 file content in Redis session causes large key sizes
**File:** `src/bot/types.ts:31`, `src/bot/storage/redis-session.storage.ts`

As noted in S5, `UploadedFile.base64` fields are serialised into the Redis session
key. A 10-image upload at 3 MB each = ~40 MB per session key. This will cause Redis
`SET` and `GET` latency spikes and memory pressure. Store the base64 data in a
separate Redis key with a short TTL (e.g. `upload:files:<userId>`) and keep only the
`fileId` reference in the session.

---

### P6 — No TTL on Redis sessions
**File:** `src/bot/index.ts:34`

```ts
storage: new RedisSessionStorage<BotSession>(redis, undefined, ...)
```

The `ttlSeconds` argument is `undefined`, so sessions never expire. For a
multi-user deployment, Redis memory grows without bound. Set a reasonable TTL
(e.g. 7 days = 604800 seconds). The `onCorrupt` fallback already handles stale
sessions gracefully.

---

### P7 — `findByCreator` (non-paginated) loads all tests into memory
**File:** `src/db/repositories/test.repository.ts:82–84`

`findByCreator` does `TestModel.find({ creatorId, isActive: true })` with no limit.
A prolific user with hundreds of tests would load all of them. This method is not
called anywhere in the current codebase (only the paginated variant is used), so it
is a footgun waiting for the next developer who uses it. Add a `.limit()` or remove
it.

---

## Summary Table

| ID | Severity | Category | One-line description |
|----|----------|----------|----------------------|
| S1 | Critical | Security | No ownership check on test delete |
| S2 | High | Security | No ownership check on history details |
| S3 | High | Security | No ownership check on share-code generation |
| S4 | Medium | Security | Gemini API key in URL query string |
| S5 | Low | Security | Base64 file content at-rest in Redis |
| Q1 | Low | Quality | Dead `uploadRouter` export |
| Q2 | Low | Quality | Dynamic import in hot path (`router.ts`) |
| Q3 | Medium | Quality | `formatQuestionTypes` copy-pasted |
| Q4 | Low | Quality | `formatDate` duplicated with divergent options |
| Q5 | Low | Quality | Multiple repository instances per handler file |
| Q6 | Medium | Quality | `userRepository.findOrCreate` called when `ctx.user` is available |
| Q7 | Medium | Quality | `resetSession` leaves sub-state fields populated |
| Q8 | High | Quality | Non-null assertion on `activeTestId` in `router.ts` |
| Q9 | Medium | Quality | `complete()` return value not checked |
| Q10 | Medium | Quality | Cancelled test sessions never marked `abandoned` |
| Q11 | Medium | Quality | Duplicate answers possible on network retry |
| E1 | High | Errors | No timeout on Telegram file download |
| E2 | High | Errors | No timeout on AI provider fetch calls |
| E3 | Low | Errors | `ctx.user` not checked in `history:details` callback |
| E4 | Medium | Errors | Slot release throw breaks score card delivery |
| E5 | Low | Errors | Deleted test reference renders as blank history detail |
| U1 | High | UX | Bot unresponsive for up to 30s during AI generation |
| U2 | Medium | UX | File download blocks middleware chain |
| U3 | Low | UX | `/cancel` after score card releases already-released slot |
| U4 | Low | UX | Pagination ◀/▶ silently re-renders same page at boundaries |
| U5 | Medium | UX | Duplicate question messages if session creation fails |
| U6 | Low | UX | Redundant reply after "Regenerate all" failure |
| U7 | Low | UX | No guidance when user tries to switch PDF→images mid-upload |
| P1 | High | Perf | N+1 `countByTestId` queries in `/mytests` |
| P2 | Medium | Perf | Missing compound index `{ userId, status }` on TestSession |
| P3 | High | Perf | Test document fetched from DB on every answer |
| P4 | Medium | Perf | `userMiddleware` runs DB upsert on every update |
| P5 | High | Perf | Base64 file content in Redis session (~50 MB/user) |
| P6 | Medium | Perf | No TTL on Redis sessions |
| P7 | Low | Perf | `findByCreator` loads unlimited documents with no cap |
