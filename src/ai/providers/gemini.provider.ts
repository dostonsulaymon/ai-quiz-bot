import type { IAIProvider } from "../ai.interface.js";
import { config } from "../../config/index.js";
import { AppError } from "../../shared/errors/AppError.js";
import { AIError } from "../../shared/errors/AIError.js";
import { logger } from "../../shared/logger.js";
import type { GenerateQuestionsInput, Question } from "../../shared/types/index.js";
import { createQuestionPrompt, parseQuestionsResponse } from "./base.provider.js";

function repairTruncatedJSON(raw: string): string {
  // Find the last complete question object by finding the last }]
  // or last complete }, { pattern
  const lastCompleteIndex = raw.lastIndexOf("},");
  if (lastCompleteIndex === -1) return raw;
  // Close the array with the last complete object
  return raw.slice(0, lastCompleteIndex + 1) + "]";
}

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
};

export class GeminiProvider implements IAIProvider {
  async generateQuestions(input: GenerateQuestionsInput): Promise<Question[]> {
    const startedAt = Date.now();
    logger.info("Gemini request started", {
      event: "ai.provider.request",
      provider: "gemini",
      model: config.GEMINI_MODEL,
      questionCount: input.questionCount,
      contentType: input.content.type
    });
    const url = new URL(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.GEMINI_MODEL!}:generateContent`
    );

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), config.AI_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": config.GEMINI_API_KEY!
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: this.buildParts(input)
            }
          ],
          systemInstruction: {
            parts: [
              {
                text: `${createQuestionPrompt(input)}\nImportant: Ensure each question is complete before starting the next. It is better to return fewer complete questions than many incomplete ones.`
              }
            ]
          },
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 8192
          }
        })
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new AIError("Gemini request timed out", {
          code: "TIMEOUT",
          details: { timeoutMs: config.AI_TIMEOUT_MS }
        });
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }

    const payload = (await response.json()) as GeminiResponse;

    if (!response.ok) {
      if (response.status === 429) {
        throw new AIError("Gemini rate limit reached", {
          code: "RATE_LIMIT",
          details: payload
        });
      }
      throw new AppError(payload.error?.message ?? "Gemini request failed", response.status, payload);
    }

    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    if (!text) {
      throw new AppError("Gemini response did not include text content", 502, payload);
    }

    logger.info("Gemini response received", {
      event: "ai.provider.response",
      provider: "gemini",
      model: config.GEMINI_MODEL,
      durationMs: Date.now() - startedAt,
      rawLength: text.length
    });

    try {
      const questions = parseQuestionsResponse(text);
      if (questions.length < input.questionCount) {
        logger.warn("Gemini returned fewer questions than requested — using partial result", {
          requested: input.questionCount,
          received: questions.length
        });
      }
      return questions;
    } catch (error) {
      logger.warn("Attempting to repair truncated JSON response", {
        event: "ai.provider.parse.repair_attempt",
        provider: "gemini"
      });
      
      const repairedText = repairTruncatedJSON(text);
      try {
        const repairedQuestions = parseQuestionsResponse(repairedText);
        if (repairedQuestions.length < input.questionCount) {
          logger.warn("Gemini returned fewer questions than requested after repair — using partial result", {
            requested: input.questionCount,
            received: repairedQuestions.length
          });
        }
        return repairedQuestions;
      } catch (repairError) {
        logger.error("Gemini parse failed even after repair", {
          event: "ai.provider.parse.failed",
          provider: "gemini",
          raw: text.slice(0, 200)
        });
        throw repairError;
      }
    }
  }

  private buildParts(input: GenerateQuestionsInput): Array<Record<string, unknown>> {
    if (input.content.type === "text") {
      return [
        {
          text: input.content.text
        }
      ];
    }

    if (input.content.type === "pdf") {
      return [
        {
          inline_data: {
            mime_type: "application/pdf",
            data: input.content.base64
          }
        }
      ];
    }

    return input.content.images.map((image) => ({
      inline_data: {
        // Use the actual MIME type recorded at upload time instead of a hard-coded "image/png".
        mime_type: image.mimeType,
        data: image.base64
      }
    }));
  }
}
