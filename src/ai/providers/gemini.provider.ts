import type { IAIProvider } from "../ai.interface.js";
import { config } from "../../config/index.js";
import { AppError } from "../../shared/errors/AppError.js";
import { AIError } from "../../shared/errors/AIError.js";
import { logger } from "../../shared/logger.js";
import type { GenerateQuestionsInput, Question } from "../../shared/types/index.js";
import { createQuestionPrompt, parseQuestionsResponse } from "./base.provider.js";

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_ROUNDS = 12;

const GEMINI_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      id: { type: "STRING" },
      type: { type: "STRING", enum: ["mcq", "truefalse", "short", "fill"] },
      question: { type: "STRING" },
      options: {
        type: "OBJECT",
        properties: {
          A: { type: "STRING" },
          B: { type: "STRING" },
          C: { type: "STRING" },
          D: { type: "STRING" }
        }
      },
      correctAnswer: { type: "STRING" },
      explanation: { type: "STRING" }
    },
    required: ["id", "type", "question", "correctAnswer"]
  }
};

function repairTruncatedJSON(raw: string): string {
  // Strip markdown blocks if present so we work on the raw JSON content
  let text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  
  if (text.endsWith("]")) return text;

  // Find the last complete object end
  // We look for a } that is followed by a comma and possibly another object start, 
  // or just the last } in the string.
  const lastBracket = text.lastIndexOf("}");
  if (lastBracket === -1) return text;

  // Truncate to the last } and close the array
  // We also need to handle the case where the truncation happened between objects: [{}, {
  const lastObjectEnd = text.slice(0, lastBracket + 1);
  
  // If the last thing is a comma, remove it
  let repaired = lastObjectEnd.trim();
  if (repaired.endsWith(",")) {
    repaired = repaired.slice(0, -1).trim();
  }

  // Ensure it starts with [ and ends with ]
  if (!repaired.startsWith("[")) repaired = "[" + repaired;
  if (!repaired.endsWith("]")) repaired = repaired + "]";

  return repaired;
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
    logger.info("Gemini request started", {
      event: "ai.provider.request",
      provider: "gemini",
      model: config.GEMINI_MODEL,
      questionCount: input.questionCount,
      contentType: input.content.type
    });
    const merged: Question[] = [];
    let rounds = 0;
    let remaining = input.questionCount;

    while (remaining > 0 && rounds < MAX_BATCH_ROUNDS) {
      const batchCount = this.pickBatchCount(input.questionCount, remaining, rounds);
      try {
        const batchQuestions = await this.generateBatchWithRetry(this.withQuestionCount(input, batchCount), rounds + 1);
        if (batchQuestions.length === 0) {
          logger.warn("Gemini batch returned no questions", {
            event: "ai.provider.batch.empty",
            provider: "gemini",
            round: rounds + 1,
            requested: batchCount,
            remaining
          });
          break;
        }

        const needed = input.questionCount - merged.length;
        merged.push(...batchQuestions.slice(0, needed));
        remaining = input.questionCount - merged.length;

        // Pace batch traffic to reduce Gemini "high demand" rejections.
        if (remaining > 0 && rounds + 1 < MAX_BATCH_ROUNDS) {
          const baseDelayMs = 1500 + Math.floor(Math.random() * 501); // 1500-2000
          const jitterMs = Math.floor(Math.random() * 501); // 0-500
          const interBatchDelayMs = baseDelayMs + jitterMs; // 1500-2500
          logger.info("Waiting before next Gemini batch", {
            event: "ai.provider.batch.delay",
            provider: "gemini",
            round: rounds + 1,
            remaining,
            delayMs: interBatchDelayMs
          });
          await new Promise<void>((resolve) => setTimeout(resolve, interBatchDelayMs));
        }
      } catch (error) {
        if (merged.length === 0) {
          throw error;
        }
        logger.warn("Gemini batch failed after partial success; returning partial result", {
          event: "ai.provider.batch.failed_partial",
          provider: "gemini",
          round: rounds + 1,
          remaining,
          error: error instanceof Error ? error.message : String(error)
        });
        break;
      }
      rounds += 1;
    }

    const normalized = this.ensureUniqueIds(merged).slice(0, input.questionCount);
    if (normalized.length < input.questionCount) {
      logger.warn("Gemini returned fewer questions than requested after batching", {
        event: "ai.provider.partial_result",
        provider: "gemini",
        requested: input.questionCount,
        received: normalized.length
      });
    }
    return normalized;
  }

  private async generateBatchWithRetry(input: GenerateQuestionsInput, round: number): Promise<Question[]> {
    const requestCounts = this.buildAdaptiveRequestCounts(input.questionCount);
    let lastError: unknown;

    for (const [attemptIndex, requestedCount] of requestCounts.entries()) {
      if (attemptIndex > 0) {
        const jitterMs = Math.floor(Math.random() * 501); // 0-500
        const backoffMs = Math.min(1000 * 2 ** attemptIndex + jitterMs, 15000);
        logger.info("Backing off before Gemini batch retry", {
          event: "ai.provider.batch.backoff",
          provider: "gemini",
          round,
          attemptIndex,
          delayMs: backoffMs
        });
        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
      }

      const batchInput = this.withQuestionCount(input, requestedCount);
      try {
        const questions = await this.generateBatchOnce(batchInput, round, requestedCount);
        if (questions.length === 0) continue;
        return questions;
      } catch (error) {
        lastError = error;
        logger.warn("Gemini batch attempt failed", {
          event: "ai.provider.batch.retry",
          provider: "gemini",
          round,
          requestedCount,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (lastError) throw lastError;
    return [];
  }

  private async generateBatchOnce(
    input: GenerateQuestionsInput,
    round: number,
    requestedCount: number
  ): Promise<Question[]> {
    const startedAt = Date.now();
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
                text: `${createQuestionPrompt(input)}\nImportant: Output a single valid JSON array only. Ensure each question is complete before starting the next question.`
              }
            ]
          },
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
            responseSchema: GEMINI_RESPONSE_SCHEMA
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

    logger.info("Gemini batch response received", {
      event: "ai.provider.response",
      provider: "gemini",
      model: config.GEMINI_MODEL,
      round,
      requestedCount,
      durationMs: Date.now() - startedAt,
      rawLength: text.length
    });

    try {
      const questions = parseQuestionsResponse(text);
      if (questions.length < requestedCount) {
        logger.warn("Gemini batch returned fewer questions than requested", {
          event: "ai.provider.batch.partial",
          provider: "gemini",
          round,
          requested: requestedCount,
          received: questions.length
        });
      }
      return questions;
    } catch (error) {
      logger.warn("Attempting to repair truncated Gemini JSON response", {
        event: "ai.provider.parse.repair_attempt",
        provider: "gemini",
        round,
        requestedCount
      });

      const repairedText = repairTruncatedJSON(text);
      try {
        const repairedQuestions = parseQuestionsResponse(repairedText);
        if (repairedQuestions.length < requestedCount) {
          logger.warn("Gemini batch returned fewer questions than requested after repair", {
            event: "ai.provider.batch.partial_after_repair",
            provider: "gemini",
            round,
            requested: requestedCount,
            received: repairedQuestions.length
          });
        }
        return repairedQuestions;
      } catch (repairError) {
        logger.error("Gemini parse failed even after repair", {
          event: "ai.provider.parse.failed",
          provider: "gemini",
          round,
          raw: text.slice(0, 200)
        });
        throw repairError;
      }
    }
  }

  private pickBatchCount(total: number, remaining: number, round: number): number {
    if (total <= 15 && round === 0) {
      return remaining;
    }
    return Math.min(DEFAULT_BATCH_SIZE, remaining);
  }

  private buildAdaptiveRequestCounts(requestedCount: number): number[] {
    const candidates = [
      requestedCount,
      requestedCount > 8 ? Math.max(5, requestedCount - 5) : requestedCount,
      requestedCount > 6 ? Math.max(4, Math.ceil(requestedCount * 0.7)) : requestedCount
    ];

    return [...new Set(candidates)].filter((value) => value > 0);
  }

  private withQuestionCount(input: GenerateQuestionsInput, questionCount: number): GenerateQuestionsInput {
    if (input.content.type === "text") {
      return {
        content: { type: "text", text: input.content.text },
        questionCount,
        questionTypes: input.questionTypes
      };
    }

    if (input.content.type === "pdf") {
      return {
        content: { type: "pdf", base64: input.content.base64 },
        questionCount,
        questionTypes: input.questionTypes
      };
    }

    return {
      content: { type: "images", images: input.content.images },
      questionCount,
      questionTypes: input.questionTypes
    };
  }

  private ensureUniqueIds(questions: Question[]): Question[] {
    const seen = new Set<string>();
    return questions.map((question, index) => {
      let id = question.id && question.id.trim() ? question.id : `gq_${index}_${Date.now()}`;
      if (seen.has(id)) {
        let suffix = 1;
        while (seen.has(`${id}_${suffix}`)) suffix += 1;
        id = `${id}_${suffix}`;
      }
      seen.add(id);
      return id === question.id ? question : { ...question, id };
    });
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
