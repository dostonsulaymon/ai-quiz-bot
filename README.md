# ai-quiz

A Telegram bot that turns PDFs, images, and plain text into interactive quizzes using AI.

`ai-quiz` is a production-shaped Telegram quiz bot built with [grammY](https://grammy.dev) and TypeScript. Users send a PDF, a set of photos, or a block of text; the bot sends it to an AI provider (Anthropic Claude, Google Gemini, or a local Ollama model), gets back a structured set of questions, and runs the quiz interactively in Telegram — one question at a time, with optional per-question timers, shuffling, self-grading for open-ended answers, explanations, and a leaderboard. Tests can be shared by code or deep link, played solo in DMs or competitively in a group chat, organised into classes, exported to PDF, and edited after creation. MongoDB stores tests, sessions, users and leaderboards; Redis holds conversation state and rate-limit counters.

---

## Features

Everything listed here is implemented in `src/`.

### Quiz generation
- **Three input sources** — PDF documents, images (up to 10 per test, batched into one request), and pasted text.
- **Pluggable AI providers** — Claude, Gemini, and Ollama behind a single `IAIProvider` interface. Switch with one env var.
- **Automatic provider fallback** — `AI_PROVIDER_ORDER` defines a priority chain; if a provider fails with a retryable error the next one is tried, and the user is notified once when a switch happens.
- **Four question types** — multiple choice (`mcq`), true/false (`truefalse`), short answer (`short`), and fill-in-the-blank (`fill`). Selectable per test.
- **Language auto-detection** — the prompt instructs the model to detect the source content's language and generate questions, answers and explanations in that same language.
- **Gemini batching and JSON repair** — Gemini requests are split into batches (default 10 questions) with backoff, adaptive request sizing and inter-batch pacing; truncated JSON responses are repaired before parsing rather than discarded.
- **Response sanitisation** — malformed questions are dropped, missing/duplicate question IDs are regenerated, and whitespace is normalised (`src/ai/providers/base.provider.ts`).
- **Size-aware recommendations** — the bot suggests a question count based on the uploaded PDF's file size.

### Taking a quiz
- **Native Telegram polls** for MCQ and true/false questions, with inline-keyboard fallback.
- **Per-question timers** — none / 15s / 30s / 60s / 180s, with auto-advance when the timer expires.
- **Timer recovery on restart** — on boot the bot scans Redis sessions and active group sessions and auto-advances any question whose timer expired while the process was down (`src/index.ts`).
- **Shuffling** — Fisher-Yates shuffle of questions and/or of MCQ options.
- **Self-grading** — for `short` and `fill` questions the correct answer is revealed and the user marks their own response correct or wrong.
- **Answer review** — paginated review of all answers after finishing, with explanations.
- **Report a bad question** — a deep link that logs the offending question id.
- **Group quizzes** — run a test in a group chat with a 3-2-1 countdown, per-question polls, live scoring across participants, and a final ranking. One active session per chat is enforced by a partial unique index.

### Sharing and organising
- **6-character share codes** and `t.me/<bot>?start=TEST-XXXXXX` deep links for tests.
- **Classes** — group multiple tests under one class with its own share code and deep link.
- **My tests** — paginated browser with preview, start, share, edit, duplicate, delete, PDF export, and per-test analytics (participants, average score, total correct).
- **Post-creation editing** — change the title, shuffle settings, edit question text/options/answers, and add or remove questions.
- **PDF export** — renders a test to A4 PDF via headless Chromium, with an embedded Noto Naskh Arabic font and RTL support, optionally including the answer key.
- **Leaderboards** — per-test rankings by score, tie-broken by completion time. Entries only update when a user beats their own score or ties it faster.
- **History and stats** — paginated history of completed sessions with per-session detail, plus aggregate user stats.

### Platform
- **Bilingual UI** — full English and Uzbek translations, with per-language Telegram command menus registered via `setMyCommands`. Language is stored per user in MongoDB.
- **Redis-backed sessions** — grammY sessions persisted in Redis with a TTL; corrupted session payloads are detected, dropped, and the user is told to start over.
- **Rate limiting** — per-user hourly and daily generation caps plus a cap of 3 concurrent test sessions, all tracked in Redis.
- **Super admin bypass** — the Telegram user id in `SUPER_ADMIN_ID` skips all rate limits and concurrency checks.
- **Explicit state machine** — a single source of truth for valid session transitions that throws on an illegal transition in development and logs a warning in production.
- **Health and metrics HTTP endpoints** — `GET /health` and `GET /metrics` (update counts, error counts, AI generation success/failure and average latency, active user count).
- **Structured JSON logging** and optional **Sentry** error tracking.
- **Graceful shutdown** — SIGINT/SIGTERM stop the bot, close the HTTP server, and disconnect MongoDB and Redis.
- **Hourly cleanup job** — abandons stale group sessions and orphaned private test sessions.

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Language | TypeScript 5.8 (ES2022, `NodeNext` modules, `strict`) |
| Runtime | Node.js 20+ |
| Telegram framework | [grammY](https://grammy.dev) 1.36 |
| Database | MongoDB 7 via Mongoose 8 |
| Cache / session store | Redis 7 via ioredis 5 |
| AI providers | Anthropic Claude API, Google Gemini API, Ollama (local) |
| PDF input parsing | `pdf-parse` |
| PDF export | Puppeteer (headless Chromium); `pdfkit` + `arabic-reshaper` + `bidi-js` implementation also present |
| Error tracking | `@sentry/node` (optional) |
| Share codes | `nanoid` |
| Config | `dotenv` |
| Testing | Vitest 3 with `@vitest/coverage-v8` |
| Dev runner | `tsx` |
| Container | Docker multi-stage build on `node:20-alpine` |

---

## Architecture

### Request flow

```
Telegram update
      ↓
grammY Bot (src/bot/index.ts)
      ↓  attach Redis → session (Redis-backed) → default lang → userMiddleware → metrics → logging
      ↓
stateRouter (src/bot/router.ts)
      ↓  dispatch on ctx.session.state
      ├── uploading / configuring → upload.handler
      ├── reviewing              → review.handler
      ├── testing                → test.handler
      ├── editing                → edit.handler
      └── idle / done            → command handlers
```

### Bot layer

`createBot()` in `src/bot/index.ts` wires the middleware chain in a fixed order. Sessions are keyed by `<userId>:<chatId>` and stored in Redis through a custom `StorageAdapter` (`src/bot/storage/redis-session.storage.ts`). `userMiddleware` looks the user up in a 60-second Redis cache, falls back to `findOrCreate` in MongoDB, syncs the Telegram username/first name, and resolves the UI language into `ctx.lang()`.

Routing is state-driven rather than callback-driven. `stateRouter` reads `ctx.session.state` and hands the update to the handler that owns that state; commands (`/start`, `/newtest`, …) and one-off callbacks fall through to the handlers registered in `src/bot/handlers/`. The set of legal transitions lives in `src/bot/state-machine.ts` — `transitionTo()` validates every state change, throwing in non-production and logging a warning in production so a corrupted session cannot crash a live conversation.

`bot.catch` (`src/bot/middlewares/errorMiddleware.ts`) converts any thrown value into an `AppError`, records a metric, logs it, optionally reports it to Sentry, and replies to the user with a translated message plus a "try again" button when the error is retryable.

### AI provider abstraction

The contract is one method:

```ts
export interface IAIProvider {
  generateQuestions(input: GenerateQuestionsInput): Promise<Question[]>;
}
```

`src/ai/ai.factory.ts` reads `AI_PROVIDER_ORDER`, instantiates every provider whose credentials are present, and caches the ordered list. `generateWithFallback()` walks that list: on a retryable `AIError` it moves to the next provider (invoking an `onFallback` callback once so the user can be told), and on a non-retryable error it throws immediately.

Each provider builds its own request but shares prompt construction, response parsing, sanitisation and PDF-to-text extraction from `src/ai/providers/base.provider.ts`:

- **Claude** (`https://api.anthropic.com/v1/messages`) — sends text, native `document` blocks for PDFs, or `image` blocks with the real MIME type recorded at upload.
- **Gemini** (`generativelanguage.googleapis.com`) — uses a strict `responseSchema` with `responseMimeType: application/json`, batches large requests, backs off between attempts, and repairs truncated JSON arrays.
- **Ollama** (`{OLLAMA_BASE_URL}/api/generate`) — text-only; PDFs are extracted locally with `pdf-parse` first, images are rejected with a `ValidationError`.

All three honour `AI_TIMEOUT_MS` via `AbortController` and map HTTP 429 to a retryable `RATE_LIMIT` `AIError`.

### Storage

**MongoDB** (`src/db/`) holds six collections, each with a model and a thin repository:

| Model | Purpose |
| --- | --- |
| `User` | Telegram id, username, language, and per-user quiz defaults (count, types, timer, shuffle) |
| `Test` | Questions, source type, share code, shuffle flags, per-question time limit, owner |
| `TestSession` | A single user's run of a test: answers, score, status (`in_progress` / `completed` / `abandoned`) |
| `GroupSession` | An in-progress group quiz for one chat, with a partial unique index enforcing one active session per chat |
| `LeaderboardEntry` | One best result per (test, user), indexed for score-desc / time-asc ranking |
| `Class` | A named bundle of tests with its own share code |

`connectToDatabase()` retries the initial connection three times with a 2-second delay before giving up.

**Redis** (`src/redis/index.ts`) serves four jobs: grammY session storage (`quiz-bot:session:*`, TTL `SESSION_TTL_SECONDS`), a short-lived user cache (`quiz-bot:cache:user:*`, 60s), base64 upload staging (`upload:<userId>:<fileId>`, 1 hour) so large files never sit in the session object, and rate-limit counters.

### Rate limiting

`src/bot/middlewares/rateLimitMiddleware.ts` exposes three functions rather than a global middleware, so limits are applied only where they cost money or resources:

- `assertGenerationRateLimit()` — called before every AI generation. Increments `quiz-bot:ratelimit:daily-api:<userId>` (24h TTL) and `quiz-bot:ratelimit:generation:<userId>` (1h TTL); over the cap it decrements and throws a `RateLimitError` carrying the limit and the remaining window.
- `acquireActiveTestSessionSlot()` — adds a slot id to a Redis set (6h TTL) and refuses a 4th concurrent test session.
- `releaseActiveTestSessionSlot()` — frees the slot when a test finishes or is cancelled.

The concurrency cap (3) and the active-session TTL (6h) are compile-time constants in that file, not environment variables.

### Admin functions

There is no admin panel. Administrative behaviour is a single capability: if `SUPER_ADMIN_ID` is set and matches `ctx.from.id`, both `assertGenerationRateLimit()` and `acquireActiveTestSessionSlot()` return immediately, so that user has no hourly cap, no daily cap, and no concurrency limit. Operational visibility comes from the `/metrics` and `/health` HTTP endpoints and from structured JSON logs, not from bot commands.

---

## Prerequisites

- **Node.js 20+** and npm (for local development)
- **MongoDB 7** and **Redis 7** — either your own instances or the ones in `docker-compose.yml`
- A **Telegram bot token** from [@BotFather](https://t.me/BotFather)
- Credentials for **at least one AI provider**: an Anthropic API key, a Google Gemini API key, or a running Ollama server
- **Docker Engine with the Compose plugin**, if you want the containerised path
- Puppeteer downloads a Chromium build on `npm install`; PDF export needs it

---

## Setup & installation

```bash
git clone https://github.com/dostonsulaymon/ai-quiz.git
cd ai-quiz
npm install
cp .env.example .env
```

Then edit `.env` and fill in, at minimum:

- `BOT_TOKEN` from @BotFather
- `MONGODB_URI` and `REDIS_URL`
- `AI_PROVIDER` plus the matching key/model pair

The config module validates everything at startup and throws a clear `Missing required environment variable: X` before the bot connects, so a bad `.env` fails fast.

---

## Configuration

Every variable below is read somewhere in the source. Nothing else is.

### Core

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `BOT_TOKEN` | Yes | — | Telegram bot token from @BotFather. |
| `NODE_ENV` | Yes | — | Must be `development`, `test`, or `production`. Controls debug logging and whether invalid state transitions throw or warn. |
| `MONGODB_URI` | Yes | — | MongoDB connection string. |
| `REDIS_URL` | Yes | — | Redis connection string. |
| `BOT_USERNAME` | No | — | Bot username used to build `t.me` deep links. Falls back to `ctx.me.username` when unset. |
| `SUPER_ADMIN_ID` | No | — | Numeric Telegram user id that bypasses all rate limits and the concurrent-session cap. |
| `SENTRY_DSN` | No | — | Sentry DSN. When set, Sentry is initialised with a 0.1 traces sample rate and unhandled bot errors are reported. |
| `HEALTH_CHECK_PORT` | No | `4334` | Port for the `/health` and `/metrics` HTTP server. The Dockerfile healthcheck and `docker-compose.yml` port mapping both assume `3000`, so set it to `3000` when running in Docker. |
| `PORT` | No | falls back to `HEALTH_CHECK_PORT` | Overrides the monitoring server port. Useful on PaaS hosts that inject `PORT`. |

### AI providers

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `AI_PROVIDER` | Yes | — | Primary provider. One of `claude`, `gemini`, `ollama`. Its credential pair becomes required. |
| `AI_PROVIDER_ORDER` | No | `claude,gemini,ollama` | Comma-separated fallback order. Only providers whose credentials are present are instantiated. |
| `AI_TIMEOUT_MS` | No | `120000` | Per-request timeout for every provider, enforced with `AbortController`. |
| `CLAUDE_API_KEY` | If `AI_PROVIDER=claude` | — | Anthropic API key, sent as the `x-api-key` header. |
| `CLAUDE_MODEL` | If `AI_PROVIDER=claude` | — | Anthropic model id, e.g. `claude-sonnet-4-5`. |
| `GEMINI_API_KEY` | If `AI_PROVIDER=gemini` | — | Google Gemini API key, sent as the `x-goog-api-key` header. |
| `GEMINI_MODEL` | If `AI_PROVIDER=gemini` | — | Gemini model id, e.g. `gemini-2.0-flash`. |
| `OLLAMA_BASE_URL` | If `AI_PROVIDER=ollama` | — | Base URL of the Ollama server, e.g. `http://localhost:11434`. |
| `OLLAMA_MODEL` | If `AI_PROVIDER=ollama` | — | Ollama model tag, e.g. `llama3.2`. |

Note that a variable marked "if using X" is still read when another provider is primary — that is how the fallback chain picks up secondary providers. Set several to enable fallback.

### Limits

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `MAX_QUESTIONS_PER_TEST` | Yes | — | Upper bound for the custom question-count prompt in both the upload flow and user settings. Must be a positive number. |
| `MAX_FILE_SIZE_MB` | Yes | — | Maximum accepted upload size for PDFs and images. Must be a positive number. |
| `RATE_LIMIT_GENERATIONS_PER_HOUR` | Yes | — | Per-user AI generations allowed per rolling hour. Must be a positive number. |
| `RATE_LIMIT_DAILY_MAX` | Yes | — | Per-user AI generations allowed per rolling 24 hours. Must be a positive number. |

### Session lifetimes

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SESSION_TTL_SECONDS` | No | `604800` (7 days) | TTL applied to grammY session keys in Redis. |
| `STALE_GROUP_SESSION_TTL_MS` | No | `1800000` (30 min) | Age after which an active group session is marked abandoned by the cleanup job. |
| `ABANDONED_SESSION_TTL_MS` | No | `86400000` (24 h) | Age after which an unfinished private test session is marked abandoned. |

---

## Running locally

Start MongoDB and Redis first (the compose file below can do it), then:

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs `src/index.ts` directly with `tsx`. |
| `npm run build` | Compiles TypeScript to `dist/` with `tsc -p tsconfig.json`. |
| `npm run typecheck` | Type-checks without emitting output. |
| `npm test` | Runs the Vitest suite once. |
| `npm run test:watch` | Runs Vitest in watch mode. |
| `npm run test:coverage` | Runs the suite with V8 coverage (text + HTML reports). |

There is no `start` script. In production the built entrypoint is run directly:

```bash
npm run build
node dist/index.js
```

Once running, verify the process:

```bash
curl http://localhost:4334/health    # {"ok":true}
curl http://localhost:4334/metrics
```

(Use whichever port you set in `HEALTH_CHECK_PORT`.)

---

## Running with Docker

The stack is three services: `bot`, `mongo:7`, and `redis:7-alpine`. Both data stores use named volumes (`mongo_data`, `redis_data`) and have healthchecks; the bot waits for both to be healthy before starting.

Set these in `.env` so the containers can reach each other:

```env
MONGODB_URI=mongodb://mongo:27017/quizbot
REDIS_URL=redis://redis:6379
HEALTH_CHECK_PORT=3000
```

### Development

`docker-compose.override.yml` is picked up automatically by `docker compose`. It builds only the `builder` stage, runs `npm run dev`, bind-mounts `src/`, forces `NODE_ENV=development`, and publishes MongoDB on `27017` and Redis on `6379` for local inspection:

```bash
docker compose up --build
```

### Production

Ignore the override file explicitly so you get the slim runner image — a non-root `app` user, production-only dependencies, and `node dist/index.js`:

```bash
docker compose -f docker-compose.yml up -d --build
docker compose -f docker-compose.yml ps
curl http://localhost:3000/health
```

The image's `HEALTHCHECK` polls `http://localhost:3000/health` every 30s, so `HEALTH_CHECK_PORT` must be `3000` inside the container.

See [DEPLOYMENT.md](DEPLOYMENT.md) for VPS setup notes, log commands, and MongoDB backup steps.

### Logs

```bash
docker compose logs -f bot
docker compose logs -f
```

### Local models with Ollama

Install [Ollama](https://ollama.com), pull a model, and point the bot at it:

```bash
ollama pull llama3.2
```

```env
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_MODEL=llama3.2
```

Outside Docker, use `http://localhost:11434`. Ollama is text-only in this codebase: PDFs are extracted to text locally first, and image uploads are rejected.

---

## Testing

```bash
npm test              # vitest run
npm run test:watch    # vitest
npm run test:coverage # vitest run --coverage
```

`vitest.config.ts` enables globals, uses the `node` environment, and collects `src/**/*.test.ts`. Coverage reports (`text` + `html`) cover `src/**/*.ts` excluding test files and `src/index.ts`.

The suite currently targets the highest-risk pure logic:

| Test file | Covers |
| --- | --- |
| `src/ai/providers/base.provider.test.ts` | AI response parsing, question-ID deduplication and fallback IDs |
| `src/db/repositories/leaderboard.repository.test.ts` | Better-score and faster-tiebreak upsert rules |
| `src/bot/utils/format.test.ts` | Truncation and whitespace normalisation |
| `src/shared/i18n/index.test.ts` | Translation lookup and `{variable}` interpolation fallback |
| `src/bot/state-machine.test.ts` | Valid and invalid session state transitions |

See [TEST.md](TEST.md) for the list of areas still worth covering.

---

## Project structure

```
src/
├── index.ts                        # Bootstrap: HTTP health/metrics server, DB + Redis, timer recovery, graceful shutdown
├── config/
│   └── index.ts                    # Env parsing and validation; the single Config object
├── ai/
│   ├── ai.interface.ts             # IAIProvider contract
│   ├── ai.factory.ts               # Provider list, priority order, generateWithFallback()
│   └── providers/
│       ├── base.provider.ts        # Shared prompt, JSON parsing, sanitisation, PDF text extraction
│       ├── claude.provider.ts
│       ├── gemini.provider.ts
│       └── ollama.provider.ts
├── bot/
│   ├── index.ts                    # createBot(): middleware chain and poll_answer wiring
│   ├── router.ts                   # State-based dispatch
│   ├── state-machine.ts            # VALID_TRANSITIONS, transitionTo(), assertions
│   ├── types.ts                    # BotContext, BotSession, session reset helpers
│   ├── handlers/
│   │   ├── commands.ts             # /start /newtest /join /cancel /stop /help /language /leaderboard /stats /settings
│   │   ├── upload.handler.ts       # File/text intake, config wizard, AI generation
│   │   ├── review.handler.ts       # Pre-save question review and edits
│   │   ├── test.handler.ts         # Private quiz flow, polls, timers, self-grading, results
│   │   ├── group.handler.ts        # Group quiz sessions and scoring
│   │   ├── edit.handler.ts         # Post-creation test editing
│   │   ├── mytests.handler.ts      # /mytests: browse, share, duplicate, export, analytics
│   │   ├── classes.handler.ts      # /myclasses: class CRUD and sharing
│   │   ├── history.handler.ts      # /history: past sessions
│   │   ├── leaderboard.handler.ts  # Leaderboard rendering
│   │   ├── settings.handler.ts     # Per-user quiz defaults
│   │   └── report.handler.ts       # Bad-question reports
│   ├── middlewares/
│   │   ├── userMiddleware.ts       # User lookup/creation, caching, language resolution
│   │   ├── rateLimitMiddleware.ts  # Hourly/daily caps, concurrency slots, admin bypass
│   │   └── errorMiddleware.ts      # bot.catch: AppError mapping, Sentry, user-facing replies
│   ├── storage/
│   │   └── redis-session.storage.ts
│   └── utils/
│       ├── keyboards.ts            # Persistent main-menu keyboard
│       ├── format.ts               # Truncation, whitespace, localized dates
│       ├── telegram.ts             # safeEditMessage / safeDeleteMessage helpers
│       ├── upload-storage.ts       # Base64 upload staging in Redis
│       ├── pdf-export.puppeteer.ts # Active PDF export (headless Chromium)
│       └── pdf-export.ts           # Alternative pdfkit-based export
├── db/
│   ├── connection.ts               # Mongoose connect with retries
│   ├── models/                     # user, test, test-session, group-session, leaderboard, class
│   └── repositories/               # One repository per model
├── redis/
│   └── index.ts                    # ioredis client factory
├── shared/
│   ├── logger.ts                   # Structured JSON logger
│   ├── metrics.ts                  # In-memory counters served at /metrics
│   ├── errors/                     # AppError, AIError, RateLimitError, NotFoundError, ValidationError
│   ├── i18n/                       # t(), en.ts, uz.ts
│   └── types/                      # Question, GenerateQuestionsInput, shared unions
├── types/
│   └── modules.d.ts                # Ambient declarations for untyped deps
└── assets/
    └── fonts/                      # Fonts embedded in PDF exports (Noto, Cairo, Amiri)
```

---

## Contributing

Contributions are welcome.

1. Fork the repository and create a branch off `main`.
2. Install dependencies and copy `.env.example` to `.env`.
3. Make your change. Keep it focused — one concern per pull request.
4. Run `npm run typecheck` and `npm test`. Both must pass.
5. Add or update tests for any logic you change, especially in `src/ai/`, `src/db/repositories/`, and `src/bot/state-machine.ts`.
6. Open a pull request describing what changed and why.

**Never commit a real `.env`, API key, bot token, or personal Telegram user id.** Use placeholders in every example.

### Adding a new AI provider

1. Implement `IAIProvider` from `src/ai/ai.interface.ts`.
2. Add the provider class under `src/ai/providers/`, reusing `createQuestionPrompt`, `parseQuestionsResponse`, and `extractTextFromInput` from `base.provider.ts`.
3. Register it in the `getAIProviders()` switch in `src/ai/ai.factory.ts`.
4. Add its `AIProviderType` value in `src/shared/types/index.ts` and extend `PROVIDERS`, `providerSpecificRequirements`, and the `Config` type in `src/config/index.ts`.
5. Document its environment variables in `.env.example` and in the Configuration table above.

### Adding a translation

`src/shared/i18n/en.ts` defines `TranslationMap`, and `uz.ts` must satisfy it — the compiler will tell you if a key is missing. Register any new language in `src/shared/i18n/index.ts`, add it to the `language` enum in `src/db/models/user.model.ts`, and add a `setMyCommands` call for it in `src/bot/handlers/commands.ts`.

---

## License

Released under the [MIT License](LICENSE).
