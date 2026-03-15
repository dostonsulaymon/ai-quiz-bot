import { AppError } from "./AppError.js";

export class ValidationError extends AppError {
  constructor(message: string, code = "VALIDATION_ERROR", details?: unknown) {
    super(message, {
      statusCode: 400,
      code,
      userMessage: message,
      isRetryable: false,
      details
    });

    this.name = "ValidationError";
  }
}
