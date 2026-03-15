import type { IAIProvider } from "../ai.interface.js";
import { config } from "../../config/index.js";
import { AppError } from "../../shared/errors/AppError.js";
import type { GenerateQuestionsInput, Question } from "../../shared/types/index.js";
import { createQuestionPrompt, parseQuestionsResponse } from "./base.provider.js";

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
    const url = new URL(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.GEMINI_MODEL!}:generateContent`
    );
    url.searchParams.set("key", config.GEMINI_API_KEY!);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json"
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
              text: createQuestionPrompt(input)
            }
          ]
        },
        generationConfig: {
          temperature: 0.2
        }
      })
    });

    const payload = (await response.json()) as GeminiResponse;

    if (!response.ok) {
      throw new AppError(payload.error?.message ?? "Gemini request failed", response.status, payload);
    }

    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    if (!text) {
      throw new AppError("Gemini response did not include text content", 502, payload);
    }

    return parseQuestionsResponse(text);
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

    return input.content.base64Array.map((image) => ({
      inline_data: {
        mime_type: "image/png",
        data: image
      }
    }));
  }
}
