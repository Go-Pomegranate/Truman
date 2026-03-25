import type { Decision, DecisionOptions, LLMProvider } from "../../types.js";
import type { LLMProviderConfig } from "./types.js";

/**
 * Anthropic Claude provider.
 * Uses the Messages API directly via fetch (no SDK dependency).
 */
export class AnthropicProvider implements LLMProvider {
	name = "anthropic";
	private model: string;
	private apiKey: string;
	private baseUrl: string;
	private defaultTemp: number;
	private defaultMaxTokens: number;

	constructor(config: LLMProviderConfig) {
		this.model = config.model || "claude-haiku-4-5-20251001";
		this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY || "";
		this.baseUrl = config.baseUrl || "https://api.anthropic.com";
		this.defaultTemp = config.temperature ?? 0.7;
		this.defaultMaxTokens = config.maxTokens ?? 1000;

		if (!this.apiKey) {
			throw new Error("Anthropic API key required. Set ANTHROPIC_API_KEY or pass apiKey in config.");
		}
	}

	async decide(prompt: string, options?: DecisionOptions): Promise<Decision> {
		const response = await fetch(`${this.baseUrl}/v1/messages`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": this.apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: this.model,
				max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
				temperature: options?.temperature ?? this.defaultTemp,
				system:
					"You are a persona simulator. You role-play as a specific person using an app. " +
					"Always respond with valid JSON matching the requested format. " +
					"Stay in character. Be realistic, not robotic. Output ONLY valid JSON, no markdown.",
				messages: [{ role: "user", content: prompt }],
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
		}

		const data = (await response.json()) as {
			content: { type: string; text: string }[];
		};

		const text = data.content.find((c) => c.type === "text")?.text;
		if (!text) throw new Error("Empty response from Anthropic");

		return this.parseDecision(text);
	}

	private parseDecision(raw: string): Decision {
		// Strip markdown code fences if present
		const cleaned = raw
			.replace(/^```(?:json)?\s*\n?/m, "")
			.replace(/\n?```\s*$/m, "")
			.trim();
		const parsed = JSON.parse(cleaned) as Partial<Decision>;

		return {
			action: parsed.action ?? "none",
			goal: parsed.goal,
			reasoning: parsed.reasoning ?? "",
			thought: parsed.thought,
			params: parsed.params ?? {},
			mood: parsed.mood,
			frustration: Math.min(1, Math.max(0, parsed.frustration ?? 0)),
			wantsToContinue: parsed.wantsToContinue ?? true,
		};
	}
}
