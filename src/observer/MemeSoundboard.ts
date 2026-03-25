import { exec, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

// ─── Sound categories ────────────────────────────────────────────────

export type SoundCategory =
  | 'frustration'   // NPC is getting annoyed
  | 'failure'       // Action failed / error
  | 'ragequit'      // NPC leaves the app
  | 'bug'           // Bug detected
  | 'positive'      // Something worked
  | 'start'         // Roast begins
  | 'end';          // Roast complete

interface SoundDef {
  file: string;
  category: SoundCategory;
}

// Each category maps to bundled sound files in assets/sounds/
const SOUND_MAP: SoundDef[] = [
  // Frustration
  { file: 'vine-boom.mp3',          category: 'frustration' },
  { file: 'bruh.mp3',               category: 'frustration' },
  { file: 'are-you-serious.mp3',    category: 'frustration' },
  { file: 'why.mp3',                category: 'frustration' },

  // Failure
  { file: 'oof.mp3',                category: 'failure' },
  { file: 'oh-no.mp3',             category: 'failure' },
  { file: 'emotional-damage.mp3',   category: 'failure' },
  { file: 'nope.mp3',               category: 'failure' },

  // Rage quit
  { file: 'mission-failed.mp3',     category: 'ragequit' },
  { file: 'hello-darkness.mp3',     category: 'ragequit' },
  { file: 'oh-my-god.mp3',          category: 'ragequit' },

  // Bug found
  { file: 'mgs-alert.mp3',          category: 'bug' },
  { file: 'sus.mp3',                category: 'bug' },

  // Positive
  { file: 'sheesh.mp3',             category: 'positive' },
  { file: 'lets-go.mp3',            category: 'positive' },
  { file: 'wow.mp3',                category: 'positive' },
  { file: 'gg.mp3',                 category: 'positive' },

  // Start / End
  { file: 'windows-xp.mp3',         category: 'start' },
  { file: 'roast-complete.mp3',     category: 'end' },
];

// ─── Soundboard ─────────────────────────────────────────────────────

export class MemeSoundboard {
  private soundDir: string;
  private available: SoundDef[] = [];
  private _ready = false;
  private lastPlayed = '';
  private lastPlayedAt = 0;
  private cooldownMs = 5000;

  constructor() {
    // Resolve assets/sounds/ relative to this file's location in dist/
    const thisDir = dirname(fileURLToPath(import.meta.url));
    // In dist/ → go up to project root → assets/sounds/
    this.soundDir = join(thisDir, '..', 'assets', 'sounds');
    // Fallback: check from project root directly
    if (!existsSync(this.soundDir)) {
      this.soundDir = join(thisDir, '..', '..', 'assets', 'sounds');
    }
  }

  /** Check which sounds are available */
  init(): void {
    if (!existsSync(this.soundDir)) {
      console.log('  [sounds] Sound directory not found — meme sounds disabled');
      return;
    }

    this.available = SOUND_MAP.filter(s => existsSync(join(this.soundDir, s.file)));

    if (this.available.length === 0) {
      console.log('  [sounds] No sound files found — meme sounds disabled');
      return;
    }

    this._ready = true;
    console.log(`  🔊 Meme soundboard loaded (${this.available.length} sounds)`);
  }

  /** Play a random sound from a category (with 5s cooldown between sounds) */
  play(category: SoundCategory): void {
    if (!this._ready) return;
    const now = Date.now();
    if (now - this.lastPlayedAt < this.cooldownMs) return;
    const sounds = this.available.filter(s => s.category === category && s.file !== this.lastPlayed);
    if (sounds.length === 0) return;
    const sound = sounds[Math.floor(Math.random() * sounds.length)];
    this.lastPlayed = sound.file;
    this.lastPlayedAt = now;
    this.playFile(join(this.soundDir, sound.file));
  }

  get isReady(): boolean {
    return this._ready;
  }

  // ─── Internal ───────────────────────────────────────────────────

  private playFile(path: string): void {
    // Fire and forget — non-blocking
    const cmd = platform() === 'darwin'
      ? `afplay "${path}"`
      : `mpv --no-video "${path}" 2>/dev/null || play "${path}" 2>/dev/null || aplay "${path}" 2>/dev/null`;
    exec(cmd, () => {});
  }
}
