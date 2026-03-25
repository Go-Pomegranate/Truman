import { writeFileSync } from "node:fs";
import type { ScenarioResult, SimulationReport } from "../types.js";

/**
 * Generates JUnit XML from Truman simulation results.
 * CI tools (GitHub Actions, Jenkins, GitLab) can parse this for test reporting.
 */
export function writeJUnitReport(report: SimulationReport, outputPath: string): void {
	const scenarios = report.scenarioResults ?? [];
	const totalTests = scenarios.length;
	const failures = scenarios.filter((s) => !s.success).length;
	const totalTime = scenarios.reduce((sum, s) => sum + s.duration, 0) / 1000;

	const lines: string[] = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<testsuites name="Truman NPC Simulation" tests="${totalTests}" failures="${failures}" time="${totalTime.toFixed(2)}">`,
	];

	// Group scenarios by family (actor prefix)
	const familyGroups = new Map<string, ScenarioResult[]>();
	for (const s of scenarios) {
		const family = s.actor.split("-").slice(-1)[0] ?? "unknown";
		const key = s.actor; // Use actor as suite key
		if (!familyGroups.has(key)) familyGroups.set(key, []);
		familyGroups.get(key)?.push(s);
	}

	for (const [actor, results] of familyGroups) {
		const suiteFailures = results.filter((r) => !r.success).length;
		const suiteTime = results.reduce((sum, r) => sum + r.duration, 0) / 1000;

		lines.push(
			`  <testsuite name="${escapeXml(actor)}" tests="${results.length}" failures="${suiteFailures}" time="${suiteTime.toFixed(2)}">`,
		);

		for (const result of results) {
			const testTime = (result.duration / 1000).toFixed(2);

			if (result.success) {
				lines.push(
					`    <testcase name="${escapeXml(result.scenarioId)}" classname="${escapeXml(actor)}" time="${testTime}" />`,
				);
			} else {
				lines.push(
					`    <testcase name="${escapeXml(result.scenarioId)}" classname="${escapeXml(actor)}" time="${testTime}">`,
				);

				const failedCriteria = result.criteriaResults
					.filter((c) => !c.passed)
					.map((c) => c.detail)
					.join("\n");

				lines.push(
					`      <failure message="${escapeXml(result.scenarioId)} failed">${escapeXml(failedCriteria)}</failure>`,
				);
				lines.push("    </testcase>");
			}
		}

		lines.push("  </testsuite>");
	}

	lines.push("</testsuites>");

	const xml = lines.join("\n");
	writeFileSync(outputPath, xml);
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
