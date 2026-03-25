import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionLog, FamilyConfig, FamilyState, MemberState } from "../types.js";

const MAX_RECENT_ACTIONS = 20;
const MAX_ISSUES = 50;
const MAX_TOP_ISSUES = 10;

export class FamilyStateManager {
	private states = new Map<string, FamilyState>();
	private stateDir: string;

	constructor(stateDir: string) {
		this.stateDir = stateDir;
		if (!existsSync(stateDir)) {
			mkdirSync(stateDir, { recursive: true });
		}
	}

	/** Load or initialize state for a family */
	getState(family: FamilyConfig): FamilyState {
		const existing = this.states.get(family.id);
		if (existing) return existing;

		const filePath = this.filePath(family.id);
		if (existsSync(filePath)) {
			const raw = readFileSync(filePath, "utf-8");
			const state = JSON.parse(raw) as FamilyState;
			this.states.set(family.id, state);
			return state;
		}

		const fresh = this.initState(family);
		this.states.set(family.id, fresh);
		return fresh;
	}

	/** Get member state, initializing if needed */
	getMemberState(familyId: string, memberId: string): MemberState {
		const family = this.states.get(familyId);
		if (!family) throw new Error(`Family ${familyId} not loaded`);

		if (!family.members[memberId]) {
			family.members[memberId] = this.initMemberState(memberId);
		}
		return family.members[memberId];
	}

	/** Record an action and update stats */
	recordAction(log: ActionLog): void {
		const family = this.states.get(log.familyId);
		if (!family) return;

		const member = this.getMemberState(log.familyId, log.memberId);

		member.totalActions++;
		member.lastSessionAt = log.timestamp;
		member.recentActions = [`${log.action}: ${log.result.success ? "ok" : "fail"}`, ...member.recentActions].slice(
			0,
			MAX_RECENT_ACTIONS,
		);

		// Track frustration (exponential moving average)
		const frustration = log.decision.frustration ?? 0;
		member.avgFrustration = member.avgFrustration * 0.8 + frustration * 0.2;

		// Track discovered features
		if (log.result.success && !member.discoveredFeatures.includes(log.action)) {
			member.discoveredFeatures.push(log.action);
		}

		// Track issues
		if (!log.result.success) {
			member.issues = [
				{
					timestamp: log.timestamp,
					action: log.action,
					error: log.result.error ?? "Unknown error",
					frustration,
					memberMood: log.decision.mood ?? "unknown",
				},
				...member.issues,
			].slice(0, MAX_ISSUES);
		}

		// Update family stats
		family.stats.totalActions++;
		family.stats.successRate = this.calcSuccessRate(family);
		this.updateTopIssues(family, log);

		family.lastUpdated = new Date().toISOString();
	}

	/** Mark start of a new session */
	startSession(familyId: string, memberId: string): void {
		const member = this.getMemberState(familyId, memberId);
		member.totalSessions++;

		const family = this.states.get(familyId);
		if (family) family.stats.totalSessions++;
	}

	/** Persist all states to disk */
	save(): void {
		for (const [familyId, state] of this.states) {
			const filePath = this.filePath(familyId);
			writeFileSync(filePath, JSON.stringify(state, null, 2));
		}
	}

	/** Get all loaded states (for reporting) */
	getAllStates(): FamilyState[] {
		return Array.from(this.states.values());
	}

	private filePath(familyId: string): string {
		return join(this.stateDir, `${familyId}.json`);
	}

	private initState(family: FamilyConfig): FamilyState {
		const members: Record<string, MemberState> = {};
		for (const m of family.members) {
			members[m.id] = this.initMemberState(m.id);
		}
		return {
			familyId: family.id,
			lastUpdated: new Date().toISOString(),
			members,
			stats: { totalSessions: 0, totalActions: 0, successRate: 1, avgSessionDuration: 0, topIssues: [] },
		};
	}

	private initMemberState(memberId: string): MemberState {
		return {
			memberId,
			lastSessionAt: null,
			totalSessions: 0,
			totalActions: 0,
			avgFrustration: 0,
			discoveredFeatures: [],
			issues: [],
			recentActions: [],
		};
	}

	private calcSuccessRate(family: FamilyState): number {
		let total = 0;
		let successes = 0;
		for (const member of Object.values(family.members)) {
			total += member.totalActions;
			successes += member.totalActions - member.issues.length;
		}
		return total === 0 ? 1 : successes / total;
	}

	private updateTopIssues(family: FamilyState, log: ActionLog): void {
		if (log.result.success) return;

		const existing = family.stats.topIssues.find((i) => i.action === log.action);
		if (existing) {
			existing.count++;
			existing.lastSeen = log.timestamp;
		} else {
			family.stats.topIssues.push({ action: log.action, count: 1, lastSeen: log.timestamp });
		}

		family.stats.topIssues.sort((a, b) => b.count - a.count);
		family.stats.topIssues = family.stats.topIssues.slice(0, MAX_TOP_ISSUES);
	}
}
