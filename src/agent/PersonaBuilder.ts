import type {
  MemberConfig,
  FamilyConfig,
  MemberState,
  AvailableAction,
  AppState,
  ScheduleEntry,
  ScenarioConfig,
} from '../types.js';

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
    sessionHistory?: { action: string; params: Record<string, unknown>; success: boolean; responseSnippet: string }[];
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
      : this.buildScheduleSection(scheduledAction);

    const sections = [
      this.buildPersonaSection(member, family),
      this.buildContextSection(memberState, appState, currentTime),
      this.buildSessionHistorySection(sessionHistory ?? []),
      intentSection,
      this.buildActionsSection(availableActions),
      this.buildConstraintsSection(member),
      this.buildResponseFormat(),
    ];

    return sections.join('\n\n');
  }

  private buildPersonaSection(member: MemberConfig, family: FamilyConfig): string {
    const tech = member.techSavviness ?? family.techSavviness;
    const techLabel = ['hopeless', 'basic', 'comfortable', 'skilled', 'power-user'][tech - 1];

    return `## Who You Are
You are ${member.name}, a ${member.age ? `${member.age}-year-old ` : ''}${member.role} in the ${family.name} family.
Tech skills: ${techLabel} (${tech}/5)
Patience: ${member.patience}/5

${member.persona}

${member.quirks.length > 0 ? `Your quirks:\n${member.quirks.map((q) => `- ${q}`).join('\n')}` : ''}`;
  }

  private buildContextSection(state: MemberState, appState: AppState, currentTime: string): string {
    const recent = state.recentActions.slice(0, 5);
    const recentBlock =
      recent.length > 0
        ? `Your recent actions (this session):\n${recent.map((a) => `- ${a}`).join('\n')}`
        : 'This is your first time using the app today.';

    // Count consecutive repeats of the last action
    const lastAction = recent[0];
    const consecutiveRepeats = lastAction
      ? recent.filter((a) => a === lastAction).length
      : 0;
    const diversityHint = consecutiveRepeats >= 2
      ? `\n⚠ You've done "${lastAction}" ${consecutiveRepeats}x in a row. A real person would explore something else now.`
      : '';

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
    return undiscovered.length > 0 ? undiscovered.join(', ') : 'all explored!';
  }

  private buildSessionHistorySection(
    history: { action: string; params: Record<string, unknown>; success: boolean; responseSnippet: string }[],
  ): string {
    if (history.length === 0) return '';

    const lines = history.map((h, i) => {
      const icon = h.success ? '✓' : '✗';
      const paramsStr = Object.keys(h.params).length > 0
        ? ` (${Object.entries(h.params).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ').slice(0, 80)})`
        : '';
      return `${i + 1}. ${icon} ${h.action}${paramsStr}\n   → ${h.responseSnippet}`;
    });

    return `## What You Did This Session (results from the app)
${lines.join('\n')}

Use IDs and data from the responses above to inform your next action. For example, if you saw task #442, you can complete-task with taskId=442.`;
  }

  private buildScenarioSection(scenario: ScenarioConfig): string {
    const flowSteps = scenario.expected_flow;
    const flowHint = flowSteps.length > 0
      ? `\nFollow this plan step by step:\n${flowSteps.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}\n\nIMPORTANT: Move through EACH step. After doing step 1, move to step 2. Do NOT repeat the same action — advance to the next step.`
      : '';

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

  private buildScheduleSection(entry: ScheduleEntry): string {
    if (entry.action === 'random') {
      return `## Your Intent
You opened the app to browse around. Pick whatever feels natural for your persona. Try different features.`;
    }

    return `## Your Intent
You opened the app because: ${entry.description ?? entry.action}
You started with "${entry.action}" but now explore naturally — check other things, create entries, react to what you see. A real person doesn't repeat the same screen 10 times.`;
  }

  private buildActionsSection(actions: AvailableAction[]): string {
    if (actions.length === 0) {
      return '## Available Actions\nNo actions available right now. Express your frustration.';
    }

    const actionList = actions
      .map((a) => {
        const params =
          a.params.length > 0
            ? ` | params: ${a.params.map((p) => {
                let desc = `${p.name}${p.required ? '*' : ''}: ${p.type}`;
                if (p.enumValues?.length) desc += ` [ONLY: ${p.enumValues.join('|')}]`;
                else if (p.example) desc += ` (e.g. "${p.example}")`;
                return desc;
              }).join(', ')}`
            : '';
        return `- **${a.name}** [${a.category}]: ${a.description}${params}`;
      })
      .join('\n');

    return `## Available Actions
${actionList}`;
  }

  private buildConstraintsSection(member: MemberConfig): string {
    return `## Behavioral Rules
- Stay in character as ${member.name} at ALL times — your thoughts, reasoning, and mood should sound like a real person, not a QA bot
- Your patience is ${member.patience}/5 — ${member.patience <= 2 ? 'you give up FAST. If something confuses you for even a second, you\'re annoyed. Two failures and you\'re done.' : member.patience >= 4 ? 'you try hard before giving up, but you still get frustrated and say so' : 'you have moderate patience but you\'re not afraid to complain'}
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
  "reasoning": "1-2 sentences explaining what you're trying to do AND how the app is making you feel, in character. Be specific about UX pain points.",
  "thought": "what you ACTUALLY think right now — unfiltered, in character, 5-20 words. Be brutally honest. Examples: 'Bro what even IS this page', 'OK I literally cannot find the menu', 'Wait that actually worked? Shocked.', 'Three clicks to do ONE thing, are you serious?', 'I've been staring at this for 30 seconds and I still don't know what to do', 'This button does... nothing? Cool cool cool.', 'My grandma could design a better nav bar'",
  "params": { ... action parameters ... },
  "mood": "your current emotional state (e.g. calm, rushed, annoyed, happy)",
  "frustration": 0.0-1.0,
  "wantsToContinue": true/false
}

Pick ONE action. Be realistic — a real person wouldn't do 20 things in a row.`;
  }
}
