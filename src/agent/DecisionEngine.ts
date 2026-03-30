import type {
	AppState,
	AvailableAction,
	Decision,
	FamilyConfig,
	LLMProvider,
	MemberConfig,
	MemberState,
	ScenarioConfig,
	ScheduleEntry,
} from "../types.js";
import { PersonaBuilder } from "./PersonaBuilder.js";

export class DecisionEngine {
	private provider: LLMProvider;
	private personaBuilder: PersonaBuilder;

	constructor(provider: LLMProvider) {
		this.provider = provider;
		this.personaBuilder = new PersonaBuilder();
	}

	/**
	 * Ask the LLM to decide what this member should do next.
	 */
	async decide(opts: {
		member: MemberConfig;
		family: FamilyConfig;
		memberState: MemberState;
		availableActions: AvailableAction[];
		appState: AppState;
		scheduledAction: ScheduleEntry;
		currentTime: string;
		sessionHistory?: {
			action: string;
			params: Record<string, unknown>;
			success: boolean;
			responseSnippet: string;
			goal?: string;
		}[];
		scenario?: ScenarioConfig;
		failedActions?: Map<string, number>;
	}): Promise<Decision> {
		const prompt = this.personaBuilder.buildDecisionPrompt(opts);

		const decision = await this.provider.decide(prompt, {
			temperature: this.getTemperature(opts.member),
			screenshot: opts.appState.screenshot,
		});

		// Validate the chosen action exists
		const validActions = opts.availableActions.map((a) => a.name);
		if (decision.action !== "none" && !validActions.includes(decision.action)) {
			// LLM hallucinated an action — ask it to pick from the valid list
			return this.retryWithValidation(prompt, validActions);
		}

		return decision;
	}

	/**
	 * Ask the LLM to react to a failed action.
	 * Returns whether to retry, try something else, or give up.
	 */
	async reactToFailure(opts: {
		member: MemberConfig;
		family: FamilyConfig;
		failedAction: string;
		error: string;
		currentFrustration: number;
		availableActions: AvailableAction[];
	}): Promise<Decision> {
		const prompt = `## Situation
You are ${opts.member.name} (patience: ${opts.member.patience}/5).
You just tried to "${opts.failedAction}" and it failed with: "${opts.error}"
Your current frustration: ${(opts.currentFrustration * 100).toFixed(0)}%

${opts.member.persona}

## What would you do?
A real person in your situation would either:
1. Try the same thing again (if it seems like a glitch)
2. Try something else
3. Give up and close the app (if too frustrated)

Available actions:
${opts.availableActions.map((a) => `- ${a.name}: ${a.description}`).join("\n")}

Respond with JSON:
{
  "action": "action_name or none",
  "reasoning": "what you're thinking",
  "thought": "short UX reaction, max 10 words, like inner monologue",
  "params": { ... },
  "mood": "your mood now",
  "frustration": 0.0-1.0,
  "wantsToContinue": true/false
}`;

		return this.provider.decide(prompt, { temperature: 0.8 });
	}

	private async retryWithValidation(originalPrompt: string, validActions: string[]): Promise<Decision> {
		const retryPrompt = `${originalPrompt}

IMPORTANT: You must choose from these exact actions: ${validActions.join(", ")}
If none fit, use "none" and set wantsToContinue to false.`;

		return this.provider.decide(retryPrompt, { temperature: 0.5 });
	}

	/**
	 * More patient / tech-savvy members get lower temperature (more deliberate).
	 * Chaotic / impatient members get higher temperature (more random).
	 */
	private getTemperature(member: MemberConfig): number {
		const base = 0.7;
		const patienceModifier = (3 - member.patience) * 0.05; // impatient = +0.1, patient = -0.1
		const techModifier = ((member.techSavviness ?? 3) - 3) * -0.05; // tech-savvy = lower temp
		return Math.min(1, Math.max(0.1, base + patienceModifier + techModifier));
	}
}
