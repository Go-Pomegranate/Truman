import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import type { EngineEvent, MemberRole } from '../types.js';

// ─── Voice profiles per role ────────────────────────────────────────
// macOS voices chosen for maximum personality contrast

const VOICE_PROFILES: Record<MemberRole, MacVoice> = {
  parent: { voice: 'Samantha', rate: 180 },
  teen: { voice: 'Junior', rate: 220 },
  child: { voice: 'Bubbles', rate: 160 },
  grandparent: { voice: 'Grandma (English (US))', rate: 140 },
};

// Fallback voices for when roles don't match
const VOICE_POOL: MacVoice[] = [
  { voice: 'Daniel', rate: 180 },
  { voice: 'Shelley (English (US))', rate: 190 },
  { voice: 'Fred', rate: 170 },
  { voice: 'Flo (English (US))', rate: 185 },
];

interface MacVoice {
  voice: string;
  rate: number;
}

// ─── Reaction lines by frustration level ────────────────────────────

interface ReactionLine {
  minFrustration: number;
  maxFrustration: number;
  lines: string[];
}

const PARENT_REACTIONS: ReactionLine[] = [
  { minFrustration: 0, maxFrustration: 0.2, lines: [
    'Okay, that worked.',
    'Nice. Moving on.',
    'Good, good.',
  ]},
  { minFrustration: 0.2, maxFrustration: 0.5, lines: [
    'Hmm, that took longer than I expected.',
    'Wait, where did that button go?',
    'This should be easier.',
    'I don\'t have time for this.',
  ]},
  { minFrustration: 0.5, maxFrustration: 0.8, lines: [
    'Seriously? Again?',
    'This is really testing my patience.',
    'I have three kids and zero time for this.',
    'Why is this so complicated?',
  ]},
  { minFrustration: 0.8, maxFrustration: 1.0, lines: [
    'I\'m done. I\'m actually done.',
    'Life is too short for this app.',
    'I\'m going back to pen and paper.',
    'Uninstalling. Goodbye.',
  ]},
];

const TEEN_REACTIONS: ReactionLine[] = [
  { minFrustration: 0, maxFrustration: 0.1, lines: [
    'Whatever.',
    'K.',
    'Fine.',
  ]},
  { minFrustration: 0.1, maxFrustration: 0.3, lines: [
    'This app is mid.',
    'Bruh.',
    'It\'s giving... nothing.',
    'Can I close this now?',
  ]},
  { minFrustration: 0.3, maxFrustration: 0.6, lines: [
    'Oh my god, this is so slow.',
    'My grandma could code a better app.',
    'I literally cannot.',
    'This is why nobody uses this.',
  ]},
  { minFrustration: 0.6, maxFrustration: 1.0, lines: [
    'I\'m out. Bye.',
    'Nope. Nope nope nope.',
    'Deleting this trash.',
    'Back to TikTok.',
  ]},
];

const CHILD_REACTIONS: ReactionLine[] = [
  { minFrustration: 0, maxFrustration: 0.2, lines: [
    'Yay! It worked!',
    'Ooh, what does this button do?',
    'Cool!',
  ]},
  { minFrustration: 0.2, maxFrustration: 0.5, lines: [
    'Mommy? It\'s not working.',
    'I don\'t get it.',
    'Where did it go?',
    'Huh?',
  ]},
  { minFrustration: 0.5, maxFrustration: 0.8, lines: [
    'I don\'t like this anymore.',
    'This is boring.',
    'It\'s broken again!',
  ]},
  { minFrustration: 0.8, maxFrustration: 1.0, lines: [
    'I want my iPad back!',
    'This app is stupid!',
    'Mooooom!',
  ]},
];

const GRANDPARENT_REACTIONS: ReactionLine[] = [
  { minFrustration: 0, maxFrustration: 0.3, lines: [
    'Oh, would you look at that.',
    'Well, isn\'t that nice.',
    'My grandchildren set this up for me.',
  ]},
  { minFrustration: 0.3, maxFrustration: 0.6, lines: [
    'Now where did everything go?',
    'I think I pressed the wrong thing.',
    'Back in my day, we used paper.',
    'Can someone help me with this?',
  ]},
  { minFrustration: 0.6, maxFrustration: 1.0, lines: [
    'I give up. I\'ll call them instead.',
    'These computers will be the death of me.',
    'I\'ll just wait for my grandson to fix it.',
  ]},
];

const ROLE_REACTIONS: Record<MemberRole, ReactionLine[]> = {
  parent: PARENT_REACTIONS,
  teen: TEEN_REACTIONS,
  child: CHILD_REACTIONS,
  grandparent: GRANDPARENT_REACTIONS,
};

// ─── Special event lines ────────────────────────────────────────────

const SIMULATION_START_LINES = [
  'Alright, let\'s see what this app is about.',
  'Opening the app. Here we go.',
  'Day one. Let\'s do this.',
];

const BUG_FOUND_LINES = [
  'Well that\'s broken.',
  'Error. Lovely.',
  'That... was not supposed to happen.',
  'Found a bug. You\'re welcome.',
];

const SCENARIO_PASS_LINES = [
  'Mission accomplished.',
  'That actually worked. Impressive.',
  'Nailed it.',
];

const SCENARIO_FAIL_LINES = [
  'Mission failed. We\'ll get \'em next time.',
  'That did not go as planned.',
  'Yeah, no. That\'s broken.',
];

// ─── Voice Narrator ─────────────────────────────────────────────────

export class VoiceNarrator {
  private memberVoices = new Map<string, MacVoice>();
  private voicePoolIdx = 0;
  private speaking = false;
  private queue: Array<{ text: string; voice: MacVoice }> = [];
  private enabled: boolean;

  constructor(enabled = true) {
    this.enabled = enabled && platform() === 'darwin';
    if (!this.enabled && enabled) {
      console.warn('[truman] Voice narration requires macOS. Falling back to silent mode.');
    }
  }

  assignVoice(memberId: string, role: MemberRole): void {
    if (this.memberVoices.has(memberId)) return;
    const profile = VOICE_PROFILES[role] ?? VOICE_POOL[this.voicePoolIdx++ % VOICE_POOL.length];
    this.memberVoices.set(memberId, profile);
  }

  async handleEvent(event: EngineEvent): Promise<void> {
    if (!this.enabled) return;

    switch (event.type) {
      case 'simulation:start':
        this.speak(pick(SIMULATION_START_LINES), VOICE_PROFILES.parent);
        break;

      case 'session:start': {
        const voice = this.memberVoices.get(event.memberId);
        if (voice) this.speak('Let me check the app.', voice);
        break;
      }

      case 'action:after': {
        const { log } = event;
        const voice = this.memberVoices.get(log.memberId);
        if (!voice) break;

        const role = log.memberRole;
        const frustration = log.decision.frustration ?? log.sessionFrustration;
        const reactions = ROLE_REACTIONS[role] ?? PARENT_REACTIONS;

        // Don't narrate every action — only on notable moments
        if (!log.result.success) {
          this.speak(pick(BUG_FOUND_LINES), voice);
        } else if (frustration > 0.3 || Math.random() < 0.3) {
          const line = pickReaction(reactions, frustration);
          if (line) this.speak(line, voice);
        }
        break;
      }

      case 'issue:detected': {
        const voice = this.memberVoices.get(event.memberId);
        if (voice) this.speak(pick(BUG_FOUND_LINES), voice);
        break;
      }

      case 'member:frustrated': {
        const voice = this.memberVoices.get(event.memberId);
        const role = [...this.memberVoices.entries()]
          .find(([id]) => id === event.memberId);
        if (voice) {
          // Rage quit line — high frustration
          const reactions = ROLE_REACTIONS.teen; // rage quit is universal teen energy
          const line = pickReaction(reactions, event.level);
          if (line) this.speak(line, voice);
        }
        break;
      }

      case 'scenario:end':
        if (event.result.success) {
          this.speak(pick(SCENARIO_PASS_LINES), VOICE_PROFILES.parent);
        } else {
          this.speak(pick(SCENARIO_FAIL_LINES), { voice: 'Bad News', rate: 160 });
        }
        break;

      case 'simulation:stop':
        this.speak('Simulation complete. Check the report.', VOICE_PROFILES.parent);
        break;
    }
  }

  private speak(text: string, voice: MacVoice): void {
    this.queue.push({ text, voice });
    if (!this.speaking) this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) {
      this.speaking = false;
      return;
    }

    this.speaking = true;
    const { text, voice } = this.queue.shift()!;

    await new Promise<void>((resolve) => {
      execFile('say', ['-v', voice.voice, '-r', String(voice.rate), text], (err) => {
        if (err) {
          // Voice not available — try fallback
          execFile('say', ['-r', String(voice.rate), text], () => resolve());
        } else {
          resolve();
        }
      });
    });

    this.processQueue();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickReaction(reactions: ReactionLine[], frustration: number): string | null {
  const matching = reactions.find(
    (r) => frustration >= r.minFrustration && frustration < r.maxFrustration,
  );
  return matching ? pick(matching.lines) : null;
}
