# Generic PlaywrightAdapter — Design Spec

## Problem

The current `PlaywrightAdapter` is hardcoded for ParentOS. It has:

- `BROWSER_ACTIONS` — a static list of ParentOS-specific actions (briefing, tasks, calendar, meals, wellness, finance)
- `authenticate()` — navigates to `/dashboard`, sends `X-Truman-Family` headers
- Action executors (`execCreateTask`, `execViewCalendar`, etc.) — all ParentOS-specific
- Polish-language selectors ("Dodaj", "Zapisz")

This means `truman roast --browser --url https://any-website.com` doesn't work. The adapter must be fully generic — it should work on any website without prior configuration.

## Design

### Architecture

Replace the hardcoded `PlaywrightAdapter` with a generic one that dynamically discovers what's on the page and lets the LLM decide what to do based on persona + visible elements.

```
Page loads
  → scanPage() discovers interactive elements
  → getAvailableActions() returns them as AvailableAction[]
  → LLM picks action based on persona + accessibility tree
  → executeAction() performs the generic browser action
  → page changes → repeat
```

### File changes

| File | Change |
|------|--------|
| `src/adapters/PlaywrightAdapter.ts` | Full rewrite — generic implementation |
| `src/cli.ts` | Already updated — no changes needed |
| `src/types.ts` | No changes — existing interfaces are sufficient |

No new files. No new dependencies. The existing `AppAdapter` interface works as-is.

### `authenticate(member, family) → AuthContext`

Minimal. No ParentOS-specific behavior.

1. Launch Chromium (headless or headed per config)
2. Create a new browser context per member (viewport 1280x800) — stored in a `Map<string, { context, page }>` keyed by `memberId` to support concurrent sessions
3. Navigate to `baseUrl`
4. Wait for `domcontentloaded` + 1s for SPA hydration
5. Take initial screenshot
6. Return `{ token: "truman-${member.id}", memberId: member.id, headers: {} }`

If the page has a login form, the NPC will encounter it as an available action and the LLM will decide whether to interact with it — just like a real user would.

### `getAvailableActions(ctx) → AvailableAction[]`

Dynamically scans the current page DOM. Returns real interactive elements as actions conforming to the `AvailableAction` interface.

#### How element metadata maps to `AvailableAction`

Each discovered element becomes an `AvailableAction` where:

- `name` — action type with index, e.g. `click-link-3`, `fill-input-1` (unique per scan)
- `description` — human-readable context for the LLM: `"Link: 'Contact Us' (href: /contact, in <nav>)"`
- `category` — derived from action type: `"navigation"` (links, go-back), `"interaction"` (buttons, checkboxes), `"form"` (inputs, selects), `"browser"` (scroll, wait)
- `params` — `ActionParam[]` schema describing what the LLM must provide:

For **click-link** and **click-button**:
```typescript
params: [
  { name: 'selector', type: 'string', required: true, description: 'CSS selector (use exactly as shown)', example: '#nav > a:nth-of-type(2)' }
]
```

For **fill-input**:
```typescript
params: [
  { name: 'selector', type: 'string', required: true, description: 'CSS selector (use exactly as shown)', example: 'input[name="email"]' },
  { name: 'value', type: 'string', required: true, description: 'Text to type into the input', example: 'user@example.com' }
]
```

For **select-option**:
```typescript
params: [
  { name: 'selector', type: 'string', required: true, description: 'CSS selector (use exactly as shown)', example: 'select#country' },
  { name: 'value', type: 'enum', required: true, description: 'Option to select', enumValues: ['Option A', 'Option B', 'Option C'] }
]
```

For **toggle-check**:
```typescript
params: [
  { name: 'selector', type: 'string', required: true, description: 'CSS selector (use exactly as shown)', example: 'input[type="checkbox"]#terms' }
]
```

For **scroll-down**, **scroll-up**, **go-back**, **wait**: `params: []`

The `selector` is embedded as a required param with `example` set to the actual selector value. The engine's `fillMissingRequiredParams` uses `example` as fallback, so even if the LLM omits the selector, the correct value is filled in. The LLM sees the selector in the action description and echoes it back.

#### Discovered element types

| DOM element | Action name pattern | Category |
|---|---|---|
| `<a href="...">` (visible, valid href) | `click-link-N` | `navigation` |
| `<button>`, `[role=button]`, `input[type=submit]` | `click-button-N` | `interaction` |
| `<input type=text/email/password/search/tel/url>`, `<textarea>` | `fill-input-N` | `form` |
| `<select>` | `select-option-N` | `form` |
| `input[type=checkbox]`, `input[type=radio]`, `[role=checkbox]` | `toggle-check-N` | `form` |
| `input[type=file]` | Skipped | — |

#### Static actions (always available)

| Action name | Category | Description |
|---|---|---|
| `scroll-down` | `browser` | Scroll down one viewport |
| `scroll-up` | `browser` | Scroll up one viewport |
| `go-back` | `navigation` | Browser back button |
| `wait` | `browser` | Observe the current page without acting |

#### Scanning rules

- Only visible, enabled elements (not `hidden`, `disabled`, `aria-hidden="true"`, or offscreen)
- Max 40 interactive elements per scan (prioritize: above-the-fold first, then by DOM order)
- Each element gets a unique stable selector: prefer `[data-testid]` > `#id` > `[aria-label]` > Playwright text selector > nth-of-type CSS path
- Links with `href` starting with `javascript:`, `mailto:`, `tel:`, `data:` are excluded
- Bare `#` links are excluded, but hash-route links (`#/path`) are kept (SPA routing)
- Duplicate texts are deduplicated (e.g., 10 "Read more" links become one action with description noting "10 similar links on page")
- `description` for each action includes: visible text, href (for links), parent landmark/heading context, and current state (for checkboxes)
- Element descriptions are truncated at 120 chars to control token budget

#### Action weight assignment

Fixed weight map by action type (simple, deterministic):

| Action type | Base weight |
|---|---|
| `click-button` | 8 |
| `fill-input` | 7 |
| `click-link` | 5 |
| `select-option` | 6 |
| `toggle-check` | 5 |
| `scroll-down/up` | 3 |
| `go-back` | 2 |
| `wait` | 1 |

### `executeAction(action, ctx) → ActionResult`

Generic executor. Resolves action type from `action.name` prefix (e.g., `click-link-3` → `click-link`). Every action result includes `duration: Date.now() - start`.

```
click-link-N / click-button-N:
  1. page.click(params.selector, { timeout: 8000 })
  2. Wait for navigation or DOM mutation (whichever comes first, max 8s)
  3. Return { success, duration, response: { url, title } }

fill-input-N:
  1. page.click(params.selector) to focus
  2. page.fill(params.selector, params.value)
  3. Return { success, duration, response: { filled: params.value } }

select-option-N:
  1. page.selectOption(params.selector, params.value)
  2. Return { success, duration }

toggle-check-N:
  1. page.click(params.selector)
  2. Return { success, duration, response: { toggled: true } }

scroll-down / scroll-up:
  1. page.evaluate(() => window.scrollBy(0, ±window.innerHeight * 0.8))
  2. Wait 300ms for lazy-loaded content
  3. Return { success, duration }

go-back:
  1. page.goBack({ timeout: 5000 })
  2. Return { success, duration, response: { url } }

wait:
  1. Wait 1s
  2. Return { success: true, duration: 1000 }
```

After every action:
- Take screenshot (saved to `screenshotDir/{NNN}-{memberId}-{actionName}.png`)
- Handle errors gracefully: if element is stale, detached, or timeout → return `{ success: false, error: "Element not found or page changed", duration }`
- For click actions: detect SPA navigation by comparing URL before/after + waiting for DOM mutation via `page.waitForLoadState('domcontentloaded')` or MutationObserver fallback

### `getAppState(ctx) → AppState`

Returns what the NPC "sees" on the current page:

```typescript
{
  summary: `
    Page: ${page.title()} (${pathname})

    Visible content:
    ${ariaSnapshot}  // via page.locator('body').ariaSnapshot() — depth 4, max 50 nodes

    Headings: ${h1Text} > ${h2Texts}

    ${errorMessages}  // any .error, [role=alert], .toast elements
  `,
  data: {
    url: page.url(),
    title: page.title(),
  }
}
```

Uses `page.locator('body').ariaSnapshot()` (Playwright 1.49+) instead of the deprecated `page.accessibility.snapshot()`. Falls back to `readPageContent()` (innerText extraction) if ariaSnapshot is unavailable.

Summary text is capped at 800 chars total.

### `cleanup(ctx) → void`

Closes the browser context for the member (looked up from the `Map<string, { context, page }>`). Does not close the browser itself — that happens in `close()`.

### `close() → void`

Closes the browser instance. Called once after the simulation ends.

### Safety limits

| Limit | Value | Reason |
|---|---|---|
| Max interactive elements per scan | 40 | Prevent token explosion in LLM prompt |
| Element description max length | 120 chars | Token budget per action |
| Action execution timeout | 8s | Prevent hanging on broken pages |
| Navigation timeout | 10s | Some pages are slow |
| Accessibility tree depth | 4 levels | Balance context vs token cost |
| Accessibility tree nodes | 50 max | Same |
| Page summary max length | 800 chars | Token budget |
| Screenshot retention | All, numbered | For debugging and reports |
| Blocked href patterns | `javascript:`, `mailto:`, `tel:`, `data:` | Security |
| Skipped input types | `file`, `hidden` | Not supported in v1 |

### Selector strategy

Finding elements reliably across arbitrary websites requires a stable selector strategy:

1. `[data-testid="value"]` — most stable, if present
2. `#unique-id` — if ID exists and is unique
3. `[aria-label="value"]` — accessibility attribute
4. `button:has-text("exact text")` — Playwright text selector (for buttons)
5. `a:has-text("exact text")` — for links
6. CSS path fallback: `main > div:nth-of-type(2) > button:nth-of-type(1)` — last resort

The selector is stored as the `example` value of the `selector` param in each action. This way the engine's `fillMissingRequiredParams` guarantees the correct selector even if the LLM omits it.

### Browser instance lifecycle

```
browser (one per adapter instance)
  └── context-member-A (one per authenticate() call)
  │     └── page-member-A
  └── context-member-B
        └── page-member-B
```

- `authenticate()` creates a new context + page, stores in `Map<string, { context, page }>`
- `getAvailableActions()`, `executeAction()`, `getAppState()` look up page via `ctx.auth.memberId`
- `cleanup()` closes the member's context (removes from map)
- `close()` closes the entire browser
- This supports concurrent member sessions (stress mode) without race conditions

### Config interface

```typescript
export interface PlaywrightAdapterConfig {
  baseUrl: string;
  headless?: boolean;        // default: true
  screenshotDir?: string;    // default: '.truman/screenshots'
  slowMo?: number;           // default: 0 (100 for headed)
}
```

Removed: `actionRoutes` (no longer needed — everything is dynamic).

### What gets deleted

All ParentOS-specific code:

- `BROWSER_ACTIONS` constant
- `DEFAULT_ACTION_ROUTES`
- `execBriefing()`, `execViewTasks()`, `execCreateTask()`, `execCompleteTask()`, `execViewCalendar()`, `execCreateEvent()`, `execGenericRead()`
- `httpFallback()` method
- `dismissOverlays()` — modals now appear as scannable actions
- ParentOS auth headers in `authenticate()`

### What stays (adapted)

- `flattenA11yTree()` — kept as fallback if `ariaSnapshot()` unavailable
- `takeScreenshot()` — generic, kept as-is
- `close()` — generic, kept as-is
- `readPageContent()` — kept as fallback for app state

## Edge cases

**SPA with client-side routing**: After `click-link`, detect URL change via comparing `page.url()` before and after. Wait for DOM mutation instead of `load` event. Hash-route links (`#/path`) are supported.

**Modals/overlays**: Scanned as part of `getAvailableActions()` — if a modal is open, its buttons/inputs appear in the action list. The LLM decides to interact with or dismiss it.

**Infinite scroll**: `scroll-down` triggers lazy loading. Next `getAvailableActions()` call picks up new elements.

**Cookie banners**: Appear as buttons in the scan. The LLM (in character) decides whether to accept, reject, or ignore.

**iframes**: Skipped in v1. Only scan the main frame.

**`input[type=file]`**: Skipped — excluded from scan results.

## Non-goals

- No crawling/spidering — NPC stays in the browser, one page at a time
- No JavaScript injection or DOM manipulation beyond standard Playwright actions
- No authentication flow automation — if login is needed, NPC interacts with the form like a real user
- No iframe support in v1
- No file upload support in v1
