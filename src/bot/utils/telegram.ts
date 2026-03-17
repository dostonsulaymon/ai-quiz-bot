import type { Api } from "grammy";
import type { BotContext } from "../types.js";

const isSilenceableEditError = (error: unknown): boolean => {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("message is not modified") ||
    msg.includes("message to edit not found") ||
    msg.includes("MESSAGE_ID_INVALID") ||
    msg.includes("chat not found")
  );
};

export async function safeEditMessage(
  ctx: BotContext,
  text: string,
  extra?: Parameters<typeof ctx.editMessageText>[1]
): Promise<void> {
  try {
    await ctx.editMessageText(text, extra);
  } catch (error) {
    if (isSilenceableEditError(error)) return;
    throw error;
  }
}

export async function safeEditMessageViaApi(
  api: Api,
  chatId: number | string,
  messageId: number,
  text: string,
  extra?: Record<string, unknown>
): Promise<void> {
  try {
    await api.editMessageText(chatId, messageId, text, extra as never);
  } catch (error) {
    if (isSilenceableEditError(error)) return;
    throw error;
  }
}

export async function safeDeleteMessage(
  api: Api,
  chatId: number | string,
  messageId: number
): Promise<void> {
  try {
    await api.deleteMessage(chatId, messageId);
  } catch {
    // Ignore
  }
}

