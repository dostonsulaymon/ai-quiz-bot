import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";
import type { TestDocument } from "../../db/models/test.model.js";
import { t, formatQuestionTypes, type Language } from "../../shared/i18n/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NOTO_NASKH_ARABIC_PATH = path.resolve(__dirname, "../../assets/fonts/NotoNaskhArabic-Regular.ttf");

const hasArabic = (text: string): boolean =>
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);

const isArabicDominant = (text: string): boolean => {
  const arabicChars = (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) ?? []).length;
  const latinChars = (text.match(/[A-Za-z]/g) ?? []).length;
  return arabicChars > latinChars;
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const directionFor = (text: string): "rtl" | "ltr" =>
  hasArabic(text) && isArabicDominant(text) ? "rtl" : "ltr";

const renderQuestionBlock = (
  question: TestDocument["questions"][number],
  index: number,
  lang: Language,
  includeAnswers: boolean
): string => {
  const qText = `${index + 1}. ${question.question}`;
  const qDir = directionFor(qText);

  let optionsHtml = "";
  if (question.type === "mcq" && question.options) {
    optionsHtml = (["A", "B", "C", "D"] as const)
      .map((letter) => {
        const option = question.options?.[letter];
        if (!option) return "";
        const optionText = `${letter}) ${option}`;
        const dir = directionFor(optionText);
        return `<div class="option" dir="${dir}">${escapeHtml(optionText)}</div>`;
      })
      .join("");
  } else if (question.type === "truefalse") {
    const tfText = "A) True    B) False";
    const tfDir = directionFor(tfText);
    optionsHtml = `<div class="option" dir="${tfDir}">${escapeHtml(tfText)}</div>`;
  } else {
    const answerLine = t(lang, "mytests.export.answerLine");
    const answerLineDir = directionFor(answerLine);
    optionsHtml = `<div class="answer-line" dir="${answerLineDir}">${escapeHtml(answerLine)}</div>`;
  }

  const correctAnswerHtml = includeAnswers
    ? (() => {
        const answerText = `✓ ${question.correctAnswer}`;
        const answerDir = directionFor(answerText);
        return `<div class="correct-answer" dir="${answerDir}">${escapeHtml(answerText)}</div>`;
      })()
    : "";

  return [
    `<div class="question" dir="${qDir}">`,
    `<div class="question-text">${escapeHtml(qText)}</div>`,
    optionsHtml,
    correctAnswerHtml,
    "</div>"
  ].join("");
};

const buildHtml = (test: TestDocument, lang: Language, includeAnswers: boolean, fontBase64: string): string => {
  const titleText = test.title?.trim() || t(lang, "common.untitledTest");
  const subtitleText = `${t(lang, "mytests.preview.questions", { n: test.questions.length })} • ${formatQuestionTypes(test.questions.map((q) => q.type), lang)}`;

  const titleDir = directionFor(titleText);
  const subtitleDir = directionFor(subtitleText);

  const questionsHtml = test.questions
    .map((question, index) => renderQuestionBlock(question, index, lang, includeAnswers))
    .join("\n");

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    @font-face {
      font-family: 'Noto Naskh Arabic';
      src: url(data:font/ttf;base64,${fontBase64}) format('truetype');
      font-weight: 400;
      font-style: normal;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 40px;
      color: #111;
      background: #fff;
      font-family: 'Noto Naskh Arabic', 'Arial', sans-serif;
      line-height: 1.5;
      font-size: 14px;
    }

    h1 {
      margin: 0 0 8px;
      text-align: center;
      font-size: 30px;
      font-weight: 700;
    }

    .subtitle {
      margin: 0 0 24px;
      text-align: center;
      color: #333;
      font-size: 13px;
    }

    .question {
      margin: 0 0 14px;
      page-break-inside: avoid;
    }

    .question-text {
      font-size: 16px;
      color: #000;
      margin-bottom: 6px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .option,
    .answer-line,
    .correct-answer {
      margin-inline-start: 20px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .correct-answer {
      color: #0b8f35;
      margin-top: 6px;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <h1 dir="${titleDir}">${escapeHtml(titleText)}</h1>
  <p class="subtitle" dir="${subtitleDir}">${escapeHtml(subtitleText)}</p>
  ${questionsHtml}
</body>
</html>`;
};

export async function generateTestPDF(
  test: TestDocument,
  lang: Language,
  includeAnswers: boolean
): Promise<Buffer> {
  if (!existsSync(NOTO_NASKH_ARABIC_PATH)) {
    throw new Error(`Missing required font for HTML PDF export: ${NOTO_NASKH_ARABIC_PATH}`);
  }

  const fontBase64 = readFileSync(NOTO_NASKH_ARABIC_PATH).toString("base64");
  const html = buildHtml(test, lang, includeAnswers, fontBase64);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdfBytes = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "20mm",
        right: "15mm",
        bottom: "20mm",
        left: "15mm"
      }
    });

    return Buffer.from(pdfBytes);
  } finally {
    await browser.close();
  }
}
