import PDFDocument from "pdfkit";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ArabicReshaper from "arabic-reshaper";
import bidiFactory from "bidi-js";
import type { TestDocument } from "../../db/models/test.model.js";
import { t, formatQuestionTypes, type Language } from "../../shared/i18n/index.js";

const bidi = bidiFactory();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NOTO_ARABIC_PATH = path.resolve(__dirname, "../../assets/fonts/NotoSansArabic-Regular.ttf");
const NOTO_LATIN_PATH = path.resolve(__dirname, "../../assets/fonts/NotoSans-Regular.ttf");

const hasArabic = (text: string): boolean => /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);

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

/**
 * Helper to draw text using the appropriate font for each character.
 */
const drawMixedText = (
  doc: PDFKit.PDFDocument,
  text: string,
  options: any = {},
  isBold: boolean = false
) => {
  const segments = segmentText(text);
  
  segments.forEach((seg, i) => {
    const isLast = i === segments.length - 1;
    const fontName = seg.isArabic ? "ArabicFont" : "LatinFont";
    
    // PDFKit font switching
    doc.font(fontName);
    
    const processedText = seg.isArabic ? fixArabicText(seg.text) : seg.text;
    
    doc.text(processedText, {
      ...options,
      continued: !isLast
    });
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

    // Register both fonts
    if (existsSync(NOTO_LATIN_PATH)) {
      doc.registerFont("LatinFont", NOTO_LATIN_PATH);
    } else {
      doc.registerFont("LatinFont", "Helvetica"); // Fallback
    }

    if (existsSync(NOTO_ARABIC_PATH)) {
      doc.registerFont("ArabicFont", NOTO_ARABIC_PATH);
    } else {
      doc.registerFont("ArabicFont", "Helvetica"); // Fallback
    }

    // Title
    const titleText = test.title?.trim() || t(lang, "common.untitledTest");
    doc.fontSize(20).fillColor("black");
    drawMixedText(doc, titleText, { align: "center" }, true);
    doc.moveDown();

    // Subtitle
    const subtitle = `${t(lang, "mytests.preview.questions", { n: test.questions.length })} • ${formatQuestionTypes(test.questions.map((q) => q.type), lang)}`;
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
            drawMixedText(doc, `   ${letter}) ${option}`);
          }
        });
      } else if (question.type === "truefalse") {
        doc.fontSize(11).fillColor("black");
        drawMixedText(doc, "   A) True    B) False");
      } else {
        doc.fontSize(11).fillColor("black");
        drawMixedText(doc, `   ${t(lang, "mytests.export.answerLine")}`);
      }

      if (includeAnswers) {
        doc.fontSize(10).fillColor("green");
        drawMixedText(doc, `   ✓ ${question.correctAnswer}`);
        doc.fillColor("black");
      }

      doc.moveDown();
    });

    doc.end();
  });
}
