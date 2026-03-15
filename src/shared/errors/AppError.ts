type AppErrorOptions = {
  statusCode?: number;
  code?: string;
  userMessage?: string;
  isRetryable?: boolean;
  details?: unknown;
};

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly userMessage: string;
  public readonly isRetryable: boolean;
  public readonly details?: unknown;

  constructor(message: string, statusCode?: number, details?: unknown);
  constructor(message: string, options?: AppErrorOptions);
  constructor(
    message: string,
    statusCodeOrOptions: number | AppErrorOptions = {},
    legacyDetails?: unknown
  ) {
    super(message);
    this.name = "AppError";

    const options =
      typeof statusCodeOrOptions === "number"
        ? {
            statusCode: statusCodeOrOptions,
            details: legacyDetails
          }
        : statusCodeOrOptions;

    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? "APP_ERROR";
    this.userMessage =
      options.userMessage ??
      (this.statusCode >= 500 ? "Something went wrong on my side. Please try again in a moment." : message);
    this.isRetryable = options.isRetryable ?? this.statusCode >= 500;
    this.details = options.details;
  }
}
