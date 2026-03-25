import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { DayOfWeek, FamilyConfig, MemberConfig, ScenarioConfig, ScheduleEntry } from "../types.js";

const VALID_DAYS: DayOfWeek[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const VALID_ROLES = ["parent", "teen", "child", "grandparent"];
const VALID_LIFESTYLES = ["busy", "relaxed", "chaotic", "structured"];

export function loadFamily(pathOrConfig: string | FamilyConfig): FamilyConfig {
	if (typeof pathOrConfig !== "string") {
		validate(pathOrConfig);
		return pathOrConfig;
	}

	const absPath = resolve(pathOrConfig);
	const raw = readFileSync(absPath, "utf-8");
	const parsed = parseYaml(raw) as FamilyConfig;

	validate(parsed, absPath);
	return parsed;
}

export function loadFamilies(sources: (string | FamilyConfig)[]): FamilyConfig[] {
	return sources.map((s) => loadFamily(s));
}

function validate(config: FamilyConfig, source = "inline"): void {
	const errors: string[] = [];
	const ctx = `[${source}]`;

	if (!config.id) errors.push(`${ctx} Missing family id`);
	if (!config.name) errors.push(`${ctx} Missing family name`);

	if (!VALID_LIFESTYLES.includes(config.lifestyle)) {
		errors.push(`${ctx} Invalid lifestyle "${config.lifestyle}". Use: ${VALID_LIFESTYLES.join(", ")}`);
	}

	if (!config.timezone) errors.push(`${ctx} Missing timezone`);

	if (config.techSavviness < 1 || config.techSavviness > 5) {
		errors.push(`${ctx} techSavviness must be 1-5, got ${config.techSavviness}`);
	}

	if (!config.members || config.members.length === 0) {
		errors.push(`${ctx} Family must have at least one member`);
	}

	const memberIds = new Set<string>();
	for (const member of config.members ?? []) {
		validateMember(member, config, errors, ctx);
		if (memberIds.has(member.id)) {
			errors.push(`${ctx} Duplicate member id "${member.id}"`);
		}
		memberIds.add(member.id);
	}

	// Validate scenarios (optional)
	if (config.scenarios?.length) {
		for (const scenario of config.scenarios) {
			validateScenario(scenario, memberIds, errors, ctx);
		}
	}

	if (errors.length > 0) {
		throw new Error(`Family config validation failed:\n${errors.join("\n")}`);
	}
}

function validateMember(m: MemberConfig, _family: FamilyConfig, errors: string[], ctx: string): void {
	if (!m.id) errors.push(`${ctx} Member missing id`);
	if (!m.name) errors.push(`${ctx} Member missing name`);

	if (!VALID_ROLES.includes(m.role)) {
		errors.push(`${ctx} Member "${m.name}" has invalid role "${m.role}"`);
	}

	if (m.patience < 1 || m.patience > 5) {
		errors.push(`${ctx} Member "${m.name}" patience must be 1-5`);
	}

	if (!m.persona || m.persona.length < 10) {
		errors.push(`${ctx} Member "${m.name}" needs a persona description (min 10 chars)`);
	}

	if (!m.schedule || m.schedule.length === 0) {
		errors.push(`${ctx} Member "${m.name}" needs at least one schedule entry`);
	}

	for (const entry of m.schedule ?? []) {
		validateSchedule(entry, m, errors, ctx);
	}
}

function validateSchedule(s: ScheduleEntry, member: MemberConfig, errors: string[], ctx: string): void {
	for (const day of s.days) {
		if (!VALID_DAYS.includes(day)) {
			errors.push(`${ctx} Member "${member.name}" schedule has invalid day "${day}"`);
		}
	}

	const timeRe = /^\d{2}:\d{2}$/;
	if (!timeRe.test(s.timeWindow[0]) || !timeRe.test(s.timeWindow[1])) {
		errors.push(`${ctx} Member "${member.name}" schedule timeWindow must be HH:MM format`);
	}

	if (s.probability < 0 || s.probability > 1) {
		errors.push(`${ctx} Member "${member.name}" schedule probability must be 0-1`);
	}

	if (!s.action) {
		errors.push(`${ctx} Member "${member.name}" schedule missing action`);
	}
}

const VALID_TRIGGERS = ["schedule", "random", "always"];
const VALID_CRITERION_TYPES = ["action_chain", "action_performed", "response_matches"];

function validateScenario(s: ScenarioConfig, memberIds: Set<string>, errors: string[], ctx: string): void {
	if (!s.id) errors.push(`${ctx} Scenario missing id`);
	if (!s.goal || s.goal.length < 5) errors.push(`${ctx} Scenario "${s.id}" needs a goal (min 5 chars)`);

	if (!VALID_TRIGGERS.includes(s.trigger)) {
		errors.push(`${ctx} Scenario "${s.id}" has invalid trigger "${s.trigger}"`);
	}

	if (!memberIds.has(s.actor)) {
		errors.push(`${ctx} Scenario "${s.id}" actor "${s.actor}" not found in family members`);
	}

	if (s.probability !== undefined && (s.probability < 0 || s.probability > 1)) {
		errors.push(`${ctx} Scenario "${s.id}" probability must be 0-1`);
	}

	for (const criterion of s.success_criteria ?? []) {
		if (!VALID_CRITERION_TYPES.includes(criterion.type)) {
			errors.push(`${ctx} Scenario "${s.id}" has invalid criterion type "${criterion.type}"`);
		}
	}
}
