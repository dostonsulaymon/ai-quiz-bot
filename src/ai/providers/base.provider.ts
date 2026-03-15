import pdfParse from "pdf-parse";
import { AppError } from "../../shared/errors/AppError.js";
import type { GenerateQuestionsInput, Question, QuestionType } from "../../shared/types/index.js";

const questionSchemaDescription = `[
  {
    "id": "string",
    "type": "mcq | truefalse | short | fill",
    "question": "string",
    "options": {
      "A": "string",
      "B": "string",
      "C": "string",
      "D": "string"
    },
    "correctAnswer": "string",
    "explanation": "string"
  }
]`;

export const createQuestionPrompt = (input: GenerateQuestionsInput): string => {
  const allowedTypes = input.questionTypes.join(", ");

  return [
    "Generate quiz questions from the provided content.",
    `Return exactly ${input.questionCount} question(s).`,
    `Only use these question types: ${allowedTypes}.`,
    "Return ONLY a JSON array matching this schema:",
    questionSchemaDescription,
    "For mcq questions, include options A-D and set correctAnswer to one of A, B, C, D.",
    "For truefalse questions, set correctAnswer to True or False.",
    "For short and fill questions, set correctAnswer to the expected answer string.",
    "Each question id must be unique.",
    "Do not include markdown fences or extra commentary."
  ].join("\n");
};

export const stripMarkdownFences = (value: string): string =>
  value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

const isQuestionType = (value: unknown): value is QuestionType =>
  value === "mcq" || value === "truefalse" || value === "short" || value === "fill";

const assertQuestion = (value: unknown): value is Question => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    !isQuestionType(candidate.type) ||
    typeof candidate.question !== "string" ||
    typeof candidate.correctAnswer !== "string"
  ) {
    return false;
  }

  if (candidate.type === "mcq") {
    const options = candidate.options as Record<string, unknown> | undefined;
    if (
      !options ||
      typeof options.A !== "string" ||
      typeof options.B !== "string" ||
      typeof options.C !== "string" ||
      typeof options.D !== "string"
    ) {
      return false;
    }
  }

  if (candidate.explanation !== undefined && typeof candidate.explanation !== "string") {
    return false;
  }

  return true;
};

export const parseQuestionsResponse = (raw: string): Question[] => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stripMarkdownFences(raw));
  } catch (error) {
    throw new AppError("AI provider returned malformed JSON", 502, error);
  }

  if (!Array.isArray(parsed) || !parsed.every(assertQuestion)) {
    throw new AppError("AI provider returned an invalid question array", 502, parsed);
  }

  return parsed;
};

export const extractTextFromInput = async (input: GenerateQuestionsInput): Promise<string> => {
  if (input.content.type === "text") {
    return input.content.text;
  }

  if (input.content.type === "pdf") {
    const buffer = Buffer.from(input.content.base64, "base64");
    const parsed = await pdfParse(buffer);
    return parsed.text.trim();
  }

  throw new AppError("Image content is not supported by this provider", 400);
};
