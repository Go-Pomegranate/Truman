# Commands Reference

## `truman run`

Run a full simulation. NPCs follow their schedules and interact with your app.

```bash
# Basics
truman run -f families/smiths.yaml -a adapter.json --once
truman run -f families/*.yaml -a adapter.json

# Multiple families
truman run -f families/power-users.yaml families/casual.yaml -a adapter.json --once

# Continuous mode — NPCs follow their schedules (7am check, lunch browse, etc.)
truman run -f families/*.yaml -a adapter.json

# Stress test — all NPCs fire in parallel
truman run -f families/*.yaml -a adapter.json --stress
```

### Flags

| Flag | Default | Description |
|---|---|---|
| `-f, --families <paths...>` | *(required)* | Path(s) to family YAML configs |
| `-a, --adapter <path>` | `./adapter.json` | Adapter config (JSON or YAML) |
| `-p, --provider <type>` | `openai` | LLM provider: `openai`, `anthropic`, `ollama` |
| `-m, --model <name>` | `gpt-4o-mini` | LLM model name |
| `--once` | `false` | One session per NPC, then exit |
| `--stress` | `false` | All NPCs run in parallel (concurrent API load) |
| `--concurrency <n>` | `3` | Max concurrent NPC sessions |
| `-s, --speed <n>` | `1` | Time multiplier (`1` = realtime, `60` = 1min simulates 1hr) |
| `--tick <ms>` | `60000` | How often the scheduler checks for due tasks |

### Browser mode

NPCs navigate your real UI via Playwright instead of hitting the API directly.

```bash
truman run -f families/*.yaml --browser              # headless
truman run -f families/*.yaml --browser --headed      # you see the browser
```

| Flag | Description |
|---|---|
| `--browser` | Use Playwright adapter — NPCs navigate real UI |
| `--headed` | Show browser window (implies `--browser`) |

Requires `playwright` as a peer dependency: `npm install playwright`

### Voice narration

NPCs speak out loud while using your app. Each NPC gets a unique voice from a pool of 17.

```bash
truman run --once --voice                 # auto-detect best TTS backend
truman run --once --voice edge            # force edge-tts (best quality)
truman run --once --voice say             # force macOS say
truman run --once --voice espeak          # force espeak-ng
truman run --once --soundscape            # voices overlap as frustration builds
```

| Flag | Description |
|---|---|
| `--voice [backend]` | Enable voice narration. Backends: `auto`, `say`, `edge`, `espeak`, `piper` |
| `--soundscape` | Soundscape mode — multiple voices play simultaneously |
| `--piper-model <path>` | Piper model name/path (default: `en_US-lessac-medium`) |

**Setup:**

| Backend | Install | Platform | Quality |
|---|---|---|---|
| `edge-tts` | `pip install edge-tts` | Any (needs internet) | Natural, best |
| `say` | Built-in | macOS only | Robotic, fun |
| `espeak-ng` | `brew install espeak-ng` / `apt install espeak-ng` | Any | Robotic |
| `piper` | `pip install piper-tts` | Linux/macOS | Good, fully offline |

### Output & export

```bash
truman run --once --export-bugs bugs.json       # structured bug reports (JSON)
truman run --once --export-bugs bugs.md          # bug reports as Markdown
truman run --once --export session.json          # full session timeline (for web player)
truman run --once --junit results.xml            # JUnit XML (for CI)
truman run --once --record session.cast          # terminal recording (asciinema)
truman run --once --live                         # animated terminal dashboard
```

| Flag | Description |
|---|---|
| `--export-bugs <path>` | Export bugs as `.json` or `.md` |
| `--export <path>` | Export session timeline as JSON |
| `--junit <path>` | JUnit XML report for CI pipelines |
| `--record <path>` | Record terminal session (asciinema `.cast` format) |
| `--live` | Show animated dashboard instead of scrolling log |
| `--log-dir <path>` | Directory for action logs (default: `.truman/logs`) |
| `--state-dir <path>` | Directory for persistent NPC state (default: `.truman/state`) |

---

## `truman roast`

Three brutal personas roast your app. Auto-exports `bugs.json`.

```bash
truman roast -a adapter.json                        # use existing adapter
truman roast --url http://localhost:3000/api          # auto-probe your API
truman roast -a adapter.json --voice                  # hear them judge you
truman roast -a adapter.json -p ollama -m llama3.1    # use local LLM
```

The roast crew:
- **Jaden** (patience: 1) — Gen Z intern. Rage-quits if anything takes over 2 seconds.
- **Linda** (patience: 4) — Your mom. Reads every tooltip. Taps the logo expecting it to do something.
- **Wei** (patience: 5) — Senior engineer. Pastes Unicode everywhere. Tries SQL injection.

Output: report + `.truman/roast/bugs.json`

| Flag | Default | Description |
|---|---|---|
| `-a, --adapter <path>` | — | Path to existing adapter.json |
| `--url <baseUrl>` | — | Base URL to auto-probe endpoints |
| `-p, --provider` | `openai` | LLM provider |
| `-m, --model` | `gpt-4o-mini` | LLM model |
| `--voice [backend]` | `auto` | Voice narration (enabled by default in roast) |

---

## `truman init`

Scaffold adapter + sample family for your app.

```bash
truman init my-app                                    # empty scaffold
truman init my-app --url http://localhost:3000/api     # probes your API, generates matching adapter
truman init my-app --swagger openapi.json              # generates from OpenAPI/Swagger spec
```

| Flag | Description |
|---|---|
| `-d, --dir <path>` | Output directory (default: `.`) |
| `--url <baseUrl>` | Probe this URL for API endpoints |
| `--swagger <path>` | Generate adapter from OpenAPI spec |

Generated files:
```
my-app/
  adapter.json         # your API actions
  families/
    default.yaml       # starter family with 3 members
```

---

## `truman validate`

Check that your family YAML configs are valid.

```bash
truman validate families/*.yaml
truman validate families/smiths.yaml families/power-users.yaml
```

Checks: required fields, schedule format, role types, patience range, member IDs.

---

## `truman preview`

Dry run — shows what NPCs would do and when, without making any API calls.

```bash
truman preview -f families/*.yaml
truman preview -f families/*.yaml -n 30    # show 30 upcoming tasks
```

| Flag | Default | Description |
|---|---|---|
| `-f, --families <paths...>` | *(required)* | Family configs |
| `-n, --count <number>` | `20` | How many upcoming tasks to show |

---

## `truman report`

Re-generate a simulation report from saved action logs.

```bash
truman report --log-dir .truman/logs
```

| Flag | Default | Description |
|---|---|---|
| `--log-dir <path>` | `.truman/logs` | Directory containing JSONL action logs |

---

## Bug export format

Every `--export-bugs` and `roast` produces structured bug reports:

```json
{
  "title": "view-wellness fails with HTTP 500 (3 NPCs affected)",
  "description": "The action view-wellness consistently fails...",
  "module": "wellness",
  "severity": 1,
  "stepsToReproduce": "1. Execute check-briefing → OK\n2. Execute view-wellness → FAIL",
  "expectedBehavior": "view-wellness should complete successfully and return valid data.",
  "reporter": "truman",
  "reporterPlatform": "truman-simulation",
  "aiAnalysis": {
    "source": "truman",
    "affectedMembers": ["Jaden", "Linda", "Wei"],
    "affectedRoles": ["teen", "parent"],
    "frustrationImpact": 0.42,
    "failureCount": 6,
    "suggestedFiles": ["routes/wellness*", "services/wellness*"],
    "actionCategory": "wellness",
    "sessionContext": "check-briefing(ok) → view-wellness(fail) → view-wellness(fail)"
  }
}
```

**Severity scale:**
| Level | Meaning | Trigger |
|---|---|---|
| 1 | Critical | 3+ NPCs hit the same bug |
| 2 | High | 2 NPCs affected, or causes rage-quit |
| 3 | Medium | Single NPC, moderate frustration |
| 4 | Low | Single NPC, low frustration |

Module and suggested files are derived from your adapter's action categories and API paths — no hardcoded app knowledge.
