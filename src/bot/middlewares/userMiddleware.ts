import type { MiddlewareFn } from "grammy";
import { UserRepository } from "../../db/repositories/user.repository.js";
import type { BotContext } from "../types.js";

const userRepository = new UserRepository();

export const userMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (!ctx.from) {
    await next();
    return;
  }

  const user = await userRepository.findOrCreate(ctx.from.id);

  if (
    (ctx.from.username && user.username !== ctx.from.username) ||
    (ctx.from.first_name && user.firstName !== ctx.from.first_name)
  ) {
    ctx.user =
      (await userRepository.updateSettings(user._id, {
        username: ctx.from.username,
        firstName: ctx.from.first_name
      })) ?? user;
  } else {
    ctx.user = user;
  }

  await next();
};
