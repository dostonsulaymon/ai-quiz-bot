import PDFDocument from "pdfkit";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ArabicReshaper from "arabic-reshaper";
import bidiFactory from "bidi-js";
import type { TestDocument } from "../../db/models/test.model.js";
import { t, formatQuestionTypes, type Language } from "../../shared/i18n/index.js";
import { logger } from "../../shared/logger.js";

const bidi = bidiFactory();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AMIRI_REGULAR_PATH = path.resolve(__dirname, "../../assets/fonts/Amiri-Regular.ttf");
const AMIRI_BOLD_PATH = path.resolve(__dirname, "../../assets/fonts/Amiri-Bold.ttf");
const CAIRO_REGULAR_PATH = path.resolve(__dirname, "../../assets/fonts/Cairo-Regular.ttf");
const CAIRO_BOLD_PATH = path.resolve(__dirname, "../../assets/fonts/Cairo-Bold.ttf");
const NOTO_SANS_ARABIC_REGULAR_PATH = path.resolve(__dirname, "../../assets/fonts/NotoSansArabic-Regular.ttf");
const NOTO_NASKH_ARABIC_REGULAR_PATH = path.resolve(__dirname, "../../assets/fonts/NotoNaskhArabic-Regular.ttf");
const NOTO_SANS_REGULAR_PATH = path.resolve(__dirname, "../../assets/fonts/NotoSans-Regular.ttf");

const hasArabic = (text: string): boolean => /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);

const resolveFirstExistingFont = (candidates: string[]): string | null => {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

/**
 * Reshapes Arabic text and applies the Unicode Bidirectional Algorithm
 * for proper display in PDFKit.
 */
const fixArabicText = (text: string): string => {
  if (!text || !hasArabic(text)) return text;
  try {
    const reshaped = ArabicReshaper.convertArabic(text);
    return bidi.getReorderedString(reshaped, bidi.getEmbeddingLevels(reshaped));
  } catch (e) {
    return text;
  }
};

/**
 * Segments text into Arabic and non-Arabic chunks for font switching.
 */
const segmentText = (text: string): { text: string; isArabic: boolean }[] => {
  const arabicRegex = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+/g;
  const segments: { text: string; isArabic: boolean }[] = [];
  let lastIndex = 0;
  let match;

  while ((match = arabicRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), isArabic: false });
    }
    segments.push({ text: match[0], isArabic: true });
    lastIndex = arabicRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), isArabic: false });
  }

  return segments || [{ text, isArabic: false }];
};

const isArabicDominant = (text: string): boolean => {
  const arabicChars = (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) ?? []).length;
  const latinChars = (text.match(/[A-Za-z]/g) ?? []).length;
  return arabicChars > latinChars;
};

/**
 * Draw a full line in a single PDFKit call.
 * Arabic runs are reshaped + bidi-processed once for the whole line.
 */
const drawMixedText = (
  doc: PDFKit.PDFDocument,
  text: string,
  options: Record<string, unknown> = {},
  isBold: boolean = false
) => {
  const rawText = (text ?? "").replace(/[\u2066\u2067\u2068\u2069\u200E\u200F]/g, "");
  const processedText = hasArabic(rawText) ? fixArabicText(rawText) : rawText;

  const requestedAlign = options.align as "left" | "center" | "right" | "justify" | undefined;
  const resolvedAlign = hasArabic(rawText) && isArabicDominant(rawText)
    ? "right"
    : requestedAlign;

  doc.font(isBold ? "CairoBold" : "CairoRegular");
  doc.text(processedText, {
    ...options,
    align: resolvedAlign
  });
};

const collectTextForFontCheck = (test: TestDocument, includeAnswers: boolean): string[] => {
  const values: string[] = [test.title ?? ""];

  for (const question of test.questions) {
    values.push(question.question, question.explanation ?? "");
    if (question.options) {
      values.push(question.options.A ?? "", question.options.B ?? "", question.options.C ?? "", question.options.D ?? "");
    }
    if (includeAnswers) {
      values.push(question.correctAnswer);
    }
  }

  return values;
};

export async function generateTestPDF(
  test: TestDocument,
  lang: Language,
  includeAnswers: boolean
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const _ = collectTextForFontCheck(test, includeAnswers);
    void _;

    const regularFontPath = resolveFirstExistingFont([
      AMIRI_REGULAR_PATH,
      NOTO_NASKH_ARABIC_REGULAR_PATH,
      NOTO_SANS_ARABIC_REGULAR_PATH,
      CAIRO_REGULAR_PATH,
      NOTO_SANS_REGULAR_PATH
    ]);
    const boldFontPath = resolveFirstExistingFont([
      AMIRI_BOLD_PATH,
      AMIRI_REGULAR_PATH,
      NOTO_NASKH_ARABIC_REGULAR_PATH,
      NOTO_SANS_ARABIC_REGULAR_PATH,
      CAIRO_BOLD_PATH,
      CAIRO_REGULAR_PATH,
      NOTO_SANS_REGULAR_PATH
    ]);

    if (!regularFontPath || !boldFontPath) {
      throw new Error(
        [
          "Missing Arabic-capable font files for PDF export.",
          "Provide Cairo-Regular.ttf/Cairo-Bold.ttf in src/assets/fonts/",
          `Checked regular candidates: ${[AMIRI_REGULAR_PATH, NOTO_NASKH_ARABIC_REGULAR_PATH, NOTO_SANS_ARABIC_REGULAR_PATH, CAIRO_REGULAR_PATH, NOTO_SANS_REGULAR_PATH].join(", ")}`,
          `Checked bold candidates: ${[AMIRI_BOLD_PATH, AMIRI_REGULAR_PATH, NOTO_NASKH_ARABIC_REGULAR_PATH, NOTO_SANS_ARABIC_REGULAR_PATH, CAIRO_BOLD_PATH, CAIRO_REGULAR_PATH, NOTO_SANS_REGULAR_PATH].join(", ")}`
        ].join(" ")
      );
    }

    logger.info("PDF export font selection", {
      event: "pdf.export.fonts.selected",
      regularFontPath,
      boldFontPath,
      usingCairoRegular: regularFontPath === CAIRO_REGULAR_PATH,
      usingCairoBold: boldFontPath === CAIRO_BOLD_PATH
    });

    // Validate selected font files are readable before registering.
    readFileSync(regularFontPath);
    readFileSync(boldFontPath);
    doc.registerFont("CairoRegular", regularFontPath);
    doc.registerFont("CairoBold", boldFontPath);

    // Title
    const titleText = test.title?.trim() || t(lang, "common.untitledTest");
    doc.fontSize(20).fillColor("black");
    drawMixedText(doc, titleText, { align: "center" }, true);
    doc.moveDown();

    // Subtitle
    const left = t(lang, "mytests.preview.questions", { n: test.questions.length });
    const right = formatQuestionTypes(test.questions.map((q) => q.type), lang);
    const subtitle = `${left} • ${right}`;
    doc.fontSize(10).fillColor("black");
    drawMixedText(doc, subtitle, { align: "center" });
    doc.moveDown(2);

    test.questions.forEach((question, index) => {
      doc.fontSize(12).fillColor("black");
      drawMixedText(doc, `${index + 1}. ${question.question}`);
      doc.moveDown(0.5);

      if (question.type === "mcq" && question.options) {
        (["A", "B", "C", "D"] as const).forEach((letter) => {
          const option = question.options?.[letter];
          if (option) {
            doc.fontSize(11).fillColor("black");
            drawMixedText(doc, `${letter}) ${option}`, { indent: 20 });
          }
        });
      } else if (question.type === "truefalse") {
        doc.fontSize(11).fillColor("black");
        drawMixedText(doc, "A) True    B) False", { indent: 20 });
      } else {
        doc.fontSize(11).fillColor("black");
        drawMixedText(doc, `${t(lang, "mytests.export.answerLine")}`, { indent: 20 });
      }

      if (includeAnswers) {
        doc.fontSize(10).fillColor("green");
        drawMixedText(doc, `✓ ${question.correctAnswer}`, { indent: 20 });
        doc.fillColor("black");
      }

      doc.moveDown();
    });

    doc.end();
  });
}
