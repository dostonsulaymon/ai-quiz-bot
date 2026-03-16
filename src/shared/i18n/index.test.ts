/// <reference types="vitest" />

import { describe, expect, it } from "vitest";
import { t } from "./index.js";

describe("t", () => {
  it("returns the correct English string", () => {
    expect(t("en", "start.btn.settings")).toBe("⚙️ Settings");
  });

  it("returns the correct Uzbek string", () => {
    expect(t("uz", "start.btn.settings")).toBe("⚙️ Sozlamalar");
  });

  it("interpolates variables", () => {
    expect(t("en", "settings.title", {
      count: 10,
      types: "MCQ",
      timer: "No limit",
      shuffle: "Off"
    })).toContain("Questions: 10");
  });

  it("falls back to the key name when the translation key is missing", () => {
    expect(t("en", "missing.translation.key" as never)).toBe("missing.translation.key");
  });

  it("leaves placeholders intact when a variable is missing", () => {
    expect(t("en", "mytests.export.caption", {})).toBe("📄 {title}");
  });
});
