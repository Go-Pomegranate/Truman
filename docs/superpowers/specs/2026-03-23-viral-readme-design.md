# Viral README Redesign — Truman

**Date:** 2026-03-23
**Status:** Draft

## Goal

Rewrite the Truman README to be viral and drive organic sharing on X/Reddit/HN while maintaining technical credibility and driving npm installs.

## Tone

Fireship/ThePrimeagen-style dev humor as base, with 2-3 "holy shit" moments for screenshot virality. Direct, audacious, zero buzzwords. Professional enough for adoption, sharp enough for sharing.

## Viral Mechanics

Three layered triggers:
1. **Provocation / ego challenge** — hook dares devs to prove their app is easy
2. **Humor / absurd** — persona examples are stand-up bits that also happen to be valid YAML
3. **Relatability** — every dev knows a Jaden, a Linda, a Wei

## Structure

### 1. Banner
- Keep existing `truman-banner.png`

### 2. Hook (tagline, bold, centered)
```
You think your app is easy to use? Prove it.
```

### 3. Sub-tagline (smaller, centered)
```
Synthetic users that browse your app, get frustrated, and leave — just like real ones.
```

### 4. Badges
- npm version, MIT license, TypeScript, CI — unchanged

### 5. Intro (3 lines)
```
You describe people. Truman puts them in your app.

They tap, scroll, rage-quit, come back tomorrow, forget their password,
and accidentally find the feature you almost deleted.

Then you get a report on what worked — and what made them leave.
```

### 6. "Meet your worst users" (viral section)
Four personas as literal YAML with comments acting as one-liner jokes. This block is both viral content AND format documentation — readers see humor and learn the persona schema simultaneously.

Use HTML centering for the header, then a fenced YAML code block:

```yaml
# Gen Z intern. mass-closes tabs if anything takes over 2 seconds.
- name: Jaden
  patience: 1
  persona: "If it doesn't load instantly, it doesn't exist."
  quirks: ["Swipes before the page finishes rendering"]

# Your mom trying to use your app. Reads every word on screen. Every. Single. Word.
- name: Linda
  patience: 4
  persona: "Reads the Terms of Service. Clicks 'Learn more' on every tooltip. Still not sure what the app does."
  quirks: ["Taps the logo expecting it to do something", "Reads every word on screen"]

# Senior engineer who treats your app like a pentest.
- name: Wei
  patience: 5
  persona: "Pastes Unicode into every input. Tries SQL injection on the search bar. Files issues in his head."
  quirks: ["Opens DevTools before anything else"]

# 89-year-old grandmother. Patient. Persistent. Will absolutely break your app.
- name: Abuela Carmen
  patience: 5
  techSavviness: 1
  persona: "Doesn't know what she tapped. Doesn't care. Somehow ended up on the admin panel."
  quirks: ["Double-taps everything", "Holds buttons like a TV remote"]
```

Closing line after YAML block (as blockquote):
```
> Frustration > 0.85 → they leave. Just like your real users do — except these ones tell you why.
```

### 7. Quickstart
```bash
npx @parentos/truman init my-app && cd my-app
```
Point `adapter.json` at your API, then:
```bash
npx @parentos/truman run --once
```

Or try the included [TodoMVC example](examples/todomvc/) — two terminals, two minutes.

Punchline (as blockquote):
```
> Two commands. Four synthetic users. One uncomfortable truth about your checkout flow.
```

### 8. How it works
Two-part: viral 3-liner + technical diagram.

Viral summary:
```
You describe a person.
The LLM decides what they'd do.
Your app finds out the hard way.
```

Technical flow:
```
Scheduler  → who acts now?
Adapter    → what can they see?
LLM        → what would this person do?
Adapter    → do it
State      → update frustration, memory, discovered features

Frustration > 0.85 → they leave.
```

### 9. Features (6 bullets, sharpened copy)
- **Persona-driven** — personality, patience, quirks. The LLM does the rest.
- **Frustration modeling** — if your UX sucks, they leave. Just like real users.
- **Stateful memory** — they remember what broke yesterday.
- **Realistic schedules** — 7am coffee check, not a 3am bot swarm.
- **Multi-provider** — OpenAI, Anthropic, Ollama (free & local).
- **Any HTTP API** — adapter pattern, no SDK lock-in.

### 10. LLM Providers
Unchanged from current README.

### 11. Programmatic API
Unchanged from current README.

### 12. What Truman is NOT
Unchanged from current README (including the closing sentence: "Truman is the closest thing to putting real users in front of your app without actually doing it.").

### 13. Closer (viral, HTML centered)
Use `<p align="center">` tags matching the existing header style:
```
Your app isn't hard to use.

You're just the only one who knows where everything is.
```
Followed by the install command in `<code>` tag:
```
npx @parentos/truman run --once
```

Separated from footer with `---` horizontal rule.

### 14. Footer links
Philosophy, Contributing, Code of Conduct, License — unchanged.

## Key Design Decisions

1. **Hook is a challenge, not a description** — "Prove it" > "Your users are fake". Active > passive.
2. **Personas double as docs** — YAML block is both viral content AND format documentation.
3. **Two viral anchor points** — hook (top) and closer (bottom) create a narrative arc.
4. **Technical sections untouched** — providers, API, "what it's NOT" stay clean. Virality lives in the wrapper, not the docs.
5. **Old tagline removed** — "Your app's users are fake. They just don't know it yet." was clever but passive. Doesn't drive action.

## What Changed vs Current README

| Section | Before | After |
|---------|--------|-------|
| Tagline | "Your app's users are fake..." (passive) | "You think your app is easy to use? Prove it." (challenge) |
| Sub-tagline | "AI-driven synthetic personas..." (jargon) | "...get frustrated, and leave — just like real ones" (visceral) |
| Persona examples | Generic Sarah/Mike in docs section | 4 viral archetypes in "Meet your worst users" |
| Section order | intro → features → quickstart → personas → how-it-works | intro → **personas** → quickstart → how-it-works → features (personas before quickstart creates "I want to try this" impulse) |
| Quickstart outro | None | "One uncomfortable truth about your checkout flow" |
| How it works | Technical diagram only | 3-line viral summary + diagram |
| Features | Descriptive | Sharpened tails ("they remember what broke yesterday") |
| Closer | "Let a 14-year-old with 2/5 patience prove it" | "You're just the only one who knows where everything is" |

## Out of Scope
- No changes to PHILOSOPHY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md
- No changes to source code or examples
- Banner image stays as-is
