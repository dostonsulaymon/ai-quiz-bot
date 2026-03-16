# Deployment Guide

## Prerequisites

- Docker Engine with Docker Compose
- A Telegram bot token from `@BotFather`
- Access to MongoDB and Redis through Docker Compose
- API credentials for at least one AI provider

## Quick Start With Docker Compose

1. Copy the example environment file: `cp .env.example .env`
2. Fill in the required values in `.env`, especially `BOT_TOKEN`, database URLs, and AI provider credentials.
3. Build and start the stack: `docker compose up -d --build`
4. Check service status: `docker compose ps`
5. Verify the bot health endpoint: `curl http://localhost:3000/health`

## Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `BOT_TOKEN` | Yes | None | Telegram bot token from `@BotFather`. |
| `NODE_ENV` | Yes | `development` | Runtime environment: `development`, `test`, or `production`. |
| `SENTRY_DSN` | No | None | Sentry DSN for error monitoring and tracing. |
| `HEALTH_CHECK_PORT` | No | `3000` | Port used by the local health and metrics HTTP server. |
| `AI_PROVIDER` | Yes | None | Primary AI provider: `claude`, `gemini`, or `ollama`. |
| `AI_PROVIDER_ORDER` | No | `claude,gemini,ollama` | Ordered fallback list for AI generation attempts. |
| `CLAUDE_API_KEY` | If using Claude | None | Anthropic API key. |
| `CLAUDE_MODEL` | If using Claude | None | Claude model name. |
| `GEMINI_API_KEY` | If using Gemini | None | Google Gemini API key. |
| `GEMINI_MODEL` | If using Gemini | None | Gemini model name. |
| `OLLAMA_BASE_URL` | If using Ollama | None | Base URL for the Ollama server. |
| `OLLAMA_MODEL` | If using Ollama | None | Ollama model name. |
| `MONGODB_URI` | Yes | None | MongoDB connection string. |
| `REDIS_URL` | Yes | None | Redis connection string. |
| `MAX_QUESTIONS_PER_TEST` | Yes | None | Maximum allowed generated questions per test. |
| `MAX_FILE_SIZE_MB` | Yes | None | Maximum upload size in MB for PDFs and images. |
| `RATE_LIMIT_GENERATIONS_PER_HOUR` | Yes | None | Per-user hourly generation cap. |
| `RATE_LIMIT_DAILY_MAX` | Yes | None | Per-user daily generation cap. |
| `AI_TIMEOUT_MS` | No | `60000` | Timeout for AI provider requests in milliseconds. |
| `SESSION_TTL_SECONDS` | No | `604800` | Session lifetime in Redis in seconds. |
| `STALE_GROUP_SESSION_TTL_MS` | No | `1800000` | Age threshold for cleaning stale active group sessions. |
| `ABANDONED_SESSION_TTL_MS` | No | `86400000` | Age threshold for marking stale private test sessions abandoned. |

## Health Checks

- Health endpoint: `curl http://localhost:3000/health`
- Metrics endpoint: `curl http://localhost:3000/metrics`

## Logs

- Follow bot logs: `docker compose logs -f bot`
- Follow all services: `docker compose logs -f`

## Updating The Deployment

1. Pull the latest code: `git pull`
2. Rebuild and restart containers: `docker compose up -d --build`
3. Confirm health again: `curl http://localhost:3000/health`

## MongoDB Backup

Use `mongodump` from the Mongo container:

```bash
docker compose exec mongo mongodump --archive=/data/db/backup.archive
```

To copy the archive out:

```bash
docker compose cp mongo:/data/db/backup.archive ./backup.archive
```

## VPS Setup Notes

- Recommended host: Ubuntu 22.04 or newer
- Install Docker and Compose plugin:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin git
sudo systemctl enable --now docker
```

- Clone the repository and enter it:

```bash
git clone <your-repo-url>
cd quiz-bot
```

- Create and edit the environment file:

```bash
cp .env.example .env
nano .env
```

- Start the stack:

```bash
docker compose up -d --build
```

- Verify the deployment:

```bash
docker compose ps
curl http://localhost:3000/health
```
