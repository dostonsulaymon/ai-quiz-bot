import type { Conversation } from "@grammyjs/conversations";
import type { BotContext } from "../types.js";

export const TEST_CONVERSATION_NAME = "test";

export const testScene = async (_conversation: Conversation<BotContext, BotContext>, ctx: BotContext): Promise<void> => {
  await ctx.reply(
    `Test ready.\nSaved test ID: ${ctx.session.activeTestId ?? "unknown"}\nThe interactive test flow will be added next.`
  );
};
