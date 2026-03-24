import type { Decision, DecisionOptions, LLMProvider } from '../../types.js';
import type { LLMProviderConfig } from './types.js';

/**
 * Local LLM provider via Ollama.
 * Requires Ollama running locally: https://ollama.com
 */
export class OllamaProvider implements LLMProvider {
  name = 'ollama';
  private model: string;
  private baseUrl: string;
  private defaultTemp: number;

  constructor(config: LLMProviderConfig) {
    this.model = config.model || 'llama3.1';
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
    this.defaultTemp = config.temperature ?? 0.7;
  }

  async decide(prompt: string, options?: DecisionOptions): Promise<Decision> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'system',
            content:
              'You are a persona simulator. You role-play as a specific person using an app. ' +
              'Always respond with valid JSON matching the requested format. ' +
              'Stay in character. Be realistic.',
          },
          { role: 'user', content: prompt },
        ],
        format: 'json',
        stream: false,
        options: {
          temperature: options?.temperature ?? this.defaultTemp,
          num_predict: options?.maxTokens ?? 1000,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as { message: { content: string } };
    const content = data.message?.content;
    if (!content) throw new Error('Empty response from Ollama');

    return this.parseDecision(content);
  }

  private parseDecision(raw: string): Decision {
    const parsed = JSON.parse(raw) as Partial<Decision>;

    return {
      action: parsed.action ?? 'none',
      goal: parsed.goal,
      reasoning: parsed.reasoning ?? '',
      thought: parsed.thought,
      params: parsed.params ?? {},
      mood: parsed.mood,
      frustration: Math.min(1, Math.max(0, parsed.frustration ?? 0)),
      wantsToContinue: parsed.wantsToContinue ?? true,
    };
  }
}
