import chalk from "chalk";
import logUpdate from "log-update";
import type { EngineEvent, EventHandler, ScenarioResult } from "../types.js";

const SPINNERS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BOX = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", vr: "├", vl: "┤" };
const W = 60;

type MemberStatus = "waiting" | "thinking" | "executing" | "done";

interface MemberDash {
	name: string;
	status: MemberStatus;
	totalActions: number;
	successCount: number;
	failCount: number;
	lastAction?: string;
	lastDuration?: number;
	currentScenario?: string;
}

interface FamilyDash {
	name: string;
	members: Map<string, MemberDash>;
}

/**
 * Live terminal dashboard that updates in-place during simulation.
 * Plugs into SimulationEngine via engine.on(dashboard.handler()).
 */
export class LiveDashboard {
	private families = new Map<string, FamilyDash>();
	private startTime = Date.now();
	private totalActions = 0;
	private totalSuccess = 0;
	private totalFail = 0;
	private spinnerIdx = 0;
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private lastQuote = "";
	private scenarioResults: ScenarioResult[] = [];
	private stopped = false;

	/** Returns an EventHandler compatible with engine.on() */
	handler(): EventHandler {
		return (event) => this.onEvent(event);
	}

	/** Start auto-refreshing the terminal */
	start(): void {
		this.startTime = Date.now();
		this.tickTimer = setInterval(() => {
			this.spinnerIdx = (this.spinnerIdx + 1) % SPINNERS.length;
			if (!this.stopped) this.draw();
		}, 100);
	}

	/** Stop rendering, clear interval */
	stop(): void {
		this.stopped = true;
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		logUpdate.done();
	}

	private onEvent(event: EngineEvent): void {
		switch (event.type) {
			case "simulation:start":
				for (const name of event.families) {
					this.families.set(name, { name, members: new Map() });
				}
				break;

			case "session:start": {
				const fam = this.findFamily(event.familyId);
				if (fam) {
					const existing = fam.members.get(event.memberId);
					if (existing) {
						existing.status = "thinking";
					} else {
						fam.members.set(event.memberId, {
							name: event.memberId,
							status: "thinking",
							totalActions: 0,
							successCount: 0,
							failCount: 0,
						});
					}
				}
				break;
			}

			case "action:before": {
				const member = this.findMember(event.familyId, event.memberId);
				if (member) {
					member.status = "executing";
					member.lastAction = event.action;
				}
				break;
			}

			case "action:after": {
				const log = event.log;
				const member = this.findMember(log.familyId, log.memberId);
				if (member) {
					member.name = log.memberName;
					member.totalActions++;
					member.lastAction = log.action;
					member.lastDuration = log.result.duration;
					if (log.result.success) member.successCount++;
					else member.failCount++;
					member.status = "thinking";
				}
				this.totalActions++;
				if (log.result.success) this.totalSuccess++;
				else this.totalFail++;
				if (log.decision.reasoning) {
					this.lastQuote = `${log.memberName}: "${log.decision.reasoning.slice(0, 50)}..."`;
				}
				break;
			}

			case "session:end": {
				const member = this.findMember(event.familyId, event.memberId);
				if (member) member.status = "done";
				break;
			}

			case "scenario:start": {
				const member = this.findMember(event.familyId, event.actor);
				if (member) member.currentScenario = event.scenarioId;
				break;
			}

			case "scenario:end":
				this.scenarioResults.push(event.result);
				break;

			case "member:frustrated": {
				const member = this.findMember(event.familyId, event.memberId);
				if (member) member.status = "done";
				break;
			}
		}

		if (!this.stopped) this.draw();
	}

	private draw(): void {
		const lines: string[] = [];
		const elapsed = this.formatTime(Date.now() - this.startTime);
		const rate = this.totalActions > 0 ? Math.round((this.totalSuccess / this.totalActions) * 100) : 100;
		const rateColor = rate >= 90 ? chalk.green : rate >= 60 ? chalk.yellow : chalk.red;

		// Header
		lines.push(chalk.cyan(this.line(BOX.tl, BOX.tr)));
		lines.push(chalk.cyan(BOX.v) + this.pad(chalk.bold(" 🎬 TRUMAN LIVE"), W - 2) + chalk.cyan(BOX.v));
		const statsLine = ` ⏱ ${chalk.white.bold(elapsed)}  📊 ${chalk.white.bold(String(this.totalActions))} actions  ${chalk.green("✓")} ${this.totalSuccess}  ${chalk.red("✗")} ${this.totalFail}  ${rateColor(`${rate}%`)}`;
		lines.push(chalk.cyan(BOX.v) + this.pad(statsLine, W - 2) + chalk.cyan(BOX.v));
		lines.push(chalk.cyan(this.line(BOX.vr, BOX.vl)));

		// Families
		for (const [, fam] of this.families) {
			lines.push(chalk.cyan(BOX.v) + this.pad(chalk.bold.white(` 🏠 ${fam.name}`), W - 2) + chalk.cyan(BOX.v));

			for (const [, member] of fam.members) {
				const statusStr = this.renderMemberStatus(member);
				const name = this.pad(chalk.bold(member.name), 12);
				const progressBar = this.progressBar(member.totalActions, 10, 10);
				lines.push(chalk.cyan(BOX.v) + this.pad(`   ${name} ${progressBar} ${statusStr}`, W - 2) + chalk.cyan(BOX.v));
			}
			lines.push(chalk.cyan(BOX.v) + this.pad("", W - 2) + chalk.cyan(BOX.v));
		}

		// Scenarios
		if (this.scenarioResults.length > 0) {
			lines.push(chalk.cyan(this.line(BOX.vr, BOX.vl)));
			lines.push(chalk.cyan(BOX.v) + this.pad(chalk.bold.white(" 📋 SCENARIOS"), W - 2) + chalk.cyan(BOX.v));
			for (const r of this.scenarioResults.slice(-4)) {
				const icon = r.success ? chalk.green("✓") : chalk.red("✗");
				const passed = r.criteriaResults.filter((c) => c.passed).length;
				const total = r.criteriaResults.length;
				lines.push(
					chalk.cyan(BOX.v) +
						this.pad(`   ${icon} ${r.scenarioId} (${r.actor}) ${passed}/${total}`, W - 2) +
						chalk.cyan(BOX.v),
				);
			}
		}

		// Footer
		lines.push(chalk.cyan(this.line(BOX.vr, BOX.vl)));
		const quote = this.lastQuote ? chalk.dim(` 💬 ${this.lastQuote.slice(0, W - 8)}`) : chalk.dim(" 💬 waiting...");
		lines.push(chalk.cyan(BOX.v) + this.pad(quote, W - 2) + chalk.cyan(BOX.v));
		lines.push(chalk.cyan(this.line(BOX.bl, BOX.br)));

		logUpdate(lines.join("\n"));
	}

	private renderMemberStatus(m: MemberDash): string {
		switch (m.status) {
			case "waiting":
				return chalk.dim("waiting");
			case "thinking":
				return chalk.yellow(SPINNERS[this.spinnerIdx]) + chalk.dim(" thinking...");
			case "executing":
				return chalk.cyan("⚡") + chalk.white(` ${m.lastAction ?? ""}`);
			case "done": {
				const scenario = m.currentScenario ? chalk.dim(` 📋${m.currentScenario}`) : "";
				return chalk.green("✓") + chalk.dim(` ${m.successCount}/${m.totalActions}`) + scenario;
			}
		}
	}

	private progressBar(current: number, max: number, width: number): string {
		const ratio = Math.min(1, current / max);
		const filled = Math.round(ratio * width);
		return chalk.green("█".repeat(filled)) + chalk.dim("░".repeat(width - filled));
	}

	private line(l: string, r: string): string {
		return l + BOX.h.repeat(W - 2) + r;
	}

	private pad(text: string, width: number): string {
		const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
		const diff = width - stripped.length;
		return diff > 0 ? text + " ".repeat(diff) : text;
	}

	private formatTime(ms: number): string {
		const s = Math.floor(ms / 1000);
		const m = Math.floor(s / 60);
		return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
	}

	private findFamily(familyId: string): FamilyDash | undefined {
		for (const [, f] of this.families) {
			if (f.name === familyId || f.name.toLowerCase().includes(familyId.toLowerCase())) return f;
		}
		// Fallback: create on the fly
		const dash: FamilyDash = { name: familyId, members: new Map() };
		this.families.set(familyId, dash);
		return dash;
	}

	private findMember(familyId: string, memberId: string): MemberDash | undefined {
		const fam = this.findFamily(familyId);
		return fam?.members.get(memberId);
	}
}
