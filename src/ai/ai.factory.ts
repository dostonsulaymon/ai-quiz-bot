import { config } from "../config/index.js";
import type { IAIProvider } from "./ai.interface.js";
import { ClaudeProvider } from "./providers/claude.provider.js";
import { GeminiProvider } from "./providers/gemini.provider.js";
import { OllamaProvider } from "./providers/ollama.provider.js";

let providerInstance: IAIProvider | null = null;

export const getAIProvider = (): IAIProvider => {
  if (providerInstance) {
    return providerInstance;
  }

  switch (config.AI_PROVIDER) {
    case "claude":
      providerInstance = new ClaudeProvider();
      break;
    case "gemini":
      providerInstance = new GeminiProvider();
      break;
    case "ollama":
      providerInstance = new OllamaProvider();
      break;
  }

  return providerInstance;
};
