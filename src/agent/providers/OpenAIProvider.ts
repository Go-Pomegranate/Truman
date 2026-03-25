import type { Decision, DecisionOptions, LLMProvider } from "../../types.js";
import type { LLMProviderConfig } from "./types.js";

export class OpenAIProvider implements LLMProvider {
	name = "openai";
	private model: string;
	private apiKey: string;
	private baseUrl: string;
	private defaultTemp: number;
	private defaultMaxTokens: number;

	constructor(config: LLMProviderConfig) {
		this.model = config.model || "gpt-4o-mini";
		this.apiKey = config.apiKey || process.env.OPENAI_API_KEY || "";
		this.baseUrl = config.baseUrl || "https://api.openai.com/v1";
		this.defaultTemp = config.temperature ?? 0.7;
		this.defaultMaxTokens = config.maxTokens ?? 1000;

		if (!this.apiKey) {
			throw new Error("OpenAI API key required. Set OPENAI_API_KEY or pass apiKey in config.");
		}
	}

	async decide(prompt: string, options?: DecisionOptions): Promise<Decision> {
		// Build user message — multimodal if screenshot provided
		let userContent: any = prompt;
		if (options?.screenshot) {
			userContent = [
				{
					type: "text",
					text: prompt,
				},
				{
					type: "image_url",
					image_url: {
						url: `data:image/jpeg;base64,${options.screenshot}`,
						detail: "low",
					},
				},
			];
		}

		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: this.model,
				messages: [
					{
						role: "system",
						content: `You are a persona simulator. You role-play as a specific person using an app. Always respond with valid JSON matching the requested format. Stay in character. Be realistic, not robotic.${
							options?.screenshot
								? " You can see a screenshot of the current page — use it to understand the layout and UI."
								: ""
						}`,
					},
					{ role: "user", content: userContent },
				],
				temperature: options?.temperature ?? this.defaultTemp,
				max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
				response_format: { type: "json_object" },
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
		}

		const data = (await response.json()) as {
			choices: { message: { content: string } }[];
		};

		const content = data.choices[0]?.message?.content;
		if (!content) throw new Error("Empty response from OpenAI");

		return this.parseDecision(content);
	}

	private parseDecision(raw: string): Decision {
		const parsed = JSON.parse(raw) as Partial<Decision>;

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
