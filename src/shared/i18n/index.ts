import { en, type TranslationMap } from "./en.js";
import { uz } from "./uz.js";
import type { QuestionType } from "../types/index.js";

export type Language = "en" | "uz";

const translations: Record<Language, TranslationMap> = { en, uz };

/**
 * Translate a key for the given language with optional {variable} interpolation.
 * Falls back to English if a key is missing in the target language (should not
 * happen in practice since uz satisfies TranslationMap at compile time).
 */
export const t = (
  lang: Language,
  key: keyof TranslationMap,
  vars?: Record<string, string | number>
): string => {
  const template = translations[lang][key] ?? translations.en[key] ?? String(key);
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
};

/**
 * Format a list of question types into a human-readable, deduplicated string.
 * Consolidates the duplicated formatQuestionTypes helper that previously existed
 * in commands.ts and mytests.handler.ts.
 */
export const formatQuestionTypes = (types: string[], lang: Language): string =>
  [...new Set(types)]
    .map((type) => {
      switch (type as QuestionType) {
        case "mcq": return t(lang, "upload.type.mcq");
        case "truefalse": return t(lang, "upload.type.truefalse");
        case "short": return t(lang, "upload.type.short");
        case "fill": return t(lang, "upload.type.fill");
        default: return type;
      }
    })
    .join(", ");
