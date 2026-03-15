import type { BotCommand } from "grammy/types";
import type { Bot } from "grammy";
import type { BotContext } from "../types.js";
import { REVIEW_CONVERSATION_NAME } from "../scenes/review.scene.js";
import { TEST_CONVERSATION_NAME } from "../scenes/test.scene.js";
import { resetSession } from "../types.js";
import { UPLOAD_CONVERSATION_NAME } from "../scenes/upload.scene.js";

const commands: BotCommand[] = [
  { command: "start", description: "Start the bot and open a shared test" },
  { command: "newtest", description: "Create a new test from text, PDF, or images" },
  { command: "join", description: "Join a shared test using a share code" },
  { command: "mytests", description: "List tests you created" },
  { command: "history", description: "View your past test sessions" },
  { command: "cancel", description: "Cancel the current flow and reset progress" },
  { command: "help", description: "Show available commands" }
];

const helpText = [
  "Available commands:",
  "/start - Welcome message and open a shared test via deep link",
  "/newtest - Start creating a new quiz",
  "/join [CODE] - Join a shared quiz by share code",
  "/mytests - View your created tests (coming soon)",
  "/history - View your completed sessions (coming soon)",
  "/cancel - Reset the current session",
  "/help - Show this help message"
].join("\n");

const normalizeShareCode = (value: string | undefined): string | undefined => {
  const code = value?.trim().toUpperCase();
  return code ? code : undefined;
};

export const registerCommandHandlers = async (bot: Bot<BotContext>): Promise<void> => {
  await bot.api.setMyCommands(commands);

  bot.command("start", async (ctx) => {
    const deepLinkCode = normalizeShareCode(typeof ctx.match === "string" ? ctx.match : undefined);

    resetSession(ctx.session);

    if (deepLinkCode) {
      ctx.session.pendingJoinCode = deepLinkCode;
      await ctx.reply(
        `Welcome to Quiz Bot. I found share code ${deepLinkCode} in your start link and saved it for the join flow.`
      );
      return;
    }

    await ctx.reply(
      "Welcome to Quiz Bot.\nUse /newtest to create a quiz or /join SHARECODE to take a shared one."
    );
  });

  bot.command("newtest", async (ctx) => {
    resetSession(ctx.session);
    await ctx.conversation.exit(UPLOAD_CONVERSATION_NAME).catch(() => undefined);
    await ctx.conversation.exit(REVIEW_CONVERSATION_NAME).catch(() => undefined);
    await ctx.conversation.enter(UPLOAD_CONVERSATION_NAME);
  });

  bot.command("join", async (ctx) => {
    const shareCode = normalizeShareCode(typeof ctx.match === "string" ? ctx.match : undefined);

    if (!shareCode) {
      ctx.session.pendingJoinCode = undefined;
      await ctx.reply("Send me the 6-character share code and I’ll prepare the join flow.");
      return;
    }

    ctx.session.pendingJoinCode = shareCode;
    await ctx.reply(`Share code ${shareCode} saved. I’ll use it when the join flow is connected.`);
  });

  bot.command("mytests", async (ctx) => {
    await ctx.reply("Coming soon.");
  });

  bot.command("history", async (ctx) => {
    await ctx.reply("Coming soon.");
  });

  bot.command("cancel", async (ctx) => {
    resetSession(ctx.session);
    await ctx.conversation.exit(UPLOAD_CONVERSATION_NAME).catch(() => undefined);
    await ctx.conversation.exit(REVIEW_CONVERSATION_NAME).catch(() => undefined);
    await ctx.conversation.exit(TEST_CONVERSATION_NAME).catch(() => undefined);
    await ctx.reply("Your current flow has been cancelled and your session is back to idle.");
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpText);
  });
};
