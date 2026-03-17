import type { MiddlewareFn } from "grammy";
import { UserRepository } from "../../db/repositories/user.repository.js";
import { logger } from "../../shared/logger.js";
import type { Language } from "../../shared/i18n/index.js";
import type { UserDocument } from "../../db/models/user.model.js";
import type { BotContext } from "../types.js";

const userRepository = new UserRepository();
const USER_CACHE_TTL_MS = 60_000;

const getUserCacheKey = (telegramId: number) => `quiz-bot:cache:user:${telegramId}`;

export const userMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (!ctx.from || !ctx.chat) {
    ctx.lang = () => "en";
    await next();
    return;
  }

  const telegramId = ctx.from.id;
  const cacheKey = getUserCacheKey(telegramId);
  let user: UserDocument | null = null;
  let isNewUser = false;

  const cachedUserJson = await ctx.redis.get(cacheKey);
  
  if (cachedUserJson) {
    try {
      user = JSON.parse(cachedUserJson);
    } catch (e) {
      logger.error("Failed to parse cached user", { telegramId, error: e });
    }
  }

  if (!user) {
    user = await userRepository.findOrCreate(telegramId);
    const createdAt: Date | undefined = (user as { createdAt?: Date }).createdAt;
    isNewUser = createdAt ? Date.now() - createdAt.getTime() < 60_000 : false;
    await ctx.redis.set(cacheKey, JSON.stringify(user), "PX", USER_CACHE_TTL_MS);
  }

  const updates: Parameters<typeof userRepository.updateSettings>[1] = {};

  if (ctx.from.username && user.username !== ctx.from.username) {
    updates.username = ctx.from.username;
  }
  if (ctx.from.first_name && user.firstName !== ctx.from.first_name) {
    updates.firstName = ctx.from.first_name;
  }

  if (Object.keys(updates).length > 0) {
    user = (await userRepository.updateSettings(user!._id, updates)) ?? user;
    await ctx.redis.set(cacheKey, JSON.stringify(user), "PX", USER_CACHE_TTL_MS);
  }

  ctx.user = user;
  ctx.isNewUser = isNewUser;

  // Show language prompt when:
  // (a) brand-new user whose Telegram language is not en/uz, OR
  // (b) existing user defaulted to "en" but has a Russian Telegram locale and was never prompted.
  const telegramLang = ctx.from?.language_code ?? "";
  const isUnsupportedTelegramLang = !["en", "uz"].some((l) => telegramLang.startsWith(l));
  const isRussianDefault =
    user.language === "en" &&
    telegramLang.startsWith("ru") &&
    !user.languagePrompted;
  ctx.shouldPromptLanguage =
    (isNewUser && isUnsupportedTelegramLang) || isRussianDefault;

  // Language is authoritative from the DB (set by /language command or schema default).
  // Store it in session so ctx.lang() doesn't need another DB round-trip.
  ctx.session.language = user.language as Language;
  ctx.lang = () => ctx.session.language ?? "en";

  await next();
};
