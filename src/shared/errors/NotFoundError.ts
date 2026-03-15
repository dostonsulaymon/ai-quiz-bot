import { AppError } from "./AppError.js";

export class NotFoundError extends AppError {
  constructor(message: string, code = "NOT_FOUND", details?: unknown) {
    super(message, {
      statusCode: 404,
      code,
      userMessage: message,
      isRetryable: false,
      details
    });

    this.name = "NotFoundError";
  }
}
