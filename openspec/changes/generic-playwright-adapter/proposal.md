## Why

The current `PlaywrightAdapter` is hardcoded for ParentOS — static action list (briefing, tasks, calendar, meals), ParentOS auth headers, Polish-language selectors. `truman roast --browser --url https://any-website.com` doesn't work. The adapter must be fully generic to work on any website without prior configuration.

## What Changes

- **BREAKING**: Replace hardcoded `BROWSER_ACTIONS` with dynamic DOM scanning that discovers interactive elements on any page
- **BREAKING**: Remove all ParentOS-specific action executors (`execBriefing`, `execCreateTask`, `execViewCalendar`, etc.)
- **BREAKING**: Remove `httpFallback()` method and `actionRoutes` config option
- Replace single shared `page` with per-member `Map<string, { context, page }>` for concurrent session support
- Replace deprecated `page.accessibility.snapshot()` with `page.locator('body').ariaSnapshot()`
- Generic `authenticate()` — navigate to URL as anonymous user, no custom headers
- Generic `executeAction()` — click, fill, select, scroll, go-back based on action type prefix

## Capabilities

### New Capabilities
- `dynamic-page-scanning`: Scan any webpage's DOM to discover interactive elements (links, buttons, inputs, selects, checkboxes) and return them as `AvailableAction[]`
- `generic-browser-actions`: Execute generic browser actions (click, fill, select, scroll, navigate back) on any website using CSS selectors from the scan

### Modified Capabilities

## Impact

- `src/adapters/PlaywrightAdapter.ts` — full rewrite
- `src/cli.ts` — already updated with `--browser`/`--headed` flags (no further changes)
- No changes to `src/types.ts` — existing `AppAdapter` interface is sufficient
- No new dependencies — Playwright remains an optional peer dependency
- Existing `HttpApiAdapter` is unaffected
- Requires Playwright 1.49+ for `ariaSnapshot()` (fallback to `flattenA11yTree` for older versions)
