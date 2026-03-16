import type { IAIProvider } from "../ai.interface.js";
import { config } from "../../config/index.js";
import { AppError } from "../../shared/errors/AppError.js";
import { AIError } from "../../shared/errors/AIError.js";
import { logger } from "../../shared/logger.js";
import type { GenerateQuestionsInput, Question } from "../../shared/types/index.js";
import { createQuestionPrompt, parseQuestionsResponse } from "./base.provider.js";

type ClaudeResponse = {
  content?: Array<{
    type: string;
    text?: string;
  }>;
  error?: {
    message?: string;
  };
};

export class ClaudeProvider implements IAIProvider {
  async generateQuestions(input: GenerateQuestionsInput): Promise<Question[]> {
    const startedAt = Date.now();
    logger.info("Claude request started", {
      event: "ai.provider.request",
      provider: "claude",
      model: config.CLAUDE_MODEL,
      questionCount: input.questionCount,
      contentType: input.content.type
    });
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), config.AI_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": config.CLAUDE_API_KEY!,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: config.CLAUDE_MODEL!,
          max_tokens: 4096,
          system: createQuestionPrompt(input),
          messages: [
            {
              role: "user",
              content: this.buildContentBlocks(input)
            }
          ]
        })
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new AIError("Claude request timed out", { timeoutMs: config.AI_TIMEOUT_MS }, false);
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }

    const payload = (await response.json()) as ClaudeResponse;

    if (!response.ok) {
      throw new AppError(payload.error?.message ?? "Claude request failed", response.status, payload);
    }

    const text = payload.content?.find((block) => block.type === "text")?.text;
    if (!text) {
      throw new AppError("Claude response did not include text content", 502, payload);
    }

    logger.info("Claude response received", {
      event: "ai.provider.response",
      provider: "claude",
      model: config.CLAUDE_MODEL,
      durationMs: Date.now() - startedAt,
      rawLength: text.length
    });

    try {
      return parseQuestionsResponse(text);
    } catch (error) {
      logger.error("Claude parse failed", {
        event: "ai.provider.parse.failed",
        provider: "claude",
        raw: text.slice(0, 200)
      });
      throw error;
    }
  }

  private buildContentBlocks(input: GenerateQuestionsInput): Array<Record<string, unknown>> {
    if (input.content.type === "text") {
      return [
        {
          type: "text",
          text: input.content.text
        }
      ];
    }

    if (input.content.type === "pdf") {
      return [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: input.content.base64
          }
        }
      ];
    }

    return input.content.images.map((image) => ({
      type: "image",
      source: {
        type: "base64",
        // Use the actual MIME type recorded at upload time instead of a hard-coded "image/png".
        media_type: image.mimeType,
        data: image.base64
      }
    }));
  }
}
