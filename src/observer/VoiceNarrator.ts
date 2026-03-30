import { exec, execFile, execFileSync } from "node:child_process";
import { platform } from "node:os";
import type { EngineEvent, MemberRole } from "../types.js";
import { MemeSoundboard } from "./MemeSoundboard.js";

// ─── Expressive fallback lines ──────────────────────────────────────

const FRUSTRATED_LINES = [
	"I'm literally about to close this tab.",
	"Who designed this? Seriously.",
	"I've clicked everything and nothing works.",
	"This is the worst app I've used this week.",
	"Nope. I'm done. Life's too short.",
	"I don't even know what I'm looking at anymore.",
	"If I have to click one more broken button...",
];

const FAILURE_LINES = [
	"Wait, that didn't work?",
	"Okay that's broken.",
	"Cool, so that does nothing.",
	"Am I doing something wrong or is this app just... bad?",
	"Error? What error? I literally just clicked a button.",
	"Hmm, that was supposed to do something, right?",
];

const ANNOYED_LINES = [
	"This is taking way too long.",
	"Where am I even supposed to click?",
	"I feel like I'm going in circles.",
	"There has to be a better way to do this.",
	"Why is everything three clicks away?",
];

const NEUTRAL_LINES = [
	"Alright, let's see what this does.",
	"Okay, interesting.",
	"Hmm, where to next.",
	"Let me try this.",
];

function pick(arr: string[]): string {
	return arr[Math.floor(Math.random() * arr.length)];
}

// ─── TTS Backend types ──────────────────────────────────────────────

export type TTSBackend = "auto" | "say" | "piper" | "edge" | "espeak";

interface TTSConfig {
	backend: TTSBackend;
	piperModel?: string;
}

// ─── Voice profiles ─────────────────────────────────────────────────

interface VoiceProfile {
	say: string;
	edge: string;
	espeak: string;
	piper: string;
	rate: number;
	/** Label for logging */
	label: string;
}

// Full voice pool — every NPC gets a unique voice
const VOICE_POOL: VoiceProfile[] = [
	{ label: "Jenny", say: "Samantha", edge: "en-US-JennyNeural", espeak: "en-us+f3", piper: "0", rate: 180 },
	{ label: "Andrew", say: "Daniel", edge: "en-US-AndrewNeural", espeak: "en-us+m1", piper: "1", rate: 175 },
	{ label: "Ava", say: "Shelley (English (US))", edge: "en-US-AvaNeural", espeak: "en-us+f2", piper: "2", rate: 185 },
	{ label: "Brian", say: "Junior", edge: "en-US-BrianNeural", espeak: "en-us+m3", piper: "3", rate: 195 },
	{ label: "Emma", say: "Flo (English (US))", edge: "en-US-EmmaNeural", espeak: "en-us+f4", piper: "4", rate: 190 },
	{ label: "Guy", say: "Fred", edge: "en-US-GuyNeural", espeak: "en-us+m2", piper: "5", rate: 180 },
	{ label: "Ana", say: "Bubbles", edge: "en-US-AnaNeural", espeak: "en-us+f5", piper: "6", rate: 160 },
	{ label: "Christopher", say: "Ralph", edge: "en-US-ChristopherNeural", espeak: "en-us+m4", piper: "7", rate: 165 },
	{ label: "Aria", say: "Samantha", edge: "en-US-AriaNeural", espeak: "en-us+f1", piper: "8", rate: 180 },
	{ label: "Roger", say: "Albert", edge: "en-US-RogerNeural", espeak: "en-us+m5", piper: "9", rate: 185 },
	{ label: "Michelle", say: "Kathy", edge: "en-US-MichelleNeural", espeak: "en-us+f6", piper: "10", rate: 175 },
	{ label: "Eric", say: "Fred", edge: "en-US-EricNeural", espeak: "en-us+m6", piper: "11", rate: 170 },
	{ label: "Steffan", say: "Daniel", edge: "en-US-SteffanNeural", espeak: "en-us+m7", piper: "12", rate: 180 },
	{ label: "Ryan (UK)", say: "Daniel", edge: "en-GB-RyanNeural", espeak: "en-gb+m1", piper: "13", rate: 175 },
	{
		label: "Sonia (UK)",
		say: "Shelley (English (US))",
		edge: "en-GB-SoniaNeural",
		espeak: "en-gb+f1",
		piper: "14",
		rate: 180,
	},
	{
		label: "Libby (UK)",
		say: "Flo (English (US))",
		edge: "en-GB-LibbyNeural",
		espeak: "en-gb+f2",
		piper: "15",
		rate: 185,
	},
	{ label: "Natasha (AU)", say: "Kathy", edge: "en-AU-NatashaNeural", espeak: "en-us+f7", piper: "16", rate: 180 },
];

// Role-preferred voices — used as first picks, then round-robin from pool
const ROLE_PREFERRED: Record<MemberRole, string[]> = {
	parent: ["Jenny", "Andrew", "Ava", "Guy", "Michelle", "Christopher"],
	teen: ["Brian", "Emma", "Roger", "Steffan"],
	child: ["Ana", "Libby (UK)"],
	grandparent: ["Christopher", "Aria", "Sonia (UK)", "Natasha (AU)"],
};

// Narrator voice — system announcements
const NARRATOR_VOICE: VoiceProfile = {
	label: "Narrator",
	say: "Bad News",
	edge: "en-US-EricNeural",
	espeak: "en-us+m1",
	piper: "0",
	rate: 160,
};

// ─── Member tracking ────────────────────────────────────────────────

interface MemberInfo {
	id: string;
	name: string;
	role: MemberRole;
	persona: string;
	voice: VoiceProfile;
}

// ─── Voice Narrator ─────────────────────────────────────────────────

interface SessionTracker {
	actions: number;
	failures: number;
	lastAction: string;
	peakFrustration: number;
	firstFailure: boolean;
}

export class VoiceNarrator {
	private members = new Map<string, MemberInfo>();
	private usedVoiceLabels = new Set<string>();
	private sessionTrackers = new Map<string, SessionTracker>();
	private poolIdx = 0;
	private speaking = false;
	private queue: Array<{ text: string; voice: VoiceProfile }> = [];
	private concurrent = false; // soundscape mode — multiple voices at once
	private enabled: boolean;
	private backend: TTSBackend;
	private piperModel: string | null;
	private soundboard: MemeSoundboard;

	constructor(options: { enabled?: boolean; tts?: TTSConfig; soundscape?: boolean } = {}) {
		this.piperModel = options.tts?.piperModel ?? null;
		this.backend = this.resolveBackend(options.tts?.backend ?? "auto");
		this.enabled = (options.enabled ?? true) && this.backend !== "auto";
		this.concurrent = options.soundscape ?? false;
		this.soundboard = new MemeSoundboard();
		this.soundboard.init();

		if (this.enabled) {
			console.log(`[truman] TTS backend: ${this.backend} (${VOICE_POOL.length} voices available)`);
		} else if (options.enabled) {
			console.warn("[truman] No TTS backend found. Install: edge-tts (pip), say (macOS), espeak-ng, or piper");
		}
	}

	registerMember(id: string, name: string, role: MemberRole, persona: string): void {
		if (this.members.has(id)) return;
		const voice = this.pickVoice(role);
		this.members.set(id, { id, name, role, persona, voice });
	}

	/** Pick a unique voice — prefer role-appropriate voices, then round-robin */
	private pickVoice(role: MemberRole): VoiceProfile {
		// Try role-preferred voices first
		const preferred = ROLE_PREFERRED[role] ?? [];
		for (const label of preferred) {
			if (!this.usedVoiceLabels.has(label)) {
				const voice = VOICE_POOL.find((v) => v.label === label);
				if (voice) {
					this.usedVoiceLabels.add(label);
					return voice;
				}
			}
		}

		// Fall back to round-robin from full pool
		for (let i = 0; i < VOICE_POOL.length; i++) {
			const idx = (this.poolIdx + i) % VOICE_POOL.length;
			const voice = VOICE_POOL[idx];
			if (!this.usedVoiceLabels.has(voice.label)) {
				this.usedVoiceLabels.add(voice.label);
				this.poolIdx = idx + 1;
				return voice;
			}
		}

		// All voices used — start reusing (17+ NPCs)
		const voice = VOICE_POOL[this.poolIdx % VOICE_POOL.length];
		this.poolIdx++;
		return voice;
	}

	async handleEvent(event: EngineEvent): Promise<void> {
		if (!this.enabled) return;

		switch (event.type) {
			case "simulation:start": {
				this.soundboard.play("start");
				const startLines = [
					"The simulation begins. Let's see who survives.",
					"Welcome to the roast. No app leaves unscathed.",
					"Deploying synthetic users. May your app have mercy.",
					"The NPCs are here. They have opinions.",
				];
				this.speak(startLines[Math.floor(Math.random() * startLines.length)], NARRATOR_VOICE);
				break;
			}

			case "session:start": {
				const member = this.members.get(event.memberId);
				if (!member) break;
				this.sessionTrackers.set(member.id, {
					actions: 0,
					failures: 0,
					lastAction: "",
					peakFrustration: 0,
					firstFailure: true,
				});
				const enterLines = [
					`${member.name} enters the app. Let's see how long they last.`,
					`${member.name} is up. The clock is ticking.`,
					`Here comes ${member.name}. This should be interesting.`,
					`${member.name} has entered the building. Brace yourselves.`,
				];
				this.speak(enterLines[Math.floor(Math.random() * enterLines.length)], NARRATOR_VOICE);
				break;
			}

			case "action:after": {
				const { log } = event;
				const member = this.members.get(log.memberId);
				if (!member) break;

				const tracker = this.sessionTrackers.get(member.id);
				if (tracker) {
					tracker.actions++;
					tracker.lastAction = log.action;
					const frustration = log.decision.frustration ?? log.sessionFrustration;
					if (frustration > tracker.peakFrustration) tracker.peakFrustration = frustration;

					if (!log.result.success) {
						tracker.failures++;
						// Meme sound on failure
						this.soundboard.play("failure");
						// Narrator comments on first failure
						if (tracker.firstFailure) {
							tracker.firstFailure = false;
							const firstWallLines = [
								`${member.name} just hit their first wall.`,
								`And there it is. ${member.name}'s first frustration.`,
								`${member.name} found a crack in the armor.`,
								`First blood. ${member.name} is not happy.`,
							];
							this.speak(firstWallLines[Math.floor(Math.random() * firstWallLines.length)], NARRATOR_VOICE);
						}
						// Narrator escalates on repeated failures
						if (tracker.failures === 3) {
							this.soundboard.play("frustration");
							const threeFailLines = [
								`That's three failures for ${member.name}. This isn't going well.`,
								`Three strikes. ${member.name} is losing patience.`,
								`${member.name} has failed three times now. The app is winning.`,
							];
							this.speak(threeFailLines[Math.floor(Math.random() * threeFailLines.length)], NARRATOR_VOICE);
						}
						if (tracker.failures === 5) {
							this.soundboard.play("frustration");
							this.speak(`Five failures. ${member.name} is one click away from giving up.`, NARRATOR_VOICE);
						}
					} else if (log.result.success && tracker && tracker.failures > 0) {
						// Success after failures — positive reinforcement (50% chance)
						if (Math.random() < 0.5) this.soundboard.play("positive");
					} else if (log.result.success && tracker && tracker.actions % 8 === 0) {
						// Periodic positive — every 8 smooth actions
						if (Math.random() < 0.4) this.soundboard.play("positive");
					}
				}

				const frustration = log.decision.frustration ?? log.sessionFrustration;
				// NPCs speak more often — 40% chance, always on failure or high frustration
				const shouldSpeak = !log.result.success || frustration > 0.4 || Math.random() < 0.4;
				if (!shouldSpeak) break;

				const line = this.extractLine(member, {
					success: log.result.success,
					frustration,
					thought: log.decision.thought,
					reasoning: log.decision.reasoning,
				});
				this.speak(line, member.voice);
				break;
			}

			case "member:frustrated": {
				const member = this.members.get(event.memberId);
				if (!member) break;

				// Rage quit sound
				this.soundboard.play("ragequit");

				// NPC speaks their last words
				const thought = (event as any).thought;
				if (thought && thought.length > 3) {
					this.speak(thought, member.voice);
				} else {
					this.speak(`I can't do this anymore.`, member.voice);
				}

				// Narrator eulogizes the dropout
				const tracker = this.sessionTrackers.get(member.id);
				const actions = tracker?.actions ?? 0;
				const failures = tracker?.failures ?? 0;
				const narratorLine =
					failures > 0
						? `${member.name} has left the building. ${actions} actions, ${failures} failures. The app broke them.`
						: `${member.name} walked away after ${actions} actions. Not a single error — they just didn't get it.`;
				this.speak(narratorLine, NARRATOR_VOICE);
				break;
			}

			case "session:end": {
				const member = this.members.get(event.memberId);
				if (!member) break;
				const tracker = this.sessionTrackers.get(member.id);
				if (tracker) {
					if (tracker.failures === 0 && tracker.actions > 3) {
						const cleanLines = [
							`${member.name} made it through without a single issue. Suspicious.`,
							`Zero failures for ${member.name}. Either the app is perfect, or they didn't try hard enough.`,
							`${member.name} had a flawless run. That's... unexpected.`,
						];
						this.speak(cleanLines[Math.floor(Math.random() * cleanLines.length)], NARRATOR_VOICE);
					} else if (tracker.failures > 3) {
						const roughLines = [
							`${member.name} survived, but barely. ${tracker.failures} failures in ${tracker.actions} actions.`,
							`${member.name} is done. That was painful to watch.`,
						];
						this.speak(roughLines[Math.floor(Math.random() * roughLines.length)], NARRATOR_VOICE);
						this.soundboard.play("frustration");
					}
				}
				break;
			}

			case "scenario:end":
				if (event.result.success) {
					this.soundboard.play("positive");
					this.speak("Against all odds, the scenario passed.", NARRATOR_VOICE);
				} else {
					this.soundboard.play("failure");
					this.speak("The scenario has failed. As expected.", NARRATOR_VOICE);
				}
				break;

			case "issue:detected":
				this.soundboard.play("bug");
				break;

			case "simulation:stop": {
				this.soundboard.play("end");
				const endLines = [
					"The simulation is over. The damage has been assessed.",
					"That's a wrap. Check the report. It's not pretty.",
					"The NPCs have spoken. Fix your app.",
					"Roast complete. The bugs have been documented.",
				];
				this.speak(endLines[Math.floor(Math.random() * endLines.length)], NARRATOR_VOICE);
				break;
			}
		}
	}

	// ─── Extract spoken line ──────────────────────────────────────────

	private extractLine(
		member: MemberInfo,
		ctx: { success: boolean; frustration: number; thought?: string; reasoning?: string },
	): string {
		// Priority 1: thought — the unfiltered inner monologue
		const t = ctx.thought;
		if (t && t.length > 3 && t.length < 150) return t;

		// Priority 2: first sentence of reasoning
		const r = ctx.reasoning;
		if (r && r.length > 5) {
			const first = r.split(/[.!?]/)[0]?.trim();
			if (first && first.length > 5 && first.length < 100) return first;
		}

		// Persona-driven fallbacks
		if (!ctx.success && ctx.frustration > 0.7) {
			return pick(FRUSTRATED_LINES);
		}
		if (!ctx.success) {
			return pick(FAILURE_LINES);
		}
		if (ctx.frustration > 0.5) {
			return pick(ANNOYED_LINES);
		}
		return pick(NEUTRAL_LINES);
	}

	// ─── TTS dispatch ─────────────────────────────────────────────────

	private speak(text: string, voice: VoiceProfile): void {
		// Sanitize: remove backslashes, escaped quotes, and other artifacts
		text = text
			.replace(/\\['"]/g, "'")
			.replace(/\\/g, "")
			.trim();
		if (!text) return;

		// Log to terminal so user sees what's being said
		const isNarrator = voice === NARRATOR_VOICE;
		if (isNarrator) {
			console.log(`  🎙️  Narrator: "${text}"`);
		} else {
			console.log(`       🗣️  ${voice.label}: "${text}"`);
		}

		if (this.concurrent) {
			// Soundscape mode — fire immediately, voices overlap
			this.playTTS(text, voice).catch(() => {});
		} else {
			this.queue.push({ text, voice });
			if (!this.speaking) this.processQueue();
		}
	}

	private async processQueue(): Promise<void> {
		if (this.queue.length === 0) {
			this.speaking = false;
			return;
		}
		this.speaking = true;
		const { text, voice } = this.queue.shift()!;
		await this.playTTS(text, voice);
		this.processQueue();
	}

	private async playTTS(text: string, voice: VoiceProfile): Promise<void> {
		try {
			switch (this.backend) {
				case "say":
					await this.ttsSay(text, voice);
					break;
				case "piper":
					await this.ttsPiper(text, voice);
					break;
				case "edge":
					await this.ttsEdge(text, voice);
					break;
				case "espeak":
					await this.ttsEspeak(text, voice);
					break;
			}
		} catch {
			/* TTS failed — skip silently */
		}
	}

	// ─── Backend: macOS say ───────────────────────────────────────────

	private ttsSay(text: string, voice: VoiceProfile): Promise<void> {
		return new Promise((resolve) => {
			execFile("say", ["-v", voice.say, "-r", String(voice.rate), text], (err) => {
				if (err) execFile("say", ["-r", String(voice.rate), text], () => resolve());
				else resolve();
			});
		});
	}

	// ─── Backend: Piper ───────────────────────────────────────────────

	private ttsPiper(text: string, _voice: VoiceProfile): Promise<void> {
		return new Promise((resolve) => {
			const model = this.piperModel ?? "en_US-lessac-medium";
			const playCmd =
				platform() === "darwin"
					? `echo "${text.replace(/"/g, '\\"')}" | piper --model ${model} --output_raw | play -r 22050 -e signed -b 16 -c 1 -t raw - 2>/dev/null`
					: `echo "${text.replace(/"/g, '\\"')}" | piper --model ${model} --output_raw | aplay -r 22050 -f S16_LE -c 1 -t raw 2>/dev/null`;
			exec(playCmd, () => resolve());
		});
	}

	// ─── Backend: edge-tts ────────────────────────────────────────────

	private ttsEdge(text: string, voice: VoiceProfile): Promise<void> {
		return new Promise((resolve) => {
			const escaped = text.replace(/"/g, '\\"');
			const tmpFile = `/tmp/truman-tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp3`;
			exec(
				`edge-tts --voice "${voice.edge}" --rate "+${Math.max(0, voice.rate - 150)}%" --text "${escaped}" --write-media ${tmpFile} && afplay ${tmpFile} 2>/dev/null || mpv --no-video ${tmpFile} 2>/dev/null || play ${tmpFile} 2>/dev/null; rm -f ${tmpFile}`,
				() => resolve(),
			);
		});
	}

	// ─── Backend: espeak ──────────────────────────────────────────────

	private ttsEspeak(text: string, voice: VoiceProfile): Promise<void> {
		return new Promise((resolve) => {
			execFile("espeak-ng", ["-v", voice.espeak, "-s", String(voice.rate), text], (err) => {
				if (err) execFile("espeak", ["-v", voice.espeak, "-s", String(voice.rate), text], () => resolve());
				else resolve();
			});
		});
	}

	// ─── Auto-detect ──────────────────────────────────────────────────

	private resolveBackend(requested: TTSBackend): TTSBackend {
		if (requested !== "auto") return requested;
		if (this.commandExists("edge-tts")) return "edge";
		if (platform() === "darwin") return "say";
		if (this.commandExists("piper")) return "piper";
		if (this.commandExists("espeak-ng") || this.commandExists("espeak")) return "espeak";
		return "auto";
	}

	private commandExists(cmd: string): boolean {
		try {
			execFileSync("which", [cmd], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	}
}
