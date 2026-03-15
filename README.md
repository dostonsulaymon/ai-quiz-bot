# quiz-bot

Telegram quiz bot built with `grammy`, TypeScript, MongoDB, Redis, and pluggable AI providers.

## Quick Start

```bash
git clone <your-repo-url>
cp .env.example .env
docker compose up --build
```

## Switching AI Providers

Change a single environment variable in `.env`:

```env
AI_PROVIDER=claude
```

Valid values are `claude`, `gemini`, and `ollama`. Then fill in only the matching provider credentials/settings.

## Local LLM Setup with Ollama

1. Install Ollama from [ollama.com](https://ollama.com).
2. Start Ollama locally.
3. Pull a model:

```bash
ollama pull llama3.2-vision:11b
```

4. Set these values in `.env`:

```env
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_MODEL=llama3.2-vision:11b
```

If you run the bot outside Docker, you can keep `OLLAMA_BASE_URL=http://localhost:11434`.

## Adding a New AI Provider

1. Implement the `IAIProvider` interface in [REDACTED_PATH/Desktop/test-maker/quiz-bot/src/ai/ai.interface.ts](REDACTED_PATH/Desktop/test-maker/quiz-bot/src/ai/ai.interface.ts).
2. Add the provider class under [REDACTED_PATH/Desktop/test-maker/quiz-bot/src/ai/providers](REDACTED_PATH/Desktop/test-maker/quiz-bot/src/ai/providers).
3. Register it in [REDACTED_PATH/Desktop/test-maker/quiz-bot/src/ai/ai.factory.ts](REDACTED_PATH/Desktop/test-maker/quiz-bot/src/ai/ai.factory.ts).
4. Extend config/env parsing in [REDACTED_PATH/Desktop/test-maker/quiz-bot/src/config/index.ts](REDACTED_PATH/Desktop/test-maker/quiz-bot/src/config/index.ts).
