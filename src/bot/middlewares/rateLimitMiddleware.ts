import { config } from "../../config/index.js";
import { RateLimitError } from "../../shared/errors/RateLimitError.js";
import type { BotContext } from "../types.js";

const DAILY_TTL_SECONDS = 24 * 60 * 60;
const HOURLY_TTL_SECONDS = 60 * 60;
const MAX_CONCURRENT_TEST_SESSIONS = 3;
const ACTIVE_SESSION_TTL_SECONDS = 6 * 60 * 60;

const formatDuration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours <= 0) {
    return `${minutes}m`;
  }

  return `${hours}h ${minutes}m`;
};

const getUserId = (ctx: BotContext): number => {
  if (!ctx.from?.id) {
    throw new RateLimitError("Missing user id for rate limiting", "I couldn't verify your session. Please try again.");
  }

  return ctx.from.id;
};

const incrementWithTtl = async (
  ctx: BotContext,
  key: string,
  ttlSeconds: number
): Promise<{ count: number; ttl: number }> => {
  const count = await ctx.redis.incr(key);

  if (count === 1) {
    await ctx.redis.expire(key, ttlSeconds);
  }

  const ttl = await ctx.redis.ttl(key);
  return { count, ttl: ttl > 0 ? ttl : ttlSeconds };
};

export const assertGenerationRateLimit = async (ctx: BotContext): Promise<void> => {
  const userId = getUserId(ctx);

  if (config.SUPER_ADMIN_ID && userId === config.SUPER_ADMIN_ID) {
    return;
  }

  const dailyKey = `quiz-bot:ratelimit:daily-api:${userId}`;
  const daily = await incrementWithTtl(ctx, dailyKey, DAILY_TTL_SECONDS);

  if (daily.count > config.RATE_LIMIT_DAILY_MAX) {
    await ctx.redis.decr(dailyKey);
    throw new RateLimitError(
      "Daily API limit exceeded",
      "error.rateLimit_daily",
      { limit: config.RATE_LIMIT_DAILY_MAX, duration: formatDuration(daily.ttl) }
    );
  }

  const key = `quiz-bot:ratelimit:generation:${userId}`;
  const { count, ttl } = await incrementWithTtl(ctx, key, HOURLY_TTL_SECONDS);

  if (count > config.RATE_LIMIT_GENERATIONS_PER_HOUR) {
    await ctx.redis.decr(key);
    throw new RateLimitError(
      "Hourly generation limit exceeded",
      "error.rateLimit_hourly",
      { limit: config.RATE_LIMIT_GENERATIONS_PER_HOUR, duration: formatDuration(ttl) }
    );
  }
};

export const acquireActiveTestSessionSlot = async (ctx: BotContext): Promise<void> => {
  const userId = getUserId(ctx);

  if (config.SUPER_ADMIN_ID && userId === config.SUPER_ADMIN_ID) {
    return;
  }

  if (ctx.session.activeTestSlotId) {
    await ctx.redis.expire(`quiz-bot:ratelimit:active-tests:${userId}`, ACTIVE_SESSION_TTL_SECONDS);
    return;
  }

  const slotId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const key = `quiz-bot:ratelimit:active-tests:${userId}`;
  await ctx.redis.sadd(key, slotId);
  await ctx.redis.expire(key, ACTIVE_SESSION_TTL_SECONDS);

  const activeCount = await ctx.redis.scard(key);
  if (activeCount > MAX_CONCURRENT_TEST_SESSIONS) {
    await ctx.redis.srem(key, slotId);
    const ttl = await ctx.redis.ttl(key);
    throw new RateLimitError(
      "Too many concurrent test sessions",
      "error.rateLimit_concurrent",
      { limit: MAX_CONCURRENT_TEST_SESSIONS, duration: formatDuration(ttl > 0 ? ttl : ACTIVE_SESSION_TTL_SECONDS) }
    );
  }

  ctx.session.activeTestSlotId = slotId;
};

export const releaseActiveTestSessionSlot = async (ctx: BotContext): Promise<void> => {
  const userId = ctx.from?.id;
  const slotId = ctx.session.activeTestSlotId;

  if (!userId || !slotId) {
    return;
  }

  await ctx.redis.srem(`quiz-bot:ratelimit:active-tests:${userId}`, slotId);
  ctx.session.activeTestSlotId = undefined;
};
