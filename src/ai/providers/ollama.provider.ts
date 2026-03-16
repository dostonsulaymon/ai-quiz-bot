import type { IAIProvider } from "../ai.interface.js";
import { config } from "../../config/index.js";
import { AppError } from "../../shared/errors/AppError.js";
import { AIError } from "../../shared/errors/AIError.js";
import { logger } from "../../shared/logger.js";
import type { GenerateQuestionsInput, Question } from "../../shared/types/index.js";
import { createQuestionPrompt, extractTextFromInput, parseQuestionsResponse } from "./base.provider.js";

type OllamaResponse = {
  response?: string;
  error?: string;
};

export class OllamaProvider implements IAIProvider {
  async generateQuestions(input: GenerateQuestionsInput): Promise<Question[]> {
    const startedAt = Date.now();
    logger.info("Ollama request started", {
      event: "ai.provider.request",
      provider: "ollama",
      model: config.OLLAMA_MODEL,
      questionCount: input.questionCount,
      contentType: input.content.type
    });
    const extractedText = await extractTextFromInput(input);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), config.AI_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${config.OLLAMA_BASE_URL!}/api/generate`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: config.OLLAMA_MODEL!,
          prompt: `${createQuestionPrompt(input)}\n\nContent:\n${extractedText}`,
          stream: false
        })
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new AIError("Ollama request timed out", {
          code: "TIMEOUT",
          details: { timeoutMs: config.AI_TIMEOUT_MS }
        });
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }

    const payload = (await response.json()) as OllamaResponse;

    if (!response.ok) {
      if (response.status === 429) {
        throw new AIError("Ollama rate limit reached", {
          code: "RATE_LIMIT",
          details: payload
        });
      }
      throw new AppError(payload.error ?? "Ollama request failed", response.status, payload);
    }

    if (!payload.response) {
      throw new AppError("Ollama response did not include generated text", 502, payload);
    }

    logger.info("Ollama response received", {
      event: "ai.provider.response",
      provider: "ollama",
      model: config.OLLAMA_MODEL,
      durationMs: Date.now() - startedAt,
      rawLength: payload.response.length
    });

    try {
      return parseQuestionsResponse(payload.response);
    } catch (error) {
      logger.error("Ollama parse failed", {
        event: "ai.provider.parse.failed",
        provider: "ollama",
        raw: payload.response.slice(0, 200)
      });
      throw error;
    }
  }
}
