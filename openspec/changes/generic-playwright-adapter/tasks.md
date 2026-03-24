## 1. Scaffold generic adapter structure

- [ ] 1.1 Replace class fields: remove `page`, `httpBaseUrl`, add `sessions: Map<string, { context, page }>`, keep `browser`, `screenshotDir`, `screenshotIdx`
- [ ] 1.2 Update `PlaywrightAdapterConfig` — remove `actionRoutes`, keep `baseUrl`, `headless`, `screenshotDir`, `slowMo`
- [ ] 1.3 Delete all ParentOS-specific code: `BROWSER_ACTIONS`, `DEFAULT_ACTION_ROUTES`, `httpFallback()`, `dismissOverlays()`, all `exec*()` methods

## 2. Implement authenticate()

- [ ] 2.1 Launch browser on first call (reuse existing if present)
- [ ] 2.2 Create new browser context per member with viewport 1280x800, store in `sessions` map keyed by `memberId`
- [ ] 2.3 Navigate to `baseUrl`, wait for `domcontentloaded` + 1s hydration
- [ ] 2.4 Take initial screenshot, return `{ token: "truman-${member.id}", memberId: member.id, headers: {} }`

## 3. Implement scanPage() — dynamic DOM scanning

- [ ] 3.1 Create `private async scanPage(page: Page): Promise<ScannedElement[]>` that runs `page.evaluate()` to extract all visible interactive elements
- [ ] 3.2 Inside evaluate: collect `<a>`, `<button>`, `[role=button]`, `input[type=submit]`, text inputs, `<textarea>`, `<select>`, checkboxes, radios
- [ ] 3.3 Filter: only visible + enabled, exclude `input[type=file]`, `input[type=hidden]`, blocked href patterns (`javascript:`, `mailto:`, `tel:`, `data:`, bare `#`)
- [ ] 3.4 Keep hash-route links (`#/...`) for SPA support
- [ ] 3.5 For each element: extract tag, type, text content, href, placeholder, label, checked state, select options
- [ ] 3.6 Generate stable selector per element: `[data-testid]` > `#id` > `[aria-label]` > text-based > CSS path fallback
- [ ] 3.7 Cap at 40 elements, above-the-fold first (sort by `getBoundingClientRect().top`)
- [ ] 3.8 Deduplicate elements with identical text (note "N similar" in description)

## 4. Implement getAvailableActions()

- [ ] 4.1 Look up page from `sessions` map via `ctx.auth.memberId`
- [ ] 4.2 Call `scanPage()`, map `ScannedElement[]` to `AvailableAction[]`
- [ ] 4.3 Map element types to action names: `click-link-N`, `click-button-N`, `fill-input-N`, `select-option-N`, `toggle-check-N`
- [ ] 4.4 Set `category`: `navigation` (links, go-back), `interaction` (buttons), `form` (inputs, selects, checkboxes), `browser` (scroll, wait)
- [ ] 4.5 Build `ActionParam[]` per action type: `selector` (required, example=actual selector), `value` (required for fill-input, type string), `value` (required for select-option, type enum with enumValues)
- [ ] 4.6 Set fixed weights: click-button 8, fill-input 7, select-option 6, click-link 5, toggle-check 5, scroll 3, go-back 2, wait 1
- [ ] 4.7 Append static actions: `scroll-down`, `scroll-up`, `go-back`, `wait`
- [ ] 4.8 Truncate action descriptions at 120 chars

## 5. Implement executeAction()

- [ ] 5.1 Look up page from `sessions` map, extract action type from name prefix (strip `-N` suffix)
- [ ] 5.2 Implement `click-link` / `click-button`: `page.click(selector)`, wait for navigation or DOM change (8s timeout)
- [ ] 5.3 Implement `fill-input`: `page.click(selector)` then `page.fill(selector, params.value)`
- [ ] 5.4 Implement `select-option`: `page.selectOption(selector, params.value)`
- [ ] 5.5 Implement `toggle-check`: `page.click(selector)`
- [ ] 5.6 Implement `scroll-down` / `scroll-up`: `window.scrollBy(0, ±innerHeight * 0.8)`, wait 300ms
- [ ] 5.7 Implement `go-back`: `page.goBack({ timeout: 5000 })`
- [ ] 5.8 Implement `wait`: sleep 1s
- [ ] 5.9 Wrap all actions in try/catch — stale elements return `{ success: false, error }`
- [ ] 5.10 Take screenshot after every action, track `duration` on all return paths

## 6. Implement getAppState()

- [ ] 6.1 Try `page.locator('body').ariaSnapshot()` for accessibility tree
- [ ] 6.2 Fall back to deprecated `page.accessibility.snapshot()` + `flattenA11yTree()` if ariaSnapshot unavailable
- [ ] 6.3 Extract page title, pathname, h1-h3 headings, error/alert elements
- [ ] 6.4 Build summary string, cap at 800 chars
- [ ] 6.5 Return `{ summary, data: { url, title } }`

## 7. Implement cleanup() and close()

- [ ] 7.1 `cleanup()`: close member's browser context, remove from `sessions` map
- [ ] 7.2 `close()`: close browser instance, clear `sessions` map

## 8. Build and test

- [ ] 8.1 Run `pnpm build` — verify no TypeScript errors
- [ ] 8.2 Test `truman roast --browser --url https://strzelnica-pukawka.pl` — verify NPC navigates and interacts
- [ ] 8.3 Verify screenshots are saved to `.truman/roast/screenshots/`
- [ ] 8.4 Test headed mode: `truman roast --headed --url https://strzelnica-pukawka.pl`
