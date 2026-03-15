import { AppError } from "./AppError.js";

export class AIError extends AppError {
  constructor(message: string, details?: unknown, isRetryable = true) {
    super(message, {
      statusCode: 502,
      code: "AI_GENERATION_FAILED",
      userMessage: "I couldn't generate questions right now. Please try again shortly.",
      isRetryable,
      details
    });

    this.name = "AIError";
  }
}
