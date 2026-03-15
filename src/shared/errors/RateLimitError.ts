import { AppError } from "./AppError.js";

export class RateLimitError extends AppError {
  constructor(message: string, userMessage: string, details?: unknown) {
    super(message, {
      statusCode: 429,
      code: "RATE_LIMIT_EXCEEDED",
      userMessage,
      isRetryable: true,
      details
    });

    this.name = "RateLimitError";
  }
}
