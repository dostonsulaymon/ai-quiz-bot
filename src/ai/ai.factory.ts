import { config } from "../config/index.js";
import type { IAIProvider } from "./ai.interface.js";
import { ClaudeProvider } from "./providers/claude.provider.js";
import { GeminiProvider } from "./providers/gemini.provider.js";
import { OllamaProvider } from "./providers/ollama.provider.js";
import { AIError } from "../shared/errors/AIError.js";
import { logger } from "../shared/logger.js";
import type { GenerateQuestionsInput, Question } from "../shared/types/index.js";

let providerListCache: IAIProvider[] | null = null;

/** Returns all configured providers in priority order (from AI_PROVIDER_ORDER env). */
export function getAIProviders(): IAIProvider[] {
  if (providerListCache) return providerListCache;

  const order = config.AI_PROVIDER_ORDER
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const providers: IAIProvider[] = [];
  for (const name of order) {
    if (name === "claude" && config.CLAUDE_API_KEY) providers.push(new ClaudeProvider());
    else if (name === "gemini" && config.GEMINI_API_KEY) providers.push(new GeminiProvider());
    else if (name === "ollama" && config.OLLAMA_BASE_URL) providers.push(new OllamaProvider());
  }

  if (providers.length === 0) {
    throw new Error("No AI providers configured");
  }

  providerListCache = providers;
  return providers;
}

/** Returns the highest-priority configured provider. */
export const getAIProvider = (): IAIProvider => getAIProviders()[0]!;

/**
 * Attempts generation with each configured provider in priority order.
 * Calls onFallback once (before the second provider) so callers can notify
 * the user that a switch is happening.
 * Throws immediately on non-retryable AIErrors.
 */
export async function generateWithFallback(
  input: GenerateQuestionsInput,
  onFallback?: () => Promise<void>
): Promise<Question[]> {
  const providers = getAIProviders();
  let notifiedFallback = false;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i]!;

    if (i > 0 && !notifiedFallback) {
      notifiedFallback = true;
      await onFallback?.();
    }

    logger.info("AI generation attempt", {
      event: "ai.fallback.attempt",
      provider: provider.constructor.name,
      attempt: i + 1
    });

    try {
      return await provider.generateQuestions(input);
    } catch (error) {
      logger.warn("AI provider failed", {
        event: "ai.fallback.failed",
        provider: provider.constructor.name,
        error: error instanceof Error ? error.message : String(error)
      });

      if (error instanceof AIError && !error.isRetryable) {
        throw error;
      }
      // Retryable — continue to next provider
    }
  }

  throw new AIError(
    "All AI providers failed. Please try again later.",
    "ALL_PROVIDERS_FAILED",
    false
  );
}
