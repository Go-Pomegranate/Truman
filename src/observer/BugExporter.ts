/**
 * BugExporter — Converts Truman simulation issues into structured bug reports.
 *
 * Generates rich bug reports from NPC sessions with:
 * - Steps to reproduce (from session action history)
 * - Affected module (from adapter action category)
 * - Expected vs actual behavior
 * - NPC persona context (who hit the bug and why it matters)
 * - Frustration impact (how many NPCs were affected)
 *
 * Output formats:
 * - JSON (for direct DB insert or API call)
 * - Markdown (for Obsidian/GitHub Issues)
 */

import type {
	ActionLog,
	AvailableAction,
	FamilyReport,
	IssueRecord,
	MemberReport,
	SimulationReport,
} from "../types.js";

export interface BugReport {
	title: string;
	description: string;
	module: string;
	severity: number; // 1 (critical) - 4 (low)
	stepsToReproduce: string;
	expectedBehavior: string;
	reporter: string;
	reporterPlatform: string;
	aiAnalysis: {
		source: "truman";
		affectedMembers: string[];
		affectedRoles: string[];
		frustrationImpact: number;
		failureCount: number;
		suggestedFiles: string[];
		actionCategory: string;
		sessionContext: string;
	};
}

// ─── Bug Exporter ───────────────────────────────────────────────────
// Zero hardcoded app knowledge. Derives module/category from adapter config.

export class BugExporter {
	private actionLogs: ActionLog[] = [];
	/** action name → category from adapter */
	private actionCategories = new Map<string, string>();
	/** action name → API path from adapter (used to guess source files) */
	private actionPaths = new Map<string, string>();
	/** Optional user-provided action → files mapping */
	private fileHints = new Map<string, string[]>();

	/**
	 * Register adapter actions so we can derive module/category from them.
	 * Call this with your adapter's available actions at startup.
	 */
	registerActions(actions: Array<{ name: string; category: string; path?: string }>): void {
		for (const a of actions) {
			this.actionCategories.set(a.name, a.category);
			if (a.path) this.actionPaths.set(a.name, a.path);
		}
	}

	/** Optional: register file hints for specific actions (for bug fixers) */
	registerFileHints(hints: Record<string, string[]>): void {
		for (const [action, files] of Object.entries(hints)) {
			this.fileHints.set(action, files);
		}
	}

	/** Collect action logs during simulation */
	recordAction(log: ActionLog): void {
		this.actionLogs.push(log);
	}

	/** Generate bug reports from simulation report + collected logs */
	export(report: SimulationReport): BugReport[] {
		// Group failures by action name (deduplicate same bug hit by multiple NPCs)
		const failuresByAction = new Map<string, ActionLog[]>();

		for (const log of this.actionLogs) {
			if (!log.result.success) {
				const existing = failuresByAction.get(log.action) ?? [];
				existing.push(log);
				failuresByAction.set(log.action, existing);
			}
		}

		const bugs: BugReport[] = [];

		for (const [action, failures] of failuresByAction) {
			const uniqueMembers = [...new Set(failures.map((f) => f.memberName))];
			const uniqueRoles = [...new Set(failures.map((f) => f.memberRole))];
			const avgFrustration = failures.reduce((sum, f) => sum + f.sessionFrustration, 0) / failures.length;
			const errorMessages = [...new Set(failures.map((f) => f.result.error ?? `HTTP ${f.result.statusCode}`))];
			const module = this.actionCategories.get(action) ?? "unknown";
			const suggestedFiles = this.fileHints.get(action) ?? this.guessFiles(action);

			// Severity based on impact
			let severity = 3; // default: medium
			if (uniqueMembers.length >= 3)
				severity = 1; // critical: affects all users
			else if (uniqueMembers.length >= 2)
				severity = 2; // high: affects multiple users
			else if (avgFrustration > 0.7) severity = 2; // high: causes rage quit

			// Build steps to reproduce from session history
			const stepsToReproduce = this.buildSteps(failures[0]);

			// Build description with full context
			const description = this.buildDescription(action, failures, errorMessages, uniqueMembers, avgFrustration);

			// Session context for the AI fixer
			const sessionContext = this.buildSessionContext(failures);

			bugs.push({
				title: `${action} fails with ${errorMessages[0]} (${uniqueMembers.length} NPC${uniqueMembers.length > 1 ? "s" : ""} affected)`,
				description,
				module,
				severity,
				stepsToReproduce,
				expectedBehavior: `${action} should complete successfully and return valid data.`,
				reporter: "truman",
				reporterPlatform: "truman-simulation",
				aiAnalysis: {
					source: "truman",
					affectedMembers: uniqueMembers,
					affectedRoles: uniqueRoles,
					frustrationImpact: Math.round(avgFrustration * 100) / 100,
					failureCount: failures.length,
					suggestedFiles,
					actionCategory: module,
					sessionContext,
				},
			});
		}

		return bugs.sort((a, b) => a.severity - b.severity);
	}

	/** Export as JSON string (for DB insert or file) */
	toJSON(report: SimulationReport): string {
		return JSON.stringify(this.export(report), null, 2);
	}

	/** Export as Markdown (for GitHub Issues or Obsidian) */
	toMarkdown(report: SimulationReport): string {
		const bugs = this.export(report);
		if (bugs.length === 0) return "# No bugs found\n\nAll NPC sessions completed without issues.";

		const lines = ["# Truman Bug Report", "", `Found **${bugs.length}** issues.`, ""];

		for (const bug of bugs) {
			const severityLabel = ["", "CRITICAL", "HIGH", "MEDIUM", "LOW"][bug.severity];
			lines.push(`## [${severityLabel}] ${bug.title}`, "");
			lines.push(`**Module:** ${bug.module}`);
			lines.push(
				`**Affected:** ${bug.aiAnalysis.affectedMembers.join(", ")} (${bug.aiAnalysis.affectedRoles.join(", ")})`,
			);
			lines.push(`**Frustration impact:** ${(bug.aiAnalysis.frustrationImpact * 100).toFixed(0)}%`);
			lines.push(`**Failed:** ${bug.aiAnalysis.failureCount} times`);
			lines.push("");
			lines.push("### Description", "", bug.description, "");
			lines.push("### Steps to Reproduce", "", bug.stepsToReproduce, "");
			lines.push("### Expected Behavior", "", bug.expectedBehavior, "");
			if (bug.aiAnalysis.suggestedFiles.length > 0) {
				lines.push("### Suggested Files to Investigate", "");
				for (const f of bug.aiAnalysis.suggestedFiles) lines.push(`- \`${f}\``);
				lines.push("");
			}
			lines.push("---", "");
		}

		return lines.join("\n");
	}

	// ─── Private ──────────────────────────────────────────────────────

	/** Guess source files from the API path — generic heuristic */
	private guessFiles(action: string): string[] {
		const apiPath = this.actionPaths.get(action);
		if (!apiPath) return [];
		// /api/tasks/:id → "tasks", /api/v1/wellness → "wellness"
		const segments = apiPath.replace(/^\/api(\/v\d+)?\//, "").split("/");
		const resource = segments[0];
		if (!resource) return [];
		return [`routes/${resource}*`, `services/${resource}*`];
	}

	private buildSteps(failure: ActionLog): string {
		// Find all actions from this session leading to the failure
		const sessionLogs = this.actionLogs
			.filter((l) => l.sessionId === failure.sessionId)
			.sort((a, b) => a.actionIndex - b.actionIndex);

		const steps: string[] = [];
		for (const log of sessionLogs) {
			const status = log.result.success ? "OK" : `FAIL (${log.result.error ?? `HTTP ${log.result.statusCode}`})`;
			steps.push(`${log.actionIndex}. Execute \`${log.action}\` → ${status}`);
			if (log.action === failure.action && !log.result.success) break;
		}

		return steps.join("\n");
	}

	private buildDescription(
		action: string,
		failures: ActionLog[],
		errors: string[],
		members: string[],
		avgFrustration: number,
	): string {
		const lines = [
			`The action \`${action}\` consistently fails during NPC simulation.`,
			"",
			`**Error:** ${errors.join(", ")}`,
			`**Hit by:** ${members.join(", ")} (${failures.length} total failures across ${members.length} unique NPCs)`,
			`**Average frustration at failure:** ${(avgFrustration * 100).toFixed(0)}%`,
			"",
		];

		if (avgFrustration > 0.5) {
			lines.push(
				`> This bug causes significant user frustration. ${members.length >= 3 ? "All test personas hit this issue." : "Multiple personas were affected."}`,
			);
			lines.push("");
		}

		// Add persona context — who these NPCs represent
		const roleSet = new Set(failures.map((f) => f.memberRole));
		if (roleSet.has("child")) lines.push("- A child persona hit this bug — accessibility concern.");
		if (roleSet.has("grandparent")) lines.push("- An elderly persona hit this bug — simplicity concern.");
		if (roleSet.has("teen") && avgFrustration > 0.3) lines.push("- A teen persona rage-quit due to this bug.");

		return lines.join("\n");
	}

	private buildSessionContext(failures: ActionLog[]): string {
		// Summarize what happened in the sessions that hit this bug
		const sessions = [...new Set(failures.map((f) => f.sessionId))];
		const contexts: string[] = [];

		for (const sessionId of sessions.slice(0, 3)) {
			const sessionLogs = this.actionLogs
				.filter((l) => l.sessionId === sessionId)
				.sort((a, b) => a.actionIndex - b.actionIndex);

			const chain = sessionLogs.map((l) => `${l.action}(${l.result.success ? "ok" : "fail"})`).join(" → ");
			contexts.push(`Session: ${chain}`);
		}

		return contexts.join("\n");
	}
}
