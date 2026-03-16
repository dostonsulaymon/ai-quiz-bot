import { t, type Language } from "../../shared/i18n/index.js";

export const MAX_QUESTION_LENGTH = 500;
export const MAX_OPTION_LENGTH = 150;

export function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function truncateText(text: string, maxLength: number, suffix = "..."): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - suffix.length).trimEnd() + suffix;
}

export function formatQuestionDisplay(text: string): { display: string; truncated: boolean } {
  if (text.length <= MAX_QUESTION_LENGTH) return { display: text, truncated: false };
  return { display: truncateText(text, MAX_QUESTION_LENGTH), truncated: true };
}

export function formatOptionDisplay(text: string): string {
  return truncateText(text, MAX_OPTION_LENGTH);
}

export const formatDate = (value: Date | string | undefined, showYear: boolean, lang: Language): string =>
  value
    ? new Intl.DateTimeFormat(lang === "uz" ? "uz-UZ" : "en-US", {
        month: "long",
        day: "numeric",
        ...(showYear && { year: "numeric" })
      }).format(new Date(value))
    : t(lang, "common.unknownDate");
