import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ActionLog, EngineEvent } from "../types.js";

/**
 * Records a simulation session as a JSON timeline — playable in web player.
 * Each event has a timestamp offset from start for real-time playback.
 */

interface TimelineEntry {
	/** Milliseconds since simulation start */
	t: number;
	type: string;
	memberName?: string;
	memberId?: string;
	memberRole?: string;
	action?: string;
	thought?: string;
	reasoning?: string;
	mood?: string;
	frustration?: number;
	success?: boolean;
	error?: string;
}

export interface SessionRecording {
	version: 1;
	generatedAt: string;
	duration: number;
	entries: TimelineEntry[];
}

export class SessionRecorder {
	private startTime = Date.now();
	private entries: TimelineEntry[] = [];
	private outputPath: string;

	constructor(outputPath: string) {
		this.outputPath = outputPath;
	}

	handler(): (event: EngineEvent) => void {
		return (event) => this.record(event);
	}

	private record(event: EngineEvent): void {
		const t = Date.now() - this.startTime;

		switch (event.type) {
			case "simulation:start":
				this.startTime = Date.now();
				this.entries.push({ t: 0, type: "start" });
				break;

			case "action:after": {
				const { log } = event;
				this.entries.push({
					t,
					type: "action",
					memberName: log.memberName,
					memberId: log.memberId,
					memberRole: log.memberRole,
					action: log.action,
					thought: log.decision.thought,
					reasoning: log.decision.reasoning,
					mood: log.decision.mood,
					frustration: log.decision.frustration ?? log.sessionFrustration,
					success: log.result.success,
					error: log.result.error,
				});
				break;
			}

			case "member:frustrated":
				this.entries.push({
					t,
					type: "frustrated",
					memberId: event.memberId,
					frustration: event.level,
				});
				break;

			case "scenario:end":
				this.entries.push({
					t,
					type: "scenario",
					success: event.result.success,
					action: event.result.scenarioId,
				});
				break;

			case "simulation:stop":
				this.entries.push({ t, type: "stop" });
				this.save();
				break;
		}
	}

	save(): void {
		const recording: SessionRecording = {
			version: 1,
			generatedAt: new Date().toISOString(),
			duration: Date.now() - this.startTime,
			entries: this.entries,
		};

		mkdirSync(dirname(this.outputPath), { recursive: true });
		writeFileSync(this.outputPath, JSON.stringify(recording, null, 2));
	}
}
