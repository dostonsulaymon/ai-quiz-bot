import PDFDocument from "pdfkit";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { TestDocument } from "../../db/models/test.model.js";
import { formatQuestionTypes, type Language } from "../../shared/i18n/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const NOTO_SANS_PATH = path.resolve(__dirname, "../../assets/fonts/NotoSans-Regular.ttf");

const hasNonLatin = (text: string): boolean => /[^\x00-\x7F]/.test(text);

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

const applyBodyFont = (doc: PDFKit.PDFDocument, fontName: string, size: number): PDFKit.PDFDocument =>
  doc.font(fontName).fontSize(size).fillColor("black");

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

    const shouldUseUnicodeFont = collectTextForFontCheck(test, includeAnswers).some(hasNonLatin);
    const bodyFont = shouldUseUnicodeFont ? "NotoSans" : "Helvetica";
    const boldFont = shouldUseUnicodeFont ? "NotoSans" : "Helvetica-Bold";
    const italicFont = shouldUseUnicodeFont ? "NotoSans" : "Helvetica-Oblique";

    if (shouldUseUnicodeFont) {
      readFileSync(NOTO_SANS_PATH);
      doc.registerFont("NotoSans", NOTO_SANS_PATH);
    }

    applyBodyFont(doc, boldFont, 20).text(test.title?.trim() || "Untitled Test", { align: "center" });
    doc.moveDown();

    applyBodyFont(doc, bodyFont, 10).text(
      `${test.questions.length} questions • ${formatQuestionTypes(test.questions.map((question) => question.type), lang)}`,
      { align: "center" }
    );
    doc.moveDown(2);

    test.questions.forEach((question, index) => {
      applyBodyFont(doc, boldFont, 12).text(`${index + 1}. ${question.question}`);
      doc.moveDown(0.5);

      if (question.type === "mcq" && question.options) {
        (["A", "B", "C", "D"] as const).forEach((letter) => {
          const option = question.options?.[letter];
          if (option) {
            applyBodyFont(doc, bodyFont, 11).text(`   ${letter}) ${option}`);
          }
        });
      } else if (question.type === "truefalse") {
        applyBodyFont(doc, bodyFont, 11).text("   A) True    B) False");
      } else {
        applyBodyFont(doc, bodyFont, 11).text("   Answer: ___________________________");
      }

      if (includeAnswers) {
        doc.font(italicFont).fontSize(10).fillColor("green").text(`   ✓ ${question.correctAnswer}`).fillColor("black");
      }

      doc.moveDown();
    });

    doc.end();
  });
}
