import { execFile, exec, execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import type { EngineEvent, MemberRole } from '../types.js';

// ─── TTS Backend types ──────────────────────────────────────────────

export type TTSBackend = 'auto' | 'say' | 'piper' | 'edge' | 'espeak';

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
  { label: 'Jenny',       say: 'Samantha',                  edge: 'en-US-JennyNeural',              espeak: 'en-us+f3', piper: '0', rate: 180 },
  { label: 'Andrew',      say: 'Daniel',                    edge: 'en-US-AndrewNeural',             espeak: 'en-us+m1', piper: '1', rate: 175 },
  { label: 'Ava',         say: 'Shelley (English (US))',    edge: 'en-US-AvaNeural',                espeak: 'en-us+f2', piper: '2', rate: 185 },
  { label: 'Brian',       say: 'Junior',                    edge: 'en-US-BrianNeural',              espeak: 'en-us+m3', piper: '3', rate: 195 },
  { label: 'Emma',        say: 'Flo (English (US))',        edge: 'en-US-EmmaNeural',               espeak: 'en-us+f4', piper: '4', rate: 190 },
  { label: 'Guy',         say: 'Fred',                      edge: 'en-US-GuyNeural',                espeak: 'en-us+m2', piper: '5', rate: 180 },
  { label: 'Ana',         say: 'Bubbles',                   edge: 'en-US-AnaNeural',                espeak: 'en-us+f5', piper: '6', rate: 160 },
  { label: 'Christopher', say: 'Ralph',                     edge: 'en-US-ChristopherNeural',        espeak: 'en-us+m4', piper: '7', rate: 165 },
  { label: 'Aria',        say: 'Samantha',                  edge: 'en-US-AriaNeural',               espeak: 'en-us+f1', piper: '8', rate: 180 },
  { label: 'Roger',       say: 'Albert',                    edge: 'en-US-RogerNeural',              espeak: 'en-us+m5', piper: '9', rate: 185 },
  { label: 'Michelle',    say: 'Kathy',                     edge: 'en-US-MichelleNeural',           espeak: 'en-us+f6', piper: '10', rate: 175 },
  { label: 'Eric',        say: 'Fred',                      edge: 'en-US-EricNeural',               espeak: 'en-us+m6', piper: '11', rate: 170 },
  { label: 'Steffan',     say: 'Daniel',                    edge: 'en-US-SteffanNeural',            espeak: 'en-us+m7', piper: '12', rate: 180 },
  { label: 'Ryan (UK)',   say: 'Daniel',                    edge: 'en-GB-RyanNeural',               espeak: 'en-gb+m1', piper: '13', rate: 175 },
  { label: 'Sonia (UK)',  say: 'Shelley (English (US))',    edge: 'en-GB-SoniaNeural',              espeak: 'en-gb+f1', piper: '14', rate: 180 },
  { label: 'Libby (UK)',  say: 'Flo (English (US))',        edge: 'en-GB-LibbyNeural',              espeak: 'en-gb+f2', piper: '15', rate: 185 },
  { label: 'Natasha (AU)',say: 'Kathy',                     edge: 'en-AU-NatashaNeural',            espeak: 'en-us+f7', piper: '16', rate: 180 },
];

// Role-preferred voices — used as first picks, then round-robin from pool
const ROLE_PREFERRED: Record<MemberRole, string[]> = {
  parent: ['Jenny', 'Andrew', 'Ava', 'Guy', 'Michelle', 'Christopher'],
  teen: ['Brian', 'Emma', 'Roger', 'Steffan'],
  child: ['Ana', 'Libby (UK)'],
  grandparent: ['Christopher', 'Aria', 'Sonia (UK)', 'Natasha (AU)'],
};

// Narrator voice — system announcements
const NARRATOR_VOICE: VoiceProfile = {
  label: 'Narrator', say: 'Bad News', edge: 'en-US-EricNeural', espeak: 'en-us+m1', piper: '0', rate: 160,
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

export class VoiceNarrator {
  private members = new Map<string, MemberInfo>();
  private usedVoiceLabels = new Set<string>();
  private poolIdx = 0;
  private speaking = false;
  private queue: Array<{ text: string; voice: VoiceProfile }> = [];
  private concurrent = false; // soundscape mode — multiple voices at once
  private enabled: boolean;
  private backend: TTSBackend;
  private piperModel: string | null;

  constructor(options: { enabled?: boolean; tts?: TTSConfig; soundscape?: boolean } = {}) {
    this.piperModel = options.tts?.piperModel ?? null;
    this.backend = this.resolveBackend(options.tts?.backend ?? 'auto');
    this.enabled = (options.enabled ?? true) && this.backend !== 'auto';
    this.concurrent = options.soundscape ?? false;

    if (this.enabled) {
      console.log(`[truman] TTS backend: ${this.backend} (${VOICE_POOL.length} voices available)`);
    } else if (options.enabled) {
      console.warn('[truman] No TTS backend found. Install: edge-tts (pip), say (macOS), espeak-ng, or piper');
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
      case 'simulation:start':
        this.speak('Simulation starting. Let\'s see how they handle this.', NARRATOR_VOICE);
        break;

      case 'action:after': {
        const { log } = event;
        const member = this.members.get(log.memberId);
        if (!member) break;

        const frustration = log.decision.frustration ?? log.sessionFrustration;
        const shouldSpeak = !log.result.success || frustration > 0.5 || Math.random() < 0.25;
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

      case 'member:frustrated': {
        const member = this.members.get(event.memberId);
        if (!member) break;
        this.speak(
          this.extractLine(member, { success: false, frustration: event.level, reasoning: 'I can\'t take this anymore.' }),
          member.voice,
        );
        break;
      }

      case 'scenario:end':
        this.speak(event.result.success ? 'Scenario passed.' : 'Scenario failed.', NARRATOR_VOICE);
        break;

      case 'simulation:stop':
        this.speak('Simulation complete.', NARRATOR_VOICE);
        break;
    }
  }

  // ─── Extract spoken line ──────────────────────────────────────────

  private extractLine(
    _member: MemberInfo,
    ctx: { success: boolean; frustration: number; thought?: string; reasoning: string },
  ): string {
    // Priority 1: thought — short UX inner monologue from LLM
    const t = ctx.thought;
    if (t && t.length > 3 && t.length < 100) return t;

    // Priority 2: first sentence of reasoning
    const r = ctx.reasoning;
    if (r && r.length > 5) {
      const first = r.split(/[.!?]/)[0]?.trim();
      if (first && first.length > 5 && first.length < 80) return first;
    }

    if (!ctx.success) return `That didn't work.`;
    if (ctx.frustration > 0.7) return `I'm losing patience.`;
    return `Okay.`;
  }

  // ─── TTS dispatch ─────────────────────────────────────────────────

  private speak(text: string, voice: VoiceProfile): void {
    if (this.concurrent) {
      // Soundscape mode — fire immediately, voices overlap
      this.playTTS(text, voice).catch(() => {});
    } else {
      this.queue.push({ text, voice });
      if (!this.speaking) this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) { this.speaking = false; return; }
    this.speaking = true;
    const { text, voice } = this.queue.shift()!;
    await this.playTTS(text, voice);
    this.processQueue();
  }

  private async playTTS(text: string, voice: VoiceProfile): Promise<void> {
    try {
      switch (this.backend) {
        case 'say': await this.ttsSay(text, voice); break;
        case 'piper': await this.ttsPiper(text, voice); break;
        case 'edge': await this.ttsEdge(text, voice); break;
        case 'espeak': await this.ttsEspeak(text, voice); break;
      }
    } catch { /* TTS failed — skip silently */ }
  }

  // ─── Backend: macOS say ───────────────────────────────────────────

  private ttsSay(text: string, voice: VoiceProfile): Promise<void> {
    return new Promise((resolve) => {
      execFile('say', ['-v', voice.say, '-r', String(voice.rate), text], (err) => {
        if (err) execFile('say', ['-r', String(voice.rate), text], () => resolve());
        else resolve();
      });
    });
  }

  // ─── Backend: Piper ───────────────────────────────────────────────

  private ttsPiper(text: string, _voice: VoiceProfile): Promise<void> {
    return new Promise((resolve) => {
      const model = this.piperModel ?? 'en_US-lessac-medium';
      const playCmd = platform() === 'darwin'
        ? `echo "${text.replace(/"/g, '\\"')}" | piper --model ${model} --output_raw | play -r 22050 -e signed -b 16 -c 1 -t raw - 2>/dev/null`
        : `echo "${text.replace(/"/g, '\\"')}" | piper --model ${model} --output_raw | aplay -r 22050 -f S16_LE -c 1 -t raw 2>/dev/null`;
      exec(playCmd, () => resolve());
    });
  }

  // ─── Backend: edge-tts ────────────────────────────────────────────

  private ttsEdge(text: string, voice: VoiceProfile): Promise<void> {
    return new Promise((resolve) => {
      const escaped = text.replace(/"/g, '\\"').replace(/'/g, "\\'");
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
      execFile('espeak-ng', ['-v', voice.espeak, '-s', String(voice.rate), text], (err) => {
        if (err) execFile('espeak', ['-v', voice.espeak, '-s', String(voice.rate), text], () => resolve());
        else resolve();
      });
    });
  }

  // ─── Auto-detect ──────────────────────────────────────────────────

  private resolveBackend(requested: TTSBackend): TTSBackend {
    if (requested !== 'auto') return requested;
    if (this.commandExists('edge-tts')) return 'edge';
    if (platform() === 'darwin') return 'say';
    if (this.commandExists('piper')) return 'piper';
    if (this.commandExists('espeak-ng') || this.commandExists('espeak')) return 'espeak';
    return 'auto';
  }

  private commandExists(cmd: string): boolean {
    try {
      execFileSync('which', [cmd], { stdio: 'ignore' });
      return true;
    } catch { return false; }
  }
}
