import type { IAIProvider } from "../ai.interface.js";
import { config } from "../../config/index.js";
import { AppError } from "../../shared/errors/AppError.js";
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
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
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

    const payload = (await response.json()) as ClaudeResponse;

    if (!response.ok) {
      throw new AppError(payload.error?.message ?? "Claude request failed", response.status, payload);
    }

    const text = payload.content?.find((block) => block.type === "text")?.text;
    if (!text) {
      throw new AppError("Claude response did not include text content", 502, payload);
    }

    return parseQuestionsResponse(text);
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

    return input.content.base64Array.map((image) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: image
      }
    }));
  }
}
