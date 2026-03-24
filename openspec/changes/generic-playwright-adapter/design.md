## Context

The `PlaywrightAdapter` currently implements `AppAdapter` with hardcoded ParentOS actions — briefing, tasks, calendar, meals, wellness, finance. It uses a shared single `Page` instance, ParentOS-specific auth headers, and the deprecated `page.accessibility.snapshot()` API.

The `SimulationEngine` calls adapter methods in a loop: `authenticate` → `getAvailableActions` + `getAppState` (parallel) → LLM decides → `executeAction` → repeat (max 10 actions). The `AppAdapter` interface (`src/types.ts`) requires no changes — the existing contract supports this refactor.

## Goals / Non-Goals

**Goals:**
- `PlaywrightAdapter` works on any website without configuration
- `getAvailableActions()` dynamically scans the DOM for interactive elements
- `executeAction()` performs generic browser actions (click, fill, select, scroll)
- Support concurrent member sessions (stress mode)
- Use modern Playwright APIs (`ariaSnapshot()`) with fallback

**Non-Goals:**
- No iframe support (v1)
- No file upload support (v1)
- No automatic authentication — NPC interacts with login forms like a real user
- No crawling/spidering — one page at a time, NPC navigates naturally

## Decisions

### 1. Dynamic DOM scanning over static action lists

**Choice**: Scan page for visible interactive elements on every `getAvailableActions()` call.

**Why**: Static action lists require per-app configuration. Dynamic scanning makes Truman work out of the box on any website. The LLM receives real elements with selectors and decides based on persona.

**Alternative considered**: Pre-crawl the site to build an action map. Rejected — adds complexity, requires waiting, and NPC should discover pages naturally like a real user.

### 2. Selector as required param with `example` fallback

**Choice**: Each scanned element's CSS selector is stored as a required `ActionParam` with `example` set to the actual selector value. The engine's `fillMissingRequiredParams` uses `example` as fallback if LLM omits it.

**Why**: The `AvailableAction.params` field is `ActionParam[]` (schema, not values). Embedding the selector as a param with its real value in `example` lets the LLM echo it back, with the engine guaranteeing correctness via fallback.

**Alternative considered**: Custom field on AvailableAction. Rejected — would require changes to `src/types.ts` and `SimulationEngine`.

### 3. Per-member browser contexts via Map

**Choice**: `Map<string, { context: BrowserContext, page: Page }>` keyed by `memberId`. Each `authenticate()` call creates a new context.

**Why**: The current single `page` field causes race conditions in stress mode (parallel members). Separate contexts give each NPC isolated cookies, storage, and viewport.

**Alternative considered**: Single page with sequential access. Rejected — breaks parallel execution.

### 4. Action type prefix naming

**Choice**: Actions named `click-link-N`, `fill-input-N`, etc. `executeAction` extracts the action type from the prefix (everything before the last `-N`).

**Why**: Each page scan produces different elements, so action names must be unique per scan. The prefix pattern lets the executor route to the correct handler without a lookup table.

### 5. Fixed weight map over computed weights

**Choice**: Simple weight map: `click-button: 8`, `fill-input: 7`, `click-link: 5`, etc.

**Why**: Computing weights from element size, position, and styles adds complexity for marginal gain. Fixed weights by action type are predictable and sufficient — the LLM already uses persona context to make contextually appropriate choices.

### 6. `ariaSnapshot()` with `flattenA11yTree` fallback

**Choice**: Use `page.locator('body').ariaSnapshot()` (Playwright 1.49+) for `getAppState()`. Fall back to the deprecated `page.accessibility.snapshot()` + `flattenA11yTree()` if unavailable.

**Why**: `ariaSnapshot()` is the modern replacement. Keeping the fallback avoids forcing a Playwright version bump.

## Risks / Trade-offs

**[Token explosion from large pages]** → Cap at 40 interactive elements per scan. Truncate descriptions at 120 chars. Summary text capped at 800 chars.

**[Stale selectors after DOM mutation]** → If `executeAction` fails on a stale selector, return failure. Next `getAvailableActions` call rescans the page.

**[SPAs with client-side routing]** → After click actions, detect URL change by comparing before/after. Wait for DOM mutation rather than full page load.

**[Cookie banners/modals blocking content]** → These elements appear in the scan. The LLM (in character) decides to interact with them — no special handling needed.

**[Breaking change for ParentOS users]** → The hardcoded ParentOS adapter is removed. ParentOS should switch to `HttpApiAdapter` or maintain a fork of the old PlaywrightAdapter. This is acceptable since PlaywrightAdapter was never documented as a public API.
