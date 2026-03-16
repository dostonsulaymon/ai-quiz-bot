import { AppError } from "./AppError.js";

type AIErrorOptions = {
  code?: string;
  userMessage?: string;
  isRetryable?: boolean;
  details?: unknown;
};

export class AIError extends AppError {
  constructor(message: string, details?: unknown, isRetryable?: boolean);
  constructor(message: string, options?: AIErrorOptions);
  constructor(
    message: string,
    detailsOrOptions: unknown = undefined,
    legacyIsRetryable = true
  ) {
    const options =
      typeof detailsOrOptions === "object" &&
      detailsOrOptions !== null &&
      ("code" in detailsOrOptions ||
        "userMessage" in detailsOrOptions ||
        "isRetryable" in detailsOrOptions ||
        "details" in detailsOrOptions)
        ? detailsOrOptions as AIErrorOptions
        : {
            details: detailsOrOptions,
            isRetryable: legacyIsRetryable
          };

    super(message, {
      statusCode: 502,
      code: options.code ?? "AI_GENERATION_FAILED",
      userMessage: options.userMessage ?? "I couldn't generate questions right now. Please try again shortly.",
      isRetryable: options.isRetryable ?? true,
      details: options.details
    });

    this.name = "AIError";
  }
}
