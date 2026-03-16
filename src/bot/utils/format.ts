import { t, type Language } from "../../shared/i18n/index.js";

export const formatDate = (value: Date | string | undefined, showYear: boolean, lang: Language): string =>
  value
    ? new Intl.DateTimeFormat(lang === "uz" ? "uz-UZ" : "en-US", {
        month: "long",
        day: "numeric",
        ...(showYear && { year: "numeric" })
      }).format(new Date(value))
    : t(lang, "common.unknownDate");
