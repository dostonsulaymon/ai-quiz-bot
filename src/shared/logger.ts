type LogLevel = "debug" | "info" | "warn" | "error";

type LogMeta = {
  userId?: number | string;
  message: string;
  [key: string]: unknown;
};

const writeLog = (level: LogLevel, meta: LogMeta): void => {
  if (level === "debug" && process.env.NODE_ENV !== "development") {
    return;
  }

  const payload = {
    timestamp: new Date().toISOString(),
    level,
    ...meta
  };

  const line = JSON.stringify(payload);

  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
      break;
  }
};

export const logger = {
  debug: (message: string, meta: Omit<LogMeta, "message"> = {}) => {
    writeLog("debug", { message, ...meta });
  },
  info: (message: string, meta: Omit<LogMeta, "message"> = {}) => {
    writeLog("info", { message, ...meta });
  },
  warn: (message: string, meta: Omit<LogMeta, "message"> = {}) => {
    writeLog("warn", { message, ...meta });
  },
  error: (message: string, meta: Omit<LogMeta, "message"> = {}) => {
    writeLog("error", { message, ...meta });
  }
};
