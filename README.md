# truman

**Your app's users are fake. They just don't know it yet.**

AI-driven synthetic personas that live in your app on realistic schedules — not scripted bots clicking through it.

```
  You define personas          AI decides what they do          You get the truth
┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│ Anna, 38, organized  │    │ 7:02am — checks      │    │ ✓ 12 features used   │
│ checks app at 7am    │ →  │ briefing, creates 3   │ →  │ ✗ checkout broke 4x  │
│ patience: 4/5        │    │ tasks, plans weekend  │    │ ⚠ Anna frustrated    │
│                      │    │                       │    │   at calendar view   │
│ Kasia, 14, impatient │    │ 3:45pm — opens app,   │    │ ✗ Kasia quit after   │
│ checks after school  │    │ checks quests, rage-  │    │   2 actions (slow UI)│
│ patience: 2/5        │    │ quits after 2 actions │    │                      │
└──────────────────────┘    └──────────────────────┘    └──────────────────────┘
```

## Quickstart

```bash
npx @parentos/truman init my-app
cd my-app
```

This creates:

```
my-app/
├── adapter.json       # Your API endpoints
├── families/
│   └── smiths.yaml    # A starter family
└── truman.config.yaml
```

Edit `adapter.json` to point at your API:

```json
{
  "baseUrl": "http://localhost:3000/api",
  "actions": [
    {
      "name": "list-items",
      "method": "GET",
      "path": "/items",
      "description": "See all items",
      "category": "core",
      "params": []
    },
    {
      "name": "create-item",
      "method": "POST",
      "path": "/items",
      "description": "Create a new item",
      "category": "core",
      "params": [
        { "name": "title", "type": "string", "required": true, "description": "Item title" }
      ]
    }
  ]
}
```

Run:

```bash
# Preview what will happen (no API calls)
npx @parentos/truman preview

# Run once — each persona does one session
npx @parentos/truman run --once

# Run continuously — personas follow their schedules
npx @parentos/truman run
```

## Define a family

```yaml
id: smiths
name: The Smiths
timezone: America/New_York

members:
  - id: sarah
    name: Sarah
    role: parent
    patience: 4
    persona: >
      Sarah is organized. She checks the app every morning
      and gets annoyed when things take more than 2 taps.
    features: [items, dashboard]
    quirks:
      - Always checks dashboard first
      - Creates items with detailed descriptions
    schedule:
      - days: [mon, tue, wed, thu, fri]
        timeWindow: ["07:00", "07:30"]
        action: list-items
        probability: 0.9
```

The persona text and quirks are fed directly to the LLM. Write them like you'd describe a real person.

## How it works

```
Every tick:
  1. Scheduler checks who should act now (based on schedule + probability)
  2. Adapter fetches your app's current state
  3. PersonaBuilder constructs an in-character prompt
  4. LLM decides: what would this person do right now?
  5. Adapter executes the action against your API
  6. State updates: frustration, discovered features, memory

If frustration > 0.85 → persona walks away. Just like a real user.
```

## LLM providers

```bash
# OpenAI (default)
OPENAI_API_KEY=sk-... npx @parentos/truman run --once

# Anthropic
ANTHROPIC_API_KEY=sk-... npx @parentos/truman run --once -p anthropic

# Ollama (free, local)
npx @parentos/truman run --once -p ollama -m llama3.1
```

## Programmatic API

```typescript
import { SimulationEngine, HttpApiAdapter, createProvider } from '@parentos/truman';

const engine = new SimulationEngine({
  families: ['./families/smiths.yaml'],
  adapter: new HttpApiAdapter('./adapter.json'),
  llmProvider: await createProvider({ type: 'ollama', model: 'llama3.1' }),
  speed: 60,
  logDir: '.truman/logs',
  stateDir: '.truman/state',
});

engine.on((event) => {
  if (event.type === 'issue:detected') console.log('Bug:', event.issue);
  if (event.type === 'member:frustrated') console.log('User quit:', event.memberId);
});

await engine.runOnce();
console.log(engine.generateReport().summary);
```

## What you get back

```json
{
  "summary": {
    "totalActions": 47,
    "overallSuccessRate": 0.83,
    "criticalIssues": [
      { "action": "create-item", "error": "500 Internal Server Error", "frustration": 0.7 }
    ],
    "uxBlockers": [
      { "feature": "checkout", "affectedMembers": ["sarah", "mike"], "description": "Failed 4x across 2 members" }
    ]
  }
}
```

## Philosophy

Read [PHILOSOPHY.md](PHILOSOPHY.md).

TL;DR: E2E tests are scripted and stateless. Real users are neither. Truman gives you the closest thing to real users without real users.

## License

MIT — see [LICENSE](LICENSE).
