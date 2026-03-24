<p align="center">
  <img src="assets/truman-banner.png" alt="Truman — AI-driven synthetic users for your app" width="700" />
</p>

<p align="center">
  <strong>You think your app is easy to use? Prove it.</strong>
</p>

<p align="center">
  Synthetic users that browse your app, get frustrated, and leave — just like real ones.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/truman-cli"><img src="https://img.shields.io/npm/v/truman-cli.svg?style=flat-square" alt="npm version" /></a>
  <a href="https://github.com/Go-Pomegranate/Truman/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="MIT License" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.6+-blue?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://github.com/Go-Pomegranate/Truman/actions"><img src="https://img.shields.io/github/actions/workflow/status/Go-Pomegranate/Truman/ci.yml?style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://github.com/Go-Pomegranate/Truman/stargazers"><img src="https://img.shields.io/github/stars/Go-Pomegranate/Truman?style=flat-square" alt="GitHub stars" /></a>
  <a href="https://discord.gg/wz25vvfdE3"><img src="https://img.shields.io/discord/1485971788822351945?style=flat-square&logo=discord&logoColor=white&label=Discord&color=5865F2" alt="Discord" /></a>
</p>

---

## Roast your app in 30 seconds

```bash
npx truman-cli roast --target https://your-app.com
```

> Three brutal personas. One command. A report that hurts your feelings.

<p align="center">
  <img src="assets/demo.gif" alt="Truman roast demo" width="700" />
</p>

<!-- To record this GIF: brew install charmbracelet/tap/vhs && vhs assets/demo.tape -->

---

You describe people. Truman puts them in your app.

They tap, scroll, rage-quit, come back tomorrow, forget their password, and accidentally find the feature you almost deleted.

Then you get a report on what worked — and what made them leave.

## Meet your worst users

```yaml
# Gen Z intern. Mass-closes tabs if anything takes over 2 seconds.
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

> Frustration > 0.85 → they leave. Just like your real users do — except these ones tell you why.

## Install

```bash
npm install truman-cli
```

Or run it directly — no install needed:

```bash
npx truman-cli
```

## Quickstart

```bash
npx truman-cli init my-app && cd my-app
```

Point `adapter.json` at your API, then:

```bash
npx truman-cli run --once
```

Or try the included [TodoMVC example](examples/todomvc/) — two terminals, two minutes.

> Two commands. Four synthetic users. One uncomfortable truth about your checkout flow.

## How it works

```
You describe a person.
The LLM decides what they'd do.
Your app finds out the hard way.
```

```
Scheduler  → who acts now?
Adapter    → what can they see?
LLM        → what would this person do?
Adapter    → do it
State      → update frustration, memory, discovered features

Frustration > 0.85 → they leave.
```

## Features

- **Persona-driven** — personality, patience, quirks. The LLM does the rest.
- **Frustration modeling** — if your UX sucks, they leave. Just like real users.
- **Stateful memory** — they remember what broke yesterday.
- **Realistic schedules** — 7am coffee check, not a 3am bot swarm.
- **Multi-provider** — OpenAI, Anthropic, Ollama (free & local).
- **Any HTTP API** — adapter pattern, no SDK lock-in.
- **Voice narration** — hear your NPCs complain out loud.
- **Bug export** — pipe findings into any bug tracker.

## Commands

| Command | What it does |
|---|---|
| `truman roast` | One command, 3 brutal personas, bug report |
| `truman run` | Run simulation — NPCs use your app |
| `truman init` | Scaffold adapter + families for your app |
| `truman validate` | Check family YAML configs |
| `truman preview` | Dry run — see what NPCs would do, no API calls |
| `truman report` | Re-generate report from saved logs |

Full reference with all flags and examples: **[docs/commands.md](docs/commands.md)**

## LLM providers

```bash
OPENAI_API_KEY=sk-...    truman run --once              # OpenAI (default)
ANTHROPIC_API_KEY=sk-... truman run --once -p anthropic # Anthropic
                         truman run --once -p ollama    # Ollama (free & local)
```

## Programmatic API

```typescript
import { SimulationEngine, HttpApiAdapter, createProvider } from 'truman-cli';

const engine = new SimulationEngine({
  families: ['./families/smiths.yaml'],
  adapter: new HttpApiAdapter('./adapter.json'),
  llmProvider: await createProvider({ type: 'ollama', model: 'llama3.1' }),
});

engine.on((event) => {
  if (event.type === 'member:frustrated') console.log('User quit:', event.memberId);
});

await engine.runOnce();
```

## What Truman is NOT

- **Not a load tester** — use k6
- **Not an E2E framework** — use Playwright
- **Not a monitoring agent** — use Datadog

Truman is the closest thing to putting real users in front of your app without actually doing it.

## Built with

Built by the team behind [ParentOS](https://github.com/Go-Pomegranate) — where we test our own app with synthetic families every day.

---

<p align="center">
<strong>Your app isn't hard to use.</strong><br/>
You're just the only one who knows where everything is.<br/><br/>
<code>npx truman-cli roast</code><br/><br/>
<a href="https://github.com/Go-Pomegranate/Truman">Star it</a> · <a href="https://discord.gg/wz25vvfdE3">Join Discord</a> · <a href="https://github.com/Go-Pomegranate/Truman/issues">Report a bug</a> · <a href="CONTRIBUTING.md">Contribute</a>
</p>

---

[Philosophy](PHILOSOPHY.md) · [Contributing](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [License](LICENSE)
