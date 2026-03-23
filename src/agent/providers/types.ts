import type { LLMProvider, Decision, DecisionOptions } from '../../types.js';

export type { LLMProvider, Decision, DecisionOptions };

/**
 * Configuration for creating an LLM provider.
 */
export interface LLMProviderConfig {
  /** Provider type */
  type: 'openai' | 'ollama' | 'anthropic' | 'custom';
  /** Model name (e.g. "gpt-4o-mini", "llama3.1") */
  model: string;
  /** API key (for cloud providers) */
  apiKey?: string;
  /** Base URL override */
  baseUrl?: string;
  /** Default temperature for decisions */
  temperature?: number;
  /** Default max tokens */
  maxTokens?: number;
}

/**
 * Create an LLM provider from config.
 */
export async function createProvider(config: LLMProviderConfig): Promise<LLMProvider> {
  switch (config.type) {
    case 'openai': {
      const { OpenAIProvider } = await import('./OpenAIProvider.js');
      return new OpenAIProvider(config);
    }
    case 'ollama': {
      const { OllamaProvider } = await import('./OllamaProvider.js');
      return new OllamaProvider(config);
    }
    case 'anthropic': {
      const { AnthropicProvider } = await import('./AnthropicProvider.js');
      return new AnthropicProvider(config);
    }
    default:
      throw new Error(`Unknown provider type: ${config.type}. Use 'openai', 'ollama', or 'anthropic'.`);
  }
}
