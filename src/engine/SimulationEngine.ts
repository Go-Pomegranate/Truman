import { randomUUID } from "node:crypto";
import { DecisionEngine } from "../agent/DecisionEngine.js";
import { loadFamilies } from "../family/FamilyLoader.js";
import { FamilyStateManager } from "../family/FamilyState.js";
import { ActionLogger } from "../observer/ActionLogger.js";
import type {
	ActionLog,
	ActionResult,
	ChosenAction,
	EngineEvent,
	EventHandler,
	FamilyConfig,
	ScenarioConfig,
	ScenarioResult,
	SimulationConfig,
} from "../types.js";
import { DeterministicRunner } from "./DeterministicRunner.js";
import { ScenarioEvaluator, type SessionHistoryEntry } from "./ScenarioEvaluator.js";
import { type ScheduledTask, Scheduler } from "./Scheduler.js";

const DEFAULT_TICK = 60_000; // 1 minute
const DEFAULT_CONCURRENCY = 3;
const MAX_ACTIONS_PER_SESSION = 10;
const FRUSTRATION_ABORT_THRESHOLD = 0.85;

export class SimulationEngine {
	private config: SimulationConfig;
	private families: FamilyConfig[] = [];
	private stateManager: FamilyStateManager;
	private decisionEngine: DecisionEngine;
	private scheduler: Scheduler;
	private logger: ActionLogger;
	private eventHandlers: EventHandler[] = [];
	private running = false;
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private startedAt: Date = new Date();
	private scenarioEvaluator = new ScenarioEvaluator();
	private scenarioResults: ScenarioResult[] = [];

	constructor(config: SimulationConfig) {
		this.config = config;
		this.stateManager = new FamilyStateManager(config.stateDir);
		this.decisionEngine = new DecisionEngine(config.llmProvider);
		this.scheduler = new Scheduler(config.speed);
		this.logger = new ActionLogger(config.logDir);
	}

	on(handler: EventHandler): void {
		this.eventHandlers.push(handler);
	}

	async start(): Promise<void> {
		this.families = loadFamilies(this.config.families);
		this.startedAt = new Date();

		// Initialize state for all families
		for (const family of this.families) {
			this.stateManager.getState(family);
		}

		this.running = true;
		await this.emit({ type: "simulation:start", families: this.families.map((f) => f.name) });

		const tickInterval = this.config.tickInterval ?? DEFAULT_TICK;
		this.tickTimer = setInterval(() => void this.tick(), tickInterval);

		// Run first tick immediately
		await this.tick();
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}

		this.stateManager.save();
		await this.emit({ type: "simulation:stop", reason: "manual" });
	}

	async runOnce(parallel = false): Promise<void> {
		this.families = loadFamilies(this.config.families);
		this.startedAt = new Date();
		this.running = true;

		for (const family of this.families) {
			this.stateManager.getState(family);
		}

		await this.emit({ type: "simulation:start", families: this.families.map((f) => f.name) });

		if (parallel) {
			// STRESS MODE: all members + scenarios fire simultaneously
			const tasks: Promise<void>[] = [];
			for (const family of this.families) {
				for (const member of family.members) {
					const schedule = member.schedule[0];
					if (!schedule) continue;
					tasks.push(
						this.runMemberSession(family, member, schedule).catch((e) => {
							console.error(`[stress] ${member.name} crashed: ${(e as Error).message}`);
						}),
					);
				}
			}
			await Promise.all(tasks);

			// Then run scenarios (also parallel)
			const scenarioTasks: Promise<void>[] = [];
			for (const family of this.families) {
				for (const scenario of family.scenarios ?? []) {
					if (!this.shouldTriggerScenario(scenario)) continue;
					scenarioTasks.push(
						this.runScenarioSession(family, scenario).catch((e) => {
							console.error(`[stress] scenario ${scenario.id} crashed: ${(e as Error).message}`);
						}),
					);
				}
			}
			await Promise.all(scenarioTasks);
		} else {
			// SEQUENTIAL: one member at a time (default)
			for (const family of this.families) {
				for (const member of family.members) {
					const schedule = member.schedule[0];
					if (!schedule) continue;
					await this.runMemberSession(family, member, schedule);
				}
				if (family.scenarios?.length) {
					for (const scenario of family.scenarios) {
						if (!this.shouldTriggerScenario(scenario)) continue;
						await this.runScenarioSession(family, scenario);
					}
				}
			}
		}

		this.stateManager.save();
		await this.emit({ type: "simulation:stop", reason: parallel ? "stress-test complete" : "one-shot complete" });
	}

	generateReport() {
		const report = this.logger.generateReport(this.stateManager.getAllStates(), this.startedAt, this.families);
		if (this.scenarioResults.length > 0) {
			report.scenarioResults = this.scenarioResults;
		}
		return report;
	}

	getScheduler(): Scheduler {
		return this.scheduler;
	}

	// ─── Private ────────────────────────────────────────────────────

	private async tick(): Promise<void> {
		if (!this.running) return;

		const tickWindow = this.config.tickInterval ?? DEFAULT_TICK;
		const tasks = this.scheduler.getScheduledTasks(this.families, tickWindow);

		await this.emit({ type: "tick", time: this.scheduler.now().toISOString(), scheduled: tasks.length });

		if (tasks.length === 0) return;

		// Run tasks with concurrency limit
		const concurrency = this.config.concurrency ?? DEFAULT_CONCURRENCY;
		const chunks = this.chunk(tasks, concurrency);

		for (const chunk of chunks) {
			await Promise.all(chunk.map((task) => this.runScheduledTask(task)));
		}

		this.stateManager.save();
	}

	private async runScheduledTask(task: ScheduledTask): Promise<void> {
		try {
			await this.runMemberSession(task.family, task.member, task.schedule);
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			console.error(`[npc-engine] Session error for ${task.member.name}: ${error}`);
		}
	}

	private async runMemberSession(
		family: FamilyConfig,
		member: (typeof family.members)[0],
		schedule: (typeof member.schedule)[0],
	): Promise<void> {
		const sessionId = randomUUID();
		this.stateManager.startSession(family.id, member.id);

		await this.emit({
			type: "session:start",
			familyId: family.id,
			memberId: member.id,
			sessionId,
		});

		// Authenticate
		const auth = await this.config.adapter.authenticate(member, family);
		const ctx = { auth, family, member };

		let actionCount = 0;
		let sessionFrustration = 0;
		let wantsToContinue = true;
		const sessionHistory: SessionHistoryEntry[] = [];

		const maxActions = this.config.maxActionsPerSession ?? MAX_ACTIONS_PER_SESSION;
		while (wantsToContinue && actionCount < maxActions && this.running) {
			const [allActions, appState] = await Promise.all([
				this.config.adapter.getAvailableActions(ctx),
				this.config.adapter.getAppState(ctx),
			]);

			const availableActions = this.filterRepeatedActions(allActions, sessionHistory);
			const failedActions = this.buildFailedActionCounts(sessionHistory);
			const memberState = this.stateManager.getMemberState(family.id, member.id);
			let decision;
			try {
				decision = await this.decisionEngine.decide({
					member,
					family,
					memberState,
					availableActions,
					appState,
					scheduledAction: schedule,
					currentTime: this.scheduler.now().toISOString(),
					sessionHistory,
					failedActions,
				});
			} catch (err) {
				// LLM returned empty/invalid response — skip this turn, don't crash
				console.error(`  ⚠ LLM error for ${member.name}: ${err instanceof Error ? err.message : err}`);
				actionCount++;
				continue;
			}

			if (this.config.beforeAction && !(await this.config.beforeAction(ctx))) break;
			await this.emit({ type: "action:before", familyId: family.id, memberId: member.id, action: decision.action });

			// Guardrail: fill missing required params from action definitions (LLM sometimes sends {})
			const filledParams = this.fillMissingRequiredParams(decision.action, decision.params, availableActions);
			const chosenAction: ChosenAction = { name: decision.action, params: filledParams };
			const result = await this.config.adapter.executeAction(chosenAction, ctx);
			sessionHistory.push({
				action: decision.action,
				params: filledParams,
				success: result.success,
				responseSnippet: this.summarizeResponse(result),
				goal: decision.goal,
				durationMs: result.duration,
			});

			sessionFrustration = decision.frustration ?? sessionFrustration;
			actionCount++;

			const log: ActionLog = {
				timestamp: new Date().toISOString(),
				sessionId,
				familyId: family.id,
				familyName: family.name,
				memberId: member.id,
				memberName: member.name,
				memberRole: member.role,
				action: decision.action,
				decision,
				result,
				sessionFrustration,
				actionIndex: actionCount,
			};

			this.logger.log(log);
			this.stateManager.recordAction(log);

			await this.emit({ type: "action:after", log });

			if (this.config.afterAction) await this.config.afterAction(log);
			wantsToContinue = decision.wantsToContinue;
			if (sessionFrustration >= this.getFrustrationThreshold(member)) {
				await this.emit({
					type: "member:frustrated",
					familyId: family.id,
					memberId: member.id,
					level: sessionFrustration,
				});
				break;
			}

			if (!result.success) {
				await this.emit({
					type: "issue:detected",
					issue: {
						timestamp: log.timestamp,
						action: decision.action,
						error: result.error ?? "Unknown",
						frustration: sessionFrustration,
						memberMood: decision.mood ?? "unknown",
					},
					familyId: family.id,
					memberId: member.id,
				});

				const reaction = await this.decisionEngine.reactToFailure({
					member,
					family,
					failedAction: decision.action,
					error: result.error ?? "Unknown",
					currentFrustration: sessionFrustration,
					availableActions,
				});

				sessionFrustration = reaction.frustration ?? sessionFrustration;
				wantsToContinue = reaction.wantsToContinue;
			}
		}

		if (this.config.adapter.cleanup) await this.config.adapter.cleanup(ctx);

		await this.emit({
			type: "session:end",
			familyId: family.id,
			memberId: member.id,
			sessionId,
			actions: actionCount,
		});
	}

	// ─── Scenarios ─────────────────────────────────────────────────

	private shouldTriggerScenario(s: ScenarioConfig): boolean {
		if (s.trigger === "always") return true;
		if (s.trigger === "random") return Math.random() <= (s.probability ?? 1.0);
		return true; // 'schedule' — always trigger in --once mode
	}

	private async runScenarioSession(family: FamilyConfig, scenario: ScenarioConfig): Promise<void> {
		// Deterministic mode: skip LLM, execute fixed steps with assertions
		if (scenario.deterministic && scenario.steps?.length) {
			return this.runDeterministicScenario(family, scenario);
		}

		const member = family.members.find((m) => m.id === scenario.actor);
		if (!member) {
			console.error(`[truman] Scenario "${scenario.id}": actor "${scenario.actor}" not found in ${family.id}`);
			return;
		}

		const sessionId = randomUUID();
		const startTime = Date.now();
		const maxActions = scenario.maxActions ?? 15;
		this.stateManager.startSession(family.id, member.id);

		await this.emit({
			type: "scenario:start",
			scenarioId: scenario.id,
			familyId: family.id,
			actor: member.id,
			goal: scenario.goal,
		});

		await this.emit({
			type: "session:start",
			familyId: family.id,
			memberId: member.id,
			sessionId,
		});

		// Authenticate
		const auth = await this.config.adapter.authenticate(member, family);
		const ctx = { auth, family, member };

		let actionCount = 0;
		let sessionFrustration = 0;
		let wantsToContinue = true;
		const sessionHistory: SessionHistoryEntry[] = [];

		// Use first schedule entry as fallback (scenario overrides intent via prompt)
		const fallbackSchedule = member.schedule[0] ?? {
			days: ["mon"] as const,
			timeWindow: ["08:00", "09:00"] as [string, string],
			action: "random",
			probability: 1,
		};

		while (wantsToContinue && actionCount < maxActions && this.running) {
			const [allActions, appState] = await Promise.all([
				this.config.adapter.getAvailableActions(ctx),
				this.config.adapter.getAppState(ctx),
			]);

			// Hard constraint: remove repeated/failed actions from options
			// This forces the LLM to pick something else even when gpt-4o-mini ignores the prompt
			const availableActions = this.filterRepeatedActions(allActions, sessionHistory);
			const failedActions = this.buildFailedActionCounts(sessionHistory);

			const memberState = this.stateManager.getMemberState(family.id, member.id);

			// Pass scenario to LLM — it replaces the schedule intent with a mission goal
			const decision = await this.decisionEngine.decide({
				member,
				family,
				memberState,
				availableActions,
				appState,
				scheduledAction: fallbackSchedule,
				currentTime: this.scheduler.now().toISOString(),
				sessionHistory,
				scenario,
				failedActions,
			});

			await this.emit({ type: "action:before", familyId: family.id, memberId: member.id, action: decision.action });

			const filledParams = this.fillMissingRequiredParams(decision.action, decision.params, availableActions);
			const chosenAction: ChosenAction = { name: decision.action, params: filledParams };
			const result = await this.config.adapter.executeAction(chosenAction, ctx);

			sessionHistory.push({
				action: decision.action,
				params: filledParams,
				success: result.success,
				responseSnippet: this.summarizeResponse(result),
				goal: decision.goal,
				durationMs: result.duration,
			});

			sessionFrustration = decision.frustration ?? sessionFrustration;
			actionCount++;

			const log: ActionLog = {
				timestamp: new Date().toISOString(),
				sessionId,
				familyId: family.id,
				familyName: family.name,
				memberId: member.id,
				memberName: member.name,
				memberRole: member.role,
				action: decision.action,
				decision,
				result,
				sessionFrustration,
				actionIndex: actionCount,
			};

			this.logger.log(log);
			this.stateManager.recordAction(log);
			await this.emit({ type: "action:after", log });

			wantsToContinue = decision.wantsToContinue;

			if (sessionFrustration >= this.getFrustrationThreshold(member)) {
				await this.emit({
					type: "member:frustrated",
					familyId: family.id,
					memberId: member.id,
					level: sessionFrustration,
				});
				break;
			}

			if (!result.success) {
				const reaction = await this.decisionEngine.reactToFailure({
					member,
					family,
					failedAction: decision.action,
					error: result.error ?? "Unknown",
					currentFrustration: sessionFrustration,
					availableActions,
				});
				sessionFrustration = reaction.frustration ?? sessionFrustration;
				wantsToContinue = reaction.wantsToContinue;
			}
		}

		// Evaluate scenario success criteria
		const scenarioResult = this.scenarioEvaluator.evaluate(scenario, sessionHistory, startTime);
		this.scenarioResults.push(scenarioResult);

		if (this.config.adapter.cleanup) {
			await this.config.adapter.cleanup(ctx);
		}

		await this.emit({ type: "session:end", familyId: family.id, memberId: member.id, sessionId, actions: actionCount });
		await this.emit({ type: "scenario:end", result: scenarioResult });
	}

	/** Fill missing required params with examples when LLM sends {} */
	private fillMissingRequiredParams(
		name: string,
		params: Record<string, unknown>,
		actions: import("../types.js").AvailableAction[],
	): Record<string, unknown> {
		const def = actions.find((a) => a.name === name);
		if (!def) return params;
		const out = { ...params };
		for (const p of def.params) {
			if (p.required && out[p.name] == null) {
				if (p.example) out[p.name] = p.type === "number" ? Number(p.example) : p.example;
				else if (p.enumValues?.length) out[p.name] = p.enumValues[0];
			}
		}
		return out;
	}

	/** Build a map of action → fail count from session history */
	private buildFailedActionCounts(history: SessionHistoryEntry[]): Map<string, number> {
		const failCounts = new Map<string, number>();
		for (const h of history) {
			if (!h.success) {
				failCounts.set(h.action, (failCounts.get(h.action) ?? 0) + 1);
			}
		}
		return failCounts;
	}

	/** Block repeated actions, loop patterns (A→B→A→B), and persistently failed actions */
	private filterRepeatedActions(
		actions: import("../types.js").AvailableAction[],
		history: SessionHistoryEntry[],
	): import("../types.js").AvailableAction[] {
		if (history.length === 0) return actions;
		const blocked = new Set<string>();

		// Rule 1: Block actions that have FAILED 2+ times in this session
		// The LLM literally cannot pick them because they're removed from the list
		const failCounts = this.buildFailedActionCounts(history);
		for (const [action, count] of failCounts) {
			if (count >= 2) blocked.add(action);
		}

		if (history.length >= 2) {
			// Rule 2: Block same action repeated 2+ times consecutively
			const last = history[history.length - 1]?.action;
			if (last && last === history[history.length - 2]?.action) {
				blocked.add(last);
			}

			// Rule 3: Detect loop patterns (cycles of 2-4 actions repeating)
			// e.g. A→B→A→B or A→B→C→A→B→C
			const recent = history.slice(-10).map((h) => h.action);
			for (let cycleLen = 2; cycleLen <= 4; cycleLen++) {
				if (recent.length < cycleLen * 2) continue;
				const tail = recent.slice(-cycleLen);
				const prev = recent.slice(-cycleLen * 2, -cycleLen);
				if (tail.every((a, i) => a === prev[i])) {
					// Loop detected — block all actions in the cycle
					for (const a of tail) blocked.add(a);
				}
			}

			// Rule 4: If an action has been done 4+ times in this session, block it
			const counts = new Map<string, number>();
			for (const h of history) {
				counts.set(h.action, (counts.get(h.action) ?? 0) + 1);
			}
			for (const [action, count] of counts) {
				if (count >= 4) blocked.add(action);
			}
		}

		// Rule 5: If same action picked 3 times in a row (including successes), block it
		if (history.length >= 3) {
			const last3 = history.slice(-3).map((h) => h.action);
			if (last3[0] === last3[1] && last3[1] === last3[2]) {
				blocked.add(last3[0]);
			}
		}

		if (blocked.size === 0) return actions;
		const filtered = actions.filter((a) => !blocked.has(a.name));
		// Keep at least 2 actions available
		return filtered.length >= 2 ? filtered : actions;
	}

	// ─── Deterministic Scenarios ────────────────────────────────────

	private async runDeterministicScenario(family: FamilyConfig, scenario: ScenarioConfig): Promise<void> {
		const runner = new DeterministicRunner(this.config.adapter, this.stateManager, this.logger, (event) =>
			this.emit(event),
		);
		const result = await runner.run(family, scenario);
		this.scenarioResults.push(result);
	}

	private async emit(event: EngineEvent): Promise<void> {
		for (const h of this.eventHandlers) await h(event);
	}

	private summarizeResponse(result: ActionResult): string {
		if (!result.success) return `Failed: ${result.error ?? `HTTP ${result.statusCode}`}`;
		const data = result.response;
		if (!data) return "OK";
		if (typeof data === "string") return data.slice(0, 200);
		const obj = data as Record<string, unknown>;

		// Browser adapter responses — make them human-readable
		if ("url" in obj && "title" in obj) {
			const nav = obj.navigated ? "Navigated to" : "Stayed on";
			const warnings = Array.isArray(obj.warnings) ? ` [${(obj.warnings as string[]).join("; ")}]` : "";
			return `${nav} "${obj.title}"${warnings}`;
		}
		if ("filled" in obj) {
			const validationErrs = Array.isArray(obj.validationErrors)
				? ` ⚠️ ${(obj.validationErrors as string[]).join("; ")}`
				: "";
			return `Typed "${obj.filled}"${validationErrs}`;
		}
		if ("toggled" in obj) return "Toggled checkbox";
		if ("iframe" in obj && "clicked" in obj) return `Clicked "${obj.clicked}" inside embedded widget`;
		if ("scrolled" in obj) return `Scrolled ${obj.direction === "down" ? "down" : "up"}`;

		// API adapter responses
		if (obj.id) return `Created: id=${obj.id}${obj.title ? `, title="${obj.title}"` : ""}`;
		if (Array.isArray(data)) {
			const ids = data
				.slice(0, 5)
				.map((i: any) => (i.id ? `#${i.id}${i.title ? ` "${i.title}"` : ""}` : ""))
				.filter(Boolean);
			return `${data.length} items${ids.length ? `: ${ids.join(", ")}` : ""}`;
		}
		const parts: string[] = [];
		for (const [k, v] of Object.entries(obj)) {
			if (Array.isArray(v)) {
				const ids = v
					.slice(0, 3)
					.map((i: any) => (i.id ? `#${i.id}` : ""))
					.filter(Boolean);
				parts.push(`${k}: ${v.length}${ids.length ? ` (${ids.join(",")})` : ""}`);
			}
		}
		return parts.length ? parts.join(" | ") : JSON.stringify(data).slice(0, 150);
	}

	/** Get frustration abort threshold for a member — QA testers and high-patience members get a higher bar */
	private getFrustrationThreshold(member: { patience: number }): number {
		if (member.patience >= 5) return 0.95;
		if (member.patience >= 4) return 0.90;
		return FRUSTRATION_ABORT_THRESHOLD;
	}

	private chunk<T>(arr: T[], n: number): T[][] {
		const out: T[][] = [];
		for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
		return out;
	}
}
