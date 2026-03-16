import { type Bot } from "grammy";
import { LeaderboardRepository } from "../../db/repositories/leaderboard.repository.js";
import { TestRepository } from "../../db/repositories/test.repository.js";
import type { LeaderboardEntry } from "../../db/models/leaderboard.model.js";
import type { BotContext } from "../types.js";
import { t, type Language } from "../../shared/i18n/index.js";
import { LEADERBOARD_CALLBACK_PREFIX } from "./test.handler.js";

const leaderboardRepository = new LeaderboardRepository();
const testRepository = new TestRepository();

const TOP_COUNT = 10;
const SEPARATOR = "━━━━━━━━━━━━━━━━━━━━";
const MEDALS = ["🥇", "🥈", "🥉"];

const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
};

const renderRow = (entry: LeaderboardEntry, position: number, isUser: boolean, showTime: boolean): string => {
  const medal = position <= 3 ? MEDALS[position - 1]! : `${position}.`;
  const timePart = showTime ? ` — ${formatTime(entry.timeTakenSeconds)}` : "";
  const scorePart = `${entry.score}% (${entry.correctCount}/${entry.totalQuestions})`;
  const prefix = isUser ? "→ " : "";
  const displayName = entry.username ? `@${entry.username}` : entry.firstName;
  return `${prefix}${medal} ${displayName} — ${scorePart}${timePart}`;
};

export const renderLeaderboard = async (
  testId: string,
  currentUserId: string | undefined,
  lang: Language
): Promise<{ text: string }> => {
  const test = await testRepository.findById(testId);
  const testTitle = test?.title?.trim() || t(lang, "common.untitledTest");

  const totalParticipants = await leaderboardRepository.getParticipantCount(testId);

  const header = [
    SEPARATOR,
    `${t(lang, "leaderboard.title")} — ${testTitle}`,
    SEPARATOR
  ];

  if (totalParticipants === 0) {
    return { text: [...header, t(lang, "leaderboard.empty"), SEPARATOR].join("\n") };
  }

  const topEntries = await leaderboardRepository.getTopEntries(testId, TOP_COUNT);

  // Determine whether to show time column: omit it only if ALL entries have timeTakenSeconds === 0
  const showTime = topEntries.some((e) => e.timeTakenSeconds > 0);

  const topUserIds = new Set(topEntries.map((e) => String(e.userId)));
  const isInTop = currentUserId && topUserIds.has(currentUserId);

  const rows = topEntries.map((entry, i) =>
    renderRow(entry, i + 1, currentUserId === String(entry.userId), showTime)
  );

  const lines = [...header, ...rows, SEPARATOR];

  if (currentUserId) {
    const { rank, totalParticipants: total, entry: userEntry } = await leaderboardRepository.getUserRank(testId, currentUserId);
    if (userEntry && rank > 0) {
      if (!isInTop) {
        // Show user's own row outside the top
        lines.push(renderRow(userEntry, rank, true, showTime));
      }
      lines.push(t(lang, "leaderboard.rank", { rank, total }));
      lines.push(SEPARATOR);
    }
  }

  return { text: lines.join("\n") };
};

export const registerLeaderboardHandler = (bot: Bot<BotContext>): void => {
  bot.callbackQuery(new RegExp(`^${LEADERBOARD_CALLBACK_PREFIX}`), async (ctx) => {
    const testId = ctx.callbackQuery.data.slice(LEADERBOARD_CALLBACK_PREFIX.length);
    const lang = ctx.lang();
    await ctx.answerCallbackQuery();

    const participantCount = await leaderboardRepository.getParticipantCount(testId);
    if (participantCount < 2) {
      await ctx.reply(t(lang, "leaderboard.no_data"));
      return;
    }

    const { text } = await renderLeaderboard(testId, ctx.user?._id ? String(ctx.user._id) : undefined, lang);
    await ctx.reply(text);
  });
};
