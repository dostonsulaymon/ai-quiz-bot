import type { MiddlewareFn } from "grammy";
import { AppError } from "../../shared/errors/AppError.js";
import type { BotContext } from "../types.js";

const ACTIVE_GENERATION_STATES = new Set(["uploading", "configuring", "reviewing"]);
const MAX_ACTIVE_GENERATIONS = 3;
const LOCK_TTL_SECONDS = 60;

export const rateLimitMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (!ctx.from || !ACTIVE_GENERATION_STATES.has(ctx.session.state)) {
    await next();
    return;
  }

  const lockKey = `quiz-bot:ratelimit:${ctx.from.id}`;
  const activeCount = await ctx.redis.incr(lockKey);

  if (activeCount === 1) {
    await ctx.redis.expire(lockKey, LOCK_TTL_SECONDS);
  }

  if (activeCount > MAX_ACTIVE_GENERATIONS) {
    await ctx.redis.decr(lockKey);
    throw new AppError("Too many active generation requests. Please wait for existing ones to finish.", 429);
  }

  try {
    await next();
  } finally {
    const remaining = await ctx.redis.decr(lockKey);
    if (remaining <= 0) {
      await ctx.redis.del(lockKey);
    }
  }
};
