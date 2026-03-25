import { randomUUID } from "node:crypto";
import type { FamilyStateManager } from "../family/FamilyState.js";
import type { ActionLogger } from "../observer/ActionLogger.js";
import type {
	ActionContext,
	ActionLog,
	AppAdapter,
	ChosenAction,
	DeterministicStep,
	EngineEvent,
	FamilyConfig,
	ScenarioConfig,
	ScenarioResult,
} from "../types.js";

/**
 * Executes deterministic scenarios — fixed steps with fixtures and assertions.
 * No LLM involved. Reproducible in CI.
 */
export class DeterministicRunner {
	constructor(
		private adapter: AppAdapter,
		private stateManager: FamilyStateManager,
		private logger: ActionLogger,
		private emit: (event: EngineEvent) => Promise<void>,
	) {}

	async run(family: FamilyConfig, scenario: ScenarioConfig): Promise<ScenarioResult> {
		const member = family.members.find((m) => m.id === scenario.actor);
		if (!member) throw new Error(`Actor "${scenario.actor}" not found in ${family.id}`);

		const sessionId = randomUUID();
		const startTime = Date.now();
		const steps = scenario.steps!;
		const stepResponses = new Map<string, unknown>();

		this.stateManager.startSession(family.id, member.id);

		await this.emit({
			type: "scenario:start",
			scenarioId: scenario.id,
			familyId: family.id,
			actor: member.id,
			goal: scenario.goal,
		});
		await this.emit({ type: "session:start", familyId: family.id, memberId: member.id, sessionId });

		const auth = await this.adapter.authenticate(member, family);
		const ctx: ActionContext = { auth, family, member };

		const criteriaResults: ScenarioResult["criteriaResults"] = [];
		const actionsTaken: string[] = [];
		let allPassed = true;

		for (let i = 0; i < steps.length; i++) {
			const step = steps[i];
			const resolvedParams = this.resolveParams(step.params ?? {}, stepResponses);

			await this.emit({ type: "action:before", familyId: family.id, memberId: member.id, action: step.action });

			const chosenAction: ChosenAction = { name: step.action, params: resolvedParams };
			const result = await this.adapter.executeAction(chosenAction, ctx);

			stepResponses.set(step.action, result.response);
			actionsTaken.push(step.action);

			const log: ActionLog = {
				timestamp: new Date().toISOString(),
				sessionId,
				familyId: family.id,
				familyName: family.name,
				memberId: member.id,
				memberName: member.name,
				memberRole: member.role,
				action: step.action,
				decision: {
					action: step.action,
					reasoning: `[deterministic] step ${i + 1}/${steps.length}`,
					params: resolvedParams,
					frustration: 0,
					wantsToContinue: true,
				},
				result,
				sessionFrustration: 0,
				actionIndex: i + 1,
			};

			this.logger.log(log);
			this.stateManager.recordAction(log);
			await this.emit({ type: "action:after", log });

			if (step.assert) {
				const assertResults = this.evaluate(step, result);
				criteriaResults.push(...assertResults);
				if (assertResults.some((r) => !r.passed)) allPassed = false;
			}
		}

		const scenarioResult: ScenarioResult = {
			scenarioId: scenario.id,
			actor: scenario.actor,
			goal: scenario.goal,
			success: allPassed,
			criteriaResults,
			actionsTaken,
			totalActions: steps.length,
			duration: Date.now() - startTime,
		};

		if (this.adapter.cleanup) await this.adapter.cleanup(ctx);
		await this.emit({
			type: "session:end",
			familyId: family.id,
			memberId: member.id,
			sessionId,
			actions: steps.length,
		});
		await this.emit({ type: "scenario:end", result: scenarioResult });

		return scenarioResult;
	}

	// ─── Param Resolution ─────────────────────────────────────────

	private resolveParams(params: Record<string, unknown>, stepResponses: Map<string, unknown>): Record<string, unknown> {
		const resolved: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(params)) {
			if (typeof value === "string" && value.startsWith("$prev.")) {
				const parts = value.slice(6).split(".");
				const actionName = parts[0];
				const path = parts.slice(1);
				let current: unknown = stepResponses.get(actionName);
				for (const p of path) {
					if (current == null || typeof current !== "object") {
						current = undefined;
						break;
					}
					current = (current as Record<string, unknown>)[p];
				}
				resolved[key] = current;
			} else {
				resolved[key] = value;
			}
		}
		return resolved;
	}

	// ─── Assertion Evaluation ─────────────────────────────────────

	private evaluate(
		step: DeterministicStep,
		result: { success: boolean; statusCode?: number; response?: unknown; duration: number },
	): ScenarioResult["criteriaResults"] {
		const out: ScenarioResult["criteriaResults"] = [];
		const a = step.assert!;
		const act = step.action;

		if (a.status !== undefined) {
			const ok = result.statusCode === a.status;
			out.push({
				criterion: { type: "action_performed", action: act },
				passed: ok,
				detail: ok
					? `${act}: HTTP ${result.statusCode} === ${a.status}`
					: `${act}: expected HTTP ${a.status}, got ${result.statusCode}`,
			});
		}

		if (a.success !== undefined) {
			const ok = result.success === a.success;
			out.push({
				criterion: { type: "action_performed", action: act },
				passed: ok,
				detail: ok
					? `${act}: success=${result.success}`
					: `${act}: expected success=${a.success}, got ${result.success}`,
			});
		}

		if (a.bodyContains) {
			const body = JSON.stringify(result.response ?? "").toLowerCase();
			const ok = body.includes(a.bodyContains.toLowerCase());
			out.push({
				criterion: { type: "response_matches", action: act, pattern: a.bodyContains },
				passed: ok,
				detail: ok ? `${act}: body contains "${a.bodyContains}"` : `${act}: body missing "${a.bodyContains}"`,
			});
		}

		if (a.bodyNotContains) {
			const body = JSON.stringify(result.response ?? "").toLowerCase();
			const ok = !body.includes(a.bodyNotContains.toLowerCase());
			out.push({
				criterion: { type: "response_matches", action: act, pattern: `!${a.bodyNotContains}` },
				passed: ok,
				detail: ok
					? `${act}: does not contain "${a.bodyNotContains}"`
					: `${act}: unexpectedly contains "${a.bodyNotContains}"`,
			});
		}

		if (a.maxDuration !== undefined) {
			const ok = result.duration <= a.maxDuration;
			out.push({
				criterion: { type: "action_performed", action: act },
				passed: ok,
				detail: ok
					? `${act}: ${result.duration}ms <= ${a.maxDuration}ms`
					: `${act}: ${result.duration}ms > ${a.maxDuration}ms (too slow)`,
			});
		}

		if (out.length === 0) {
			out.push({
				criterion: { type: "action_performed", action: act },
				passed: result.success,
				detail: result.success ? `${act}: OK (${result.statusCode})` : `${act}: FAILED (${result.statusCode})`,
			});
		}

		return out;
	}
}
