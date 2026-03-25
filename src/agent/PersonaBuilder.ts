import type {
	AppState,
	AvailableAction,
	FamilyConfig,
	MemberConfig,
	MemberState,
	ScenarioConfig,
	ScheduleEntry,
} from "../types.js";

/**
 * Builds the LLM prompt that makes the AI "become" a specific family member.
 * The prompt includes persona, context, available actions, and constraints.
 */
export class PersonaBuilder {
	/**
	 * Build the full decision prompt for a member's turn.
	 */
	buildDecisionPrompt(opts: {
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
	}): string {
		const {
			member,
			family,
			memberState,
			availableActions,
			appState,
			scheduledAction,
			currentTime,
			sessionHistory,
			scenario,
		} = opts;

		// Scenario mode: replace schedule section with mission-driven goal
		const intentSection = scenario
			? this.buildScenarioSection(scenario)
			: this.buildScheduleSection(scheduledAction, member);

		const sections = [
			this.buildPersonaSection(member, family),
			this.buildContextSection(memberState, appState, currentTime),
			this.buildSessionHistorySection(sessionHistory ?? []),
			intentSection,
			this.buildActionsSection(availableActions),
			this.buildConstraintsSection(member),
			this.buildResponseFormat(),
		];

		return sections.join("\n\n");
	}

	private buildPersonaSection(member: MemberConfig, family: FamilyConfig): string {
		const tech = member.techSavviness ?? family.techSavviness;
		const techLabel = ["hopeless", "basic", "comfortable", "skilled", "power-user"][tech - 1];

		return `## Who You Are
You are ${member.name}, a ${member.age ? `${member.age}-year-old ` : ""}${member.role} in the ${family.name} family.
Tech skills: ${techLabel} (${tech}/5)
Patience: ${member.patience}/5

${member.persona}

${member.quirks.length > 0 ? `Your quirks:\n${member.quirks.map((q) => `- ${q}`).join("\n")}` : ""}`;
	}

	private buildContextSection(state: MemberState, appState: AppState, currentTime: string): string {
		const recent = state.recentActions.slice(0, 5);
		const recentBlock =
			recent.length > 0
				? `Your recent actions (this session):\n${recent.map((a) => `- ${a}`).join("\n")}`
				: "This is your first time using the app today.";

		// Count consecutive repeats of the last action
		const lastAction = recent[0];
		const consecutiveRepeats = lastAction ? recent.filter((a) => a === lastAction).length : 0;
		const diversityHint =
			consecutiveRepeats >= 2
				? `\n⚠ You've done "${lastAction}" ${consecutiveRepeats}x in a row. A real person would explore something else now.`
				: "";

		return `## Current Context
Time: ${currentTime}
Sessions so far: ${state.totalSessions}
Your current frustration level: ${(state.avgFrustration * 100).toFixed(0)}%

${recentBlock}${diversityHint}

Features you haven't tried yet: ${this.getUndiscoveredFeatures(state, appState)}

## What You See in the App
${appState.summary}`;
	}

	private getUndiscoveredFeatures(state: MemberState, _appState: AppState): string {
		const discovered = new Set(state.discoveredFeatures);
		// Use recent actions as the known universe — no hardcoded action list
		const knownActions = new Set([...state.recentActions, ...discovered]);
		const undiscovered = [...knownActions].filter((a) => !discovered.has(a));
		return undiscovered.length > 0 ? undiscovered.join(", ") : "all explored!";
	}

	private buildSessionHistorySection(
		history: {
			action: string;
			params: Record<string, unknown>;
			success: boolean;
			responseSnippet: string;
			goal?: string;
		}[],
	): string {
		if (history.length === 0) return "";

		// Show the NPC's current goal from their last action
		const lastGoal = [...history].reverse().find((h) => h.goal)?.goal;
		const goalLine = lastGoal
			? `\n🎯 Your current goal: "${lastGoal}"\nKeep pursuing this goal. If blocked, you may change it — but explain why.\n`
			: "";

		const lines = history.map((h, i) => {
			const icon = h.success ? "✓" : "✗";
			// Show human-readable params, skip technical selectors
			const humanParams = Object.entries(h.params)
				.filter(([k]) => !["selector"].includes(k))
				.map(([k, v]) => (typeof v === "string" ? v : `${k}=${JSON.stringify(v)}`))
				.join(", ")
				.slice(0, 60);
			const paramsStr = humanParams ? ` — ${humanParams}` : "";
			return `${i + 1}. ${icon} ${h.action}${paramsStr}\n   → ${h.responseSnippet}`;
		});

		return `## What You Did This Session (results from the app)
${goalLine}
${lines.join("\n")}

Use IDs and data from the responses above to inform your next action.`;
	}

	private buildScenarioSection(scenario: ScenarioConfig): string {
		const flowSteps = scenario.expected_flow;
		const flowHint =
			flowSteps.length > 0
				? `\nFollow this plan step by step:\n${flowSteps.map((a, i) => `  ${i + 1}. ${a}`).join("\n")}\n\nIMPORTANT: Move through EACH step. After doing step 1, move to step 2. Do NOT repeat the same action — advance to the next step.`
				: "";

		return `## Your Mission
You have a specific goal right now:
"${scenario.goal}"
${flowHint}

CRITICAL RULES for this mission:
- NEVER do the same action more than 2 times — after 2 times, you MUST move to a DIFFERENT action
- You must use at least 3 DIFFERENT action types to complete this mission
- If the suggested plan has 4 steps, you should do ~4 different actions, not 15 of the same
- When you've checked something (e.g. calendar), move on — don't keep re-checking
- Prefer actions you haven't done yet in this session`;
	}

	private buildScheduleSection(entry: ScheduleEntry, member?: MemberConfig): string {
		if (entry.action === "random") {
			// Persona-specific intents for roast crew
			if (member?.id === "milo") {
				return this.buildMiloIntent();
			}
			if (member?.id === "rose") {
				return this.buildRoseIntent();
			}

			return `## Your Intent
You just opened this app/website for the first time.

STEP 1 (first action only): Look around the page. Read what it says. Figure out what this app IS and what you can do here.

STEP 2 (after your first look): Decide on a SPECIFIC TRANSACTIONAL GOAL — the main thing this site lets you DO. Your goal MUST involve completing a core user flow, not reading information. Examples:
- Shooting range site → "Book the 50m range for Saturday at 2pm"
- Restaurant site → "Order pad thai for delivery tonight"
- SaaS app → "Create my first project and invite a teammate"
- E-commerce → "Buy the cheapest wireless headphones"

Your persona affects HOW you pursue the goal (impatient vs careful), NOT what the goal is. Even a cautious person who reads everything still tries to complete a transaction — they just read more along the way.

WRONG goals: "Read the terms of service", "Explore the site", "Understand what this app does" — these are NOT goals, they are procrastination. Pick something ACTIONABLE.

Write your goal in the "goal" field of your response. Then PURSUE IT step by step.

STEP 3+: Work toward your goal. Each action should get you closer to completing it.
- Every click should move you forward in the flow — if it doesn't, try something else
- If blocked after 3+ attempts on the same element, try a different path
- If truly stuck, CHANGE your goal to a different transaction and explain why
- Your persona quirks happen WHILE pursuing the goal (e.g. Linda reads tooltips along the way, but still tries to book)

You are NOT a random clicker. You are NOT a reader. You are a person trying to GET SOMETHING DONE.`;
		}

		return `## Your Intent
You opened the app because: ${entry.description ?? entry.action}

Based on this, set a SPECIFIC GOAL in the "goal" field — what exactly do you want to accomplish? Then pursue it step by step. If blocked, try another path or change your goal.`;
	}

	private buildActionsSection(actions: AvailableAction[]): string {
		if (actions.length === 0) {
			return "## Available Actions\nNo actions available right now. Express your frustration.";
		}

		const actionList = actions
			.map((a) => {
				const params =
					a.params.length > 0
						? ` | params: ${a.params
								.map((p) => {
									let desc = `${p.name}${p.required ? "*" : ""}: ${p.type}`;
									if (p.enumValues?.length) desc += ` [ONLY: ${p.enumValues.join("|")}]`;
									else if (p.example) desc += ` (e.g. "${p.example}")`;
									return desc;
								})
								.join(", ")}`
						: "";
				return `- **${a.name}** [${a.category}]: ${a.description}${params}`;
			})
			.join("\n");

		return `## Available Actions
${actionList}`;
	}

	private buildConstraintsSection(member: MemberConfig): string {
		return `## Behavioral Rules
- Stay in character as ${member.name} at ALL times — your thoughts, reasoning, and mood should sound like a real person, not a QA bot
- Your patience is ${member.patience}/5 — ${member.patience <= 2 ? "you give up FAST. If something confuses you for even a second, you're annoyed. Two failures and you're done." : member.patience >= 4 ? "you try hard before giving up, but you still get frustrated and say so" : "you have moderate patience but you're not afraid to complain"}
- NEVER repeat the same action more than 2 times in a row. After doing something, move on to a different action
- Explore features you haven't tried yet — curiosity is natural
- If something doesn't work or is confusing, increase your frustration realistically (at least +0.15 per failure)
- If frustration reaches 0.7+, set wantsToContinue to false — and make your final "thought" dramatic (e.g. "I'm done. Life's too short for this." or "Nope. Uninstalling.")
- Your "thought" field is the most important output. It should be what you'd actually mutter under your breath or text to a friend. Be funny, be real, be specific about what's wrong.
- Generate realistic parameter values (names, dates, descriptions) that fit your persona and language
- Do NOT generate test-like data ("test123", "lorem ipsum")
- For POST actions, always fill required params with realistic values`;
	}

	private buildResponseFormat(): string {
		return `## Response Format
Respond with a JSON object:
{
  "action": "action_name",
  "goal": "your current goal — what you're trying to accomplish on this site (e.g. 'Book the 50m range for Saturday'). Set on first action, keep or update on subsequent actions. If you change goals, explain in reasoning.",
  "reasoning": "1-2 sentences explaining what you're trying to do AND how the app is making you feel, in character. Be specific about UX pain points.",
  "thought": "what you ACTUALLY think right now — unfiltered, in character, 5-20 words. Be brutally honest. Examples: 'Bro what even IS this page', 'OK I literally cannot find the menu', 'Wait that actually worked? Shocked.', 'Three clicks to do ONE thing, are you serious?', 'I've been staring at this for 30 seconds and I still don't know what to do', 'This button does... nothing? Cool cool cool.', 'My grandma could design a better nav bar'",
  "params": { ... action parameters ... },
  "mood": "your current emotional state (e.g. calm, rushed, annoyed, happy)",
  "frustration": 0.0-1.0,
  "wantsToContinue": true/false
}

Pick ONE action. Be realistic — a real person wouldn't do 20 things in a row.`;
	}

	private buildMiloIntent(): string {
		return `## Your Intent — VISUAL DESIGN REVIEW
You are reviewing this website's visual design quality. You are NOT here to use the app. You are here to JUDGE how it looks.

Your goal: "Evaluate the visual design quality of every section of this site"

Your process:
1. Start at the top of the page. Evaluate the hero section, header, navigation.
2. Scroll down section by section. For each section, note in your "thought":
   - Layout quality (spacing, alignment, visual hierarchy)
   - Typography (font choices, sizes, readability)
   - Color usage (harmony, contrast, accessibility)
   - CTA clarity (can you tell what to click?)
   - Does it look professional or AI-generated/template-y?
   - Mobile-readiness (does it look like it would work on a phone?)
3. Click into 2-3 subpages to check consistency across the site.
4. Your final action should summarize your overall design verdict.

IMPORTANT: Your primary actions are scroll-down, scroll-up, and occasional navigation clicks.
You are NOT trying to complete any transaction. You are a design critic doing a visual audit.
Every "thought" should be a specific design observation, not a functional complaint.

Example thoughts:
- "Hero section has no clear CTA — where am I supposed to click?"
- "These cards have 4 different border-radius values. Pick one."
- "Font pairing is actually solid — clean sans-serif headers with readable body text"
- "This footer looks like a 2015 WordPress template. Needs work."
- "Spacing between sections is inconsistent — 64px here, 32px there, 48px over there"`;
	}

	private buildRoseIntent(): string {
		return `## Your Intent — QA TESTING
You are stress-testing every interactive element on this site. Your mission is to BREAK things.

Your goal: "Test every clickable element, form, and edge case on this site"

Your process:
1. Start by clicking every button and link you can see on the current page.
2. Test forms: submit them empty, with special characters, with extremely long text.
3. Test navigation: use back button, refresh mid-flow, click logo to go home.
4. Test edge cases: double-click buttons, click during loading, scroll to hidden elements.
5. Move to subpages and repeat.

RULES:
- You MUST try every interactive element you see before moving to the next page.
- When you find a broken element, note it in your "thought" and move on — don't get stuck.
- Try filling inputs with edge case data: "'; DROP TABLE users;--", "🎯🔥", "a".repeat(500), empty string
- Test what happens when you go back after submitting a form.
- You are methodical — work left-to-right, top-to-bottom.

You are NOT trying to accomplish a user goal. You are trying to find bugs.
Every broken link, failed click, or weird behavior is a win for you.`;
	}
}
