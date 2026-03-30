import { exec, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Sound categories ────────────────────────────────────────────────

export type SoundCategory =
	| "frustration" // NPC is getting annoyed
	| "failure" // Action failed / error
	| "ragequit" // NPC leaves the app
	| "bug" // Bug detected
	| "positive" // Something worked
	| "enter" // NPC enters session
	| "start" // Roast begins
	| "end"; // Roast complete

interface SoundDef {
	file: string;
	category: SoundCategory;
}

// Each category maps to bundled sound files in assets/sounds/
const SOUND_MAP: SoundDef[] = [
	// Frustration (10)
	{ file: "vine-boom.mp3", category: "frustration" },
	{ file: "bruh.mp3", category: "frustration" },
	{ file: "are-you-serious.mp3", category: "frustration" },
	{ file: "why.mp3", category: "frustration" },
	{ file: "sad-trombone.mp3", category: "frustration" },
	{ file: "crickets.mp3", category: "frustration" },
	{ file: "windows-error.mp3", category: "frustration" },
	{ file: "nani.mp3", category: "frustration" },
	{ file: "hold-up.mp3", category: "frustration" },
	{ file: "here-we-go-again.mp3", category: "frustration" },

	// Failure (10)
	{ file: "oof.mp3", category: "failure" },
	{ file: "oh-no.mp3", category: "failure" },
	{ file: "emotional-damage.mp3", category: "failure" },
	{ file: "nope.mp3", category: "failure" },
	{ file: "bonk.mp3", category: "failure" },
	{ file: "fail-horn.mp3", category: "failure" },
	{ file: "sad-violin.mp3", category: "failure" },
	{ file: "wasted.mp3", category: "failure" },
	{ file: "thats-a-lot-of-damage.mp3", category: "failure" },
	{ file: "dial-up.mp3", category: "failure" },

	// Rage quit (8)
	{ file: "mission-failed.mp3", category: "ragequit" },
	{ file: "hello-darkness.mp3", category: "ragequit" },
	{ file: "oh-my-god.mp3", category: "ragequit" },
	{ file: "curb-your-enthusiasm.mp3", category: "ragequit" },
	{ file: "to-be-continued.mp3", category: "ragequit" },
	{ file: "dramatic-chipmunk.mp3", category: "ragequit" },
	{ file: "run.mp3", category: "ragequit" },
	{ file: "discord-leave.mp3", category: "ragequit" },

	// Bug found (6)
	{ file: "mgs-alert.mp3", category: "bug" },
	{ file: "sus.mp3", category: "bug" },
	{ file: "x-files.mp3", category: "bug" },
	{ file: "law-and-order.mp3", category: "bug" },
	{ file: "what-da-dog-doin.mp3", category: "bug" },
	{ file: "surprise-motherfucker.mp3", category: "bug" },

	// Positive (10)
	{ file: "sheesh.mp3", category: "positive" },
	{ file: "lets-go.mp3", category: "positive" },
	{ file: "wow.mp3", category: "positive" },
	{ file: "gg.mp3", category: "positive" },
	{ file: "airhorn.mp3", category: "positive" },
	{ file: "noice.mp3", category: "positive" },
	{ file: "yeah-boy.mp3", category: "positive" },
	{ file: "deja-vu.mp3", category: "positive" },
	{ file: "bazinga.mp3", category: "positive" },
	{ file: "its-free-real-estate.mp3", category: "positive" },

	// NPC enters
	{ file: "discord-join.mp3", category: "enter" },

	// Start / End
	{ file: "windows-xp.mp3", category: "start" },
	{ file: "roast-complete.mp3", category: "end" },
];

// ─── Soundboard ─────────────────────────────────────────────────────

export class MemeSoundboard {
	private soundDir: string;
	private available: SoundDef[] = [];
	private _ready = false;
	private lastPlayed = "";
	private lastPlayedAt = 0;
	private cooldownMs = 4000;
	private playCounts = new Map<string, number>(); // track plays per sound per session
	private maxPlaysPerSound = 2; // max times a sound can play in one session

	constructor() {
		// Resolve assets/sounds/ relative to this file's location in dist/
		const thisDir = dirname(fileURLToPath(import.meta.url));
		// In dist/ → go up to project root → assets/sounds/
		this.soundDir = join(thisDir, "..", "assets", "sounds");
		// Fallback: check from project root directly
		if (!existsSync(this.soundDir)) {
			this.soundDir = join(thisDir, "..", "..", "assets", "sounds");
		}
	}

	/** Check which sounds are available */
	init(): void {
		if (!existsSync(this.soundDir)) {
			console.log("  [sounds] Sound directory not found — meme sounds disabled");
			return;
		}

		this.available = SOUND_MAP.filter((s) => existsSync(join(this.soundDir, s.file)));

		if (this.available.length === 0) {
			console.log("  [sounds] No sound files found — meme sounds disabled");
			return;
		}

		this._ready = true;
		console.log(`  🔊 Meme soundboard loaded (${this.available.length} sounds)`);
	}

	/** Play a random sound from a category (with cooldown + max 2 plays per sound per session) */
	play(category: SoundCategory): void {
		if (!this._ready) return;
		const now = Date.now();
		if (now - this.lastPlayedAt < this.cooldownMs) return;
		// Filter: right category, not the last played, and not overplayed
		const sounds = this.available.filter(
			(s) =>
				s.category === category &&
				s.file !== this.lastPlayed &&
				(this.playCounts.get(s.file) ?? 0) < this.maxPlaysPerSound,
		);
		if (sounds.length === 0) return;
		const sound = sounds[Math.floor(Math.random() * sounds.length)];
		this.lastPlayed = sound.file;
		this.lastPlayedAt = now;
		this.playCounts.set(sound.file, (this.playCounts.get(sound.file) ?? 0) + 1);
		this.playFile(join(this.soundDir, sound.file));
	}

	get isReady(): boolean {
		return this._ready;
	}

	// ─── Internal ───────────────────────────────────────────────────

	private playFile(path: string): void {
		// Fire and forget — non-blocking
		const cmd =
			platform() === "darwin"
				? `afplay "${path}"`
				: `mpv --no-video "${path}" 2>/dev/null || play "${path}" 2>/dev/null || aplay "${path}" 2>/dev/null`;
		exec(cmd, () => {});
	}
}
