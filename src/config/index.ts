import dotenv from "dotenv";
import type { AIProviderType } from "../shared/types/index.js";
import { AppError } from "../shared/errors/AppError.js";

dotenv.config();

type NodeEnv = "development" | "test" | "production";

type Config = {
  BOT_TOKEN: string;
  MONGODB_URI: string;
  REDIS_URL: string;
  AI_PROVIDER: AIProviderType;
  AI_PROVIDER_ORDER: string;
  CLAUDE_API_KEY?: string;
  CLAUDE_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  OLLAMA_BASE_URL?: string;
  OLLAMA_MODEL?: string;
  NODE_ENV: NodeEnv;
  MAX_QUESTIONS_PER_TEST: number;
  MAX_FILE_SIZE_MB: number;
  RATE_LIMIT_GENERATIONS_PER_HOUR: number;
  RATE_LIMIT_DAILY_MAX: number;
  AI_TIMEOUT_MS: number;
  SESSION_TTL_SECONDS: number;
  STALE_GROUP_SESSION_TTL_MS: number;
};

const PROVIDERS = ["claude", "gemini", "ollama"] as const;
const NODE_ENVS = ["development", "test", "production"] as const;

const getEnv = (key: string, required = true): string | undefined => {
  const value = process.env[key]?.trim();

  if (required && !value) {
    throw new AppError(`Missing required environment variable: ${key}`, 500);
  }

  return value;
};

const parseNumber = (key: string): number => {
  const rawValue = getEnv(key);
  const parsed = Number(rawValue);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AppError(`Environment variable ${key} must be a positive number`, 500);
  }

  return parsed;
};

const aiProvider = getEnv("AI_PROVIDER") as AIProviderType;
if (!PROVIDERS.includes(aiProvider)) {
  throw new AppError("AI_PROVIDER must be one of: claude, gemini, ollama", 500);
}

const nodeEnv = (getEnv("NODE_ENV") ?? "development") as NodeEnv;
if (!NODE_ENVS.includes(nodeEnv)) {
  throw new AppError("NODE_ENV must be one of: development, test, production", 500);
}

const providerSpecificRequirements: Record<AIProviderType, string[]> = {
  claude: ["CLAUDE_API_KEY", "CLAUDE_MODEL"],
  gemini: ["GEMINI_API_KEY", "GEMINI_MODEL"],
  ollama: ["OLLAMA_BASE_URL", "OLLAMA_MODEL"]
};

for (const key of providerSpecificRequirements[aiProvider]) {
  getEnv(key);
}

export const config: Config = {
  BOT_TOKEN: getEnv("BOT_TOKEN")!,
  MONGODB_URI: getEnv("MONGODB_URI")!,
  REDIS_URL: getEnv("REDIS_URL")!,
  AI_PROVIDER: aiProvider,
  AI_PROVIDER_ORDER: getEnv("AI_PROVIDER_ORDER", false) ?? "claude,gemini,ollama",
  CLAUDE_API_KEY: getEnv("CLAUDE_API_KEY", false),
  CLAUDE_MODEL: getEnv("CLAUDE_MODEL", false),
  GEMINI_API_KEY: getEnv("GEMINI_API_KEY", false),
  GEMINI_MODEL: getEnv("GEMINI_MODEL", false),
  OLLAMA_BASE_URL: getEnv("OLLAMA_BASE_URL", false),
  OLLAMA_MODEL: getEnv("OLLAMA_MODEL", false),
  NODE_ENV: nodeEnv,
  MAX_QUESTIONS_PER_TEST: parseNumber("MAX_QUESTIONS_PER_TEST"),
  MAX_FILE_SIZE_MB: parseNumber("MAX_FILE_SIZE_MB"),
  RATE_LIMIT_GENERATIONS_PER_HOUR: parseNumber("RATE_LIMIT_GENERATIONS_PER_HOUR"),
  RATE_LIMIT_DAILY_MAX: parseNumber("RATE_LIMIT_DAILY_MAX"),
  AI_TIMEOUT_MS: Number(process.env.AI_TIMEOUT_MS) || 60_000,
  SESSION_TTL_SECONDS: Number(process.env.SESSION_TTL_SECONDS) || 604_800,
  STALE_GROUP_SESSION_TTL_MS: Number(process.env.STALE_GROUP_SESSION_TTL_MS) || 1_800_000
};
