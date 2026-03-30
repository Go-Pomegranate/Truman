import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright";
import type {
	ActionContext,
	ActionParam,
	ActionResult,
	AppAdapter,
	AppState,
	AuthContext,
	AvailableAction,
	ChosenAction,
	FamilyConfig,
	MemberConfig,
} from "../types.js";

// ─── Config ─────────────────────────────────────────────────────

export interface PlaywrightAdapterConfig {
	baseUrl: string;
	headless?: boolean;
	screenshotDir?: string;
	slowMo?: number;
	/** Send screenshots to LLM for visual understanding */
	vision?: boolean;
}

// ─── Internal types ─────────────────────────────────────────────

interface ScannedElement {
	tag: string;
	type: string; // 'link' | 'button' | 'text-input' | 'select' | 'checkbox'
	text: string;
	selector: string;
	href?: string;
	placeholder?: string;
	label?: string;
	inputType?: string;
	checked?: boolean;
	options?: string[];
	top: number; // for above-the-fold sorting
}

interface MemberSession {
	context: BrowserContext;
	page: Page;
	consoleErrors: string[];
	failedRequests: string[];
}

// ─── Weight map ─────────────────────────────────────────────────

const ACTION_WEIGHTS: Record<string, number> = {
	"click-button": 8,
	"fill-input": 7,
	"select-option": 6,
	"click-link": 5,
	"toggle-check": 5,
	"scroll-down": 3,
	"scroll-up": 3,
	"go-back": 2,
	wait: 1,
};

// ─── Blocked href patterns ──────────────────────────────────────

const BLOCKED_HREF_RE = /^(javascript:|mailto:|tel:|data:)|(^#$)/;

// ─── Max limits ─────────────────────────────────────────────────

const MAX_ELEMENTS = 40;
const MAX_DESCRIPTION_LEN = 120;
const MAX_SUMMARY_LEN = 1600;
const ACTION_TIMEOUT = 8000;
const NAV_TIMEOUT = 10000;

/**
 * Generic browser adapter — NPC navigates any website via Playwright.
 * Dynamically scans the page for interactive elements on every turn.
 * Works on any website without configuration.
 */
export class PlaywrightAdapter implements AppAdapter {
	name = "playwright";
	baseUrl: string;
	private config: PlaywrightAdapterConfig;
	private browser: Browser | null = null;
	private sessions = new Map<string, MemberSession>();
	private screenshotDir: string;
	private screenshotIdx = 0;

	constructor(config: PlaywrightAdapterConfig) {
		this.config = config;
		this.baseUrl = config.baseUrl.replace(/\/$/, "");
		this.screenshotDir = config.screenshotDir ?? ".truman/screenshots";
		if (!existsSync(this.screenshotDir)) {
			mkdirSync(this.screenshotDir, { recursive: true });
		}
	}

	// ─── authenticate ───────────────────────────────────────────

	async authenticate(member: MemberConfig, _family: FamilyConfig): Promise<AuthContext> {
		if (!this.browser) {
			try {
				this.browser = await chromium.launch({
					headless: this.config.headless ?? true,
					slowMo: this.config.slowMo,
				});
			} catch (err: any) {
				if (err?.message?.includes("Executable doesn't exist")) {
					console.log("\n  🎭 Chromium not found — installing automatically...");
					try {
						// Resolve the playwright CLI from the same node_modules as the imported package
						// so npx-installed truman-cli uses its own playwright, not a global one
						const require = createRequire(import.meta.url);
						const playwrightPkg = dirname(require.resolve("playwright/package.json"));
						const playwrightCli = join(playwrightPkg, "cli.js");
						execSync(`node "${playwrightCli}" install chromium`, { stdio: "pipe", timeout: 120_000 });
						console.log("  ✓ Chromium installed.\n");
					} catch {
						throw new Error("Failed to auto-install Chromium. Run manually: npx playwright install chromium");
					}
					this.browser = await chromium.launch({
						headless: this.config.headless ?? true,
						slowMo: this.config.slowMo,
					});
				} else {
					throw err;
				}
			}
		}

		const context = await this.browser.newContext({
			viewport: { width: 1280, height: 800 },
		});
		const page = await context.newPage();

		// Capture console errors, JS exceptions, and failed network requests
		const consoleErrors: string[] = [];
		const failedRequests: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "error") {
				consoleErrors.push(msg.text().slice(0, 200));
			}
		});
		page.on("pageerror", (err) => {
			consoleErrors.push(`JS Exception: ${err.message.slice(0, 200)}`);
		});
		page.on("requestfailed", (req) => {
			const url = req.url();
			const failure = req.failure()?.errorText ?? "unknown";
			// Categorize by resource type for clarity
			const type = req.resourceType(); // document, image, script, stylesheet, fetch, xhr...
			if (type !== "other") {
				failedRequests.push(`${type}: ${url.slice(0, 120)} (${failure})`);
			}
		});

		this.sessions.set(member.id, { context, page, consoleErrors, failedRequests });

		await page.goto(this.baseUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
		await page.waitForTimeout(1000);
		await this.takeScreenshot(page, `${member.id}-start`);

		return {
			token: `truman-${member.id}`,
			memberId: member.id,
			headers: {},
		};
	}

	// ─── getAvailableActions ────────────────────────────────────

	async getAvailableActions(ctx: ActionContext): Promise<AvailableAction[]> {
		const page = this.getPage(ctx);
		if (!page) return STATIC_ACTIONS;

		const elements = await this.scanPage(page);
		const actions: AvailableAction[] = [];

		for (let i = 0; i < elements.length; i++) {
			const el = elements[i];
			const action = this.elementToAction(el, i);
			if (action) actions.push(action);
		}

		return [...actions, ...STATIC_ACTIONS];
	}

	// ─── executeAction ──────────────────────────────────────────

	async executeAction(action: ChosenAction, ctx: ActionContext): Promise<ActionResult> {
		const page = this.getPage(ctx);
		if (!page) return { success: false, error: "No browser page", duration: 0 };

		const start = Date.now();
		const actionType = this.getActionType(action.name);
		const selector = String(action.params.selector ?? "");

		// Handle iframe elements — click by text inside the frame
		if (selector.startsWith("iframe[")) {
			try {
				const actionText = action.name; // e.g. click-button-42
				const desc = (action as any).description ?? "";
				// Extract the text from the action description to find element in iframe
				const textMatch = desc.match(/\[iframe\]\s*(.+?)"/)?.[1] ?? "";
				const result = await this.execIframeClick(page, selector, textMatch || actionType);
				result.duration = Date.now() - start;
				await this.takeScreenshot(page, `${ctx.member.id}-${action.name}`);
				return result;
			} catch (err) {
				return {
					success: false,
					error: `iframe action failed: ${err instanceof Error ? err.message : String(err)}`,
					duration: Date.now() - start,
				};
			}
		}

		try {
			let result: ActionResult;

			// Reject empty selectors — element likely disappeared after navigation
			const needsSelector = ["click-link", "click-button", "fill-input", "select-option", "toggle-check"];
			if (needsSelector.includes(actionType) && !selector?.trim()) {
				return {
					success: false,
					error: "Element no longer exists on page (stale selector)",
					duration: Date.now() - start,
				};
			}

			switch (actionType) {
				case "click-link":
				case "click-button":
					result = await this.execClick(page, selector);
					break;
				case "fill-input":
					result = await this.execFill(page, selector, String(action.params.value ?? ""));
					break;
				case "select-option":
					result = await this.execSelect(page, selector, String(action.params.value ?? ""));
					break;
				case "toggle-check":
					result = await this.execToggle(page, selector);
					break;
				case "scroll-down":
					result = await this.execScroll(page, 1);
					break;
				case "scroll-up":
					result = await this.execScroll(page, -1);
					break;
				case "go-back":
					result = await this.execGoBack(page);
					break;
				case "wait":
					await page.waitForTimeout(1000);
					result = { success: true, duration: 1000 };
					break;
				default:
					result = { success: false, error: `Unknown action type: ${actionType}`, duration: 0 };
			}

			result.duration = Date.now() - start;
			await this.takeScreenshot(page, `${ctx.member.id}-${action.name}`);
			return result;
		} catch (err) {
			const duration = Date.now() - start;
			await this.takeScreenshot(page, `${ctx.member.id}-${action.name}-error`).catch(() => {});
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
				duration,
			};
		}
	}

	// ─── getAppState ────────────────────────────────────────────

	async getAppState(ctx: ActionContext): Promise<AppState> {
		const page = this.getPage(ctx);
		if (!page) return { summary: "No browser page", data: {} };

		try {
			const url = page.url();
			const title = await page.title();
			const pathname = new URL(url).pathname;

			// Try modern ariaSnapshot first, fall back to deprecated API, then innerText
			let a11y = "";
			try {
				a11y = await page.locator("body").ariaSnapshot();
			} catch {
				try {
					// @ts-expect-error — deprecated but functional in older Playwright
					const snapshot = await page.accessibility.snapshot();
					a11y = this.flattenA11yTree(snapshot, 0, 3);
				} catch {
					a11y = await this.readPageContent(page);
				}
			}

			// Extract headings
			const headings = await page
				.evaluate(() => {
					const hs = Array.from(document.querySelectorAll("h1, h2, h3"));
					return hs
						.slice(0, 10)
						.map((h) => h.textContent?.trim() ?? "")
						.filter(Boolean);
				})
				.catch(() => [] as string[]);

			// Extract error/alert messages
			const errors = await page
				.evaluate(() => {
					const els = Array.from(document.querySelectorAll('[role="alert"], .error, .toast, .notification'));
					return els
						.slice(0, 5)
						.map((e) => e.textContent?.trim() ?? "")
						.filter(Boolean);
				})
				.catch(() => [] as string[]);

			// Detect page-level issues via DOM inspection
			const pageIssues = await page
				.evaluate((baseUrlOrigin: string) => {
					const issues: string[] = [];

					// Broken images (loaded but failed — naturalWidth is 0 for broken images)
					const imgs = document.querySelectorAll("img");
					let brokenCount = 0;
					const missingAlt: string[] = [];
					for (const img of imgs) {
						if (img.complete && img.naturalWidth === 0 && img.src) brokenCount++;
						if (!img.getAttribute("alt") && img.src) missingAlt.push(img.src.slice(0, 60));
					}
					if (brokenCount > 0) issues.push(`${brokenCount} broken image(s) on page`);
					if (missingAlt.length > 0) issues.push(`${missingAlt.length} image(s) missing alt text`);

					// Loading spinners / skeleton screens / busy states
					const loadingIndicators = document.querySelectorAll(
						'[aria-busy="true"], .spinner, .loading, .skeleton, [class*="skeleton"], [class*="spinner"], [class*="loading"], [role="progressbar"]',
					);
					if (loadingIndicators.length > 0)
						issues.push(`Page appears to still be loading (${loadingIndicators.length} loading indicator(s) visible)`);

					// Empty states
					const emptyStates = document.querySelectorAll(
						'[class*="empty-state"], [class*="no-results"], [class*="empty-list"], [class*="nothing-found"]',
					);
					if (emptyStates.length > 0) issues.push("Page shows an empty state — no content to display");

					// Inputs without labels (accessibility)
					const unlabeledInputs = Array.from(
						document.querySelectorAll("input:not([type=hidden]):not([type=submit])"),
					).filter((input) => {
						const el = input as HTMLInputElement;
						if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")) return false;
						if (el.id && document.querySelector(`label[for="${el.id}"]`)) return false;
						if (el.closest("label")) return false;
						return true;
					});
					if (unlabeledInputs.length > 0)
						issues.push(`${unlabeledInputs.length} input(s) without labels (accessibility issue)`);

					// Detect if we left the original domain
					if (baseUrlOrigin && !window.location.origin.includes(new URL(baseUrlOrigin).hostname)) {
						issues.push(`⚠️ NAVIGATED TO EXTERNAL DOMAIN: ${window.location.origin} (left the app)`);
					}

					// Detect overlay/modal blocking content
					const overlays = document.querySelectorAll(
						'[class*="overlay"], [class*="modal"], [class*="backdrop"], [role="dialog"], [class*="cookie"], [class*="consent"], [class*="popup"]',
					);
					const visibleOverlays = Array.from(overlays).filter((el) => {
						const style = getComputedStyle(el);
						return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
					});
					if (visibleOverlays.length > 0)
						issues.push(`${visibleOverlays.length} overlay/modal visible — may be blocking content`);

					return issues;
				}, this.baseUrl)
				.catch(() => [] as string[]);

			// Detect 404 / error pages — only match when title or h1 is clearly a 404
			// (not just containing "404" somewhere in content, which causes false positives in SPAs)
			const is404 =
				/^\s*(404|not found|page not found|nie znaleziono|strona nie istnieje)\s*$/i.test(title) ||
				(headings[0] && /^\s*(404|not found|page not found|nie znaleziono)\s*$/i.test(headings[0]));

			// Collect and drain console errors and failed requests since last check
			const session = this.sessions.get(ctx.auth.memberId);
			const consoleErrors = session?.consoleErrors?.splice(0) ?? [];
			const failedRequests = session?.failedRequests?.splice(0) ?? [];

			let summary = `Page: ${title} (${pathname})\n\n`;
			if (is404) summary += `⚠️ THIS IS A 404 PAGE — the URL ${url} does not exist.\n\n`;
			if (consoleErrors.length > 0) {
				const uniqueErrors = [...new Set(consoleErrors)].slice(0, 5);
				summary += `🔴 BROWSER CONSOLE ERRORS:\n${uniqueErrors.map((e) => `  - ${e}`).join("\n")}\n\n`;
			}
			if (failedRequests.length > 0) {
				const uniqueReqs = [...new Set(failedRequests)].slice(0, 5);
				summary += `🔴 FAILED NETWORK REQUESTS:\n${uniqueReqs.map((r) => `  - ${r}`).join("\n")}\n\n`;
			}
			if (pageIssues.length > 0) {
				summary += `⚠️ PAGE ISSUES:\n${pageIssues.map((i) => `  - ${i}`).join("\n")}\n\n`;
			}
			if (headings.length) summary += `Headings: ${headings.join(" > ")}\n\n`;
			if (errors.length) summary += `Alerts: ${errors.join("; ")}\n\n`;
			summary += `Visible content:\n${a11y}`;

			// Capture screenshot as base64 for vision mode
			let screenshot: string | undefined;
			if (this.config.vision) {
				try {
					const buf = await page.screenshot({ fullPage: false, type: "jpeg", quality: 60 });
					screenshot = buf.toString("base64");
				} catch {
					/* ignore */
				}
			}

			return {
				summary: summary.slice(0, MAX_SUMMARY_LEN),
				data: { url, title },
				screenshot,
			};
		} catch {
			return { summary: "Could not read page", data: {} };
		}
	}

	// ─── cleanup / close ───────────────────────────────────────

	async cleanup(ctx: ActionContext): Promise<void> {
		const session = this.sessions.get(ctx.auth.memberId);
		if (session) {
			await session.context.close().catch(() => {});
			this.sessions.delete(ctx.auth.memberId);
		}
	}

	async close(): Promise<void> {
		for (const [id, session] of this.sessions) {
			await session.context.close().catch(() => {});
			this.sessions.delete(id);
		}
		if (this.browser) {
			await this.browser.close();
			this.browser = null;
		}
	}

	// ─── Page scanning ─────────────────────────────────────────

	private async scanPage(page: Page): Promise<ScannedElement[]> {
		const elements: ScannedElement[] = await page.evaluate(() => {
			const results: any[] = [];
			const seen = new Set<string>();

			function isVisible(el: Element): boolean {
				const style = getComputedStyle(el);
				if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
				if ((el as HTMLElement).offsetWidth === 0 && (el as HTMLElement).offsetHeight === 0) return false;
				if (el.getAttribute("aria-hidden") === "true") return false;
				return true;
			}

			function getLabel(el: Element): string {
				// Check aria-label
				const ariaLabel = el.getAttribute("aria-label");
				if (ariaLabel) return ariaLabel;
				// Check associated label
				const id = el.getAttribute("id");
				if (id) {
					const label = document.querySelector(`label[for="${id}"]`);
					if (label) return label.textContent?.trim() ?? "";
				}
				// Check parent label
				const parentLabel = el.closest("label");
				if (parentLabel) return parentLabel.textContent?.trim() ?? "";
				// Check placeholder
				return (el as HTMLInputElement).placeholder ?? "";
			}

			function getSelector(el: Element): string {
				// 1. data-testid
				const testId = el.getAttribute("data-testid");
				if (testId) return `[data-testid="${testId}"]`;
				// 2. unique ID
				const id = el.getAttribute("id");
				if (id && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) return `#${id}`;
				// 3. aria-label
				const ariaLabel = el.getAttribute("aria-label");
				if (ariaLabel) return `[aria-label="${ariaLabel}"]`;
				// 4. CSS path fallback
				const parts: string[] = [];
				let current: Element | null = el;
				while (current && current !== document.body) {
					const tag = current.tagName.toLowerCase();
					const parent: Element | null = current.parentElement;
					if (parent) {
						const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === current?.tagName);
						if (siblings.length > 1) {
							const idx = siblings.indexOf(current) + 1;
							parts.unshift(`${tag}:nth-of-type(${idx})`);
						} else {
							parts.unshift(tag);
						}
					} else {
						parts.unshift(tag);
					}
					current = parent;
				}
				return parts.join(" > ");
			}

			function getRect(el: Element): DOMRect {
				return el.getBoundingClientRect();
			}

			// Collect links
			for (const el of document.querySelectorAll("a[href]")) {
				if (!isVisible(el)) continue;
				if ((el as HTMLElement).closest("[disabled]")) continue;
				const href = el.getAttribute("href") ?? "";
				const blockedRe = /^(javascript:|mailto:|tel:|data:)|(^#$)/;
				if (blockedRe.test(href)) continue;
				const text = (el.textContent?.trim() ?? "").slice(0, 80);
				if (!text) continue;
				const key = `link:${text}`;
				if (seen.has(key)) continue;
				seen.add(key);
				results.push({
					tag: "a",
					type: "link",
					text,
					selector: getSelector(el),
					href,
					top: getRect(el).top,
				});
			}

			// Collect buttons
			for (const el of document.querySelectorAll('button, [role="button"], input[type="submit"]')) {
				if (!isVisible(el)) continue;
				if ((el as HTMLButtonElement).disabled) continue;
				const text = (el.textContent?.trim() ?? (el as HTMLInputElement).value ?? "").slice(0, 80);
				if (!text) continue;
				const key = `button:${text}`;
				if (seen.has(key)) continue;
				seen.add(key);
				results.push({
					tag: el.tagName.toLowerCase(),
					type: "button",
					text,
					selector: getSelector(el),
					top: getRect(el).top,
				});
			}

			// Collect text inputs
			const inputTypes = ["text", "email", "password", "search", "tel", "url", ""];
			for (const el of document.querySelectorAll("input, textarea")) {
				if (!isVisible(el)) continue;
				if ((el as HTMLInputElement).disabled) continue;
				const inputType = (el as HTMLInputElement).type?.toLowerCase() ?? "text";
				if (el.tagName === "INPUT" && !inputTypes.includes(inputType)) continue;
				if (inputType === "hidden" || inputType === "file" || inputType === "submit") continue;
				const label = getLabel(el);
				const placeholder = (el as HTMLInputElement).placeholder ?? "";
				results.push({
					tag: el.tagName.toLowerCase(),
					type: "text-input",
					text: label || placeholder || inputType,
					selector: getSelector(el),
					label,
					placeholder,
					inputType,
					top: getRect(el).top,
				});
			}

			// Collect selects
			for (const el of document.querySelectorAll("select")) {
				if (!isVisible(el)) continue;
				if ((el as HTMLSelectElement).disabled) continue;
				const label = getLabel(el);
				const options = Array.from((el as HTMLSelectElement).options)
					.map((o) => o.text.trim())
					.filter(Boolean)
					.slice(0, 20);
				results.push({
					tag: "select",
					type: "select",
					text: label || "Select",
					selector: getSelector(el),
					label,
					options,
					top: getRect(el).top,
				});
			}

			// Collect checkboxes/radios
			for (const el of document.querySelectorAll('input[type="checkbox"], input[type="radio"], [role="checkbox"]')) {
				if (!isVisible(el)) continue;
				if ((el as HTMLInputElement).disabled) continue;
				const label = getLabel(el);
				const checked = (el as HTMLInputElement).checked ?? el.getAttribute("aria-checked") === "true";
				results.push({
					tag: el.tagName.toLowerCase(),
					type: "checkbox",
					text: label || "checkbox",
					selector: getSelector(el),
					label,
					checked,
					top: getRect(el).top,
				});
			}

			// Sort by vertical position (above-the-fold first)
			results.sort((a, b) => a.top - b.top);

			// Filter out elements with empty selectors
			return results.filter((el) => el.selector?.trim());
		});

		// Also scan visible iframes for interactive elements
		try {
			const frames = page.frames().filter((f) => f !== page.mainFrame() && f.url() !== "about:blank");
			for (const frame of frames.slice(0, 3)) {
				// max 3 iframes
				try {
					const iframeElements: ScannedElement[] = await frame.evaluate(() => {
						const results: any[] = [];
						const seen = new Set<string>();

						function isVisible(el: Element): boolean {
							const style = getComputedStyle(el);
							if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
							if ((el as HTMLElement).offsetWidth === 0 && (el as HTMLElement).offsetHeight === 0) return false;
							return true;
						}

						// Scan buttons and links inside iframe
						for (const el of document.querySelectorAll('button, [role="button"], a[href]')) {
							if (!isVisible(el)) continue;
							if ((el as HTMLButtonElement).disabled) continue;
							const text = (el.textContent?.trim() ?? "").slice(0, 80);
							if (!text || seen.has(text)) continue;
							seen.add(text);
							const isLink = el.tagName === "A";
							results.push({
								tag: el.tagName.toLowerCase(),
								type: isLink ? "link" : "button",
								text: `[iframe] ${text}`,
								selector: "iframe-action", // placeholder — will use frame click
								href: isLink ? (el as HTMLAnchorElement).href : undefined,
								top: el.getBoundingClientRect().top,
								frameUrl: window.location.href,
							});
						}

						// Scan inputs inside iframe
						for (const el of document.querySelectorAll("input:not([type=hidden]):not([type=file]), textarea, select")) {
							if (!isVisible(el)) continue;
							if ((el as HTMLInputElement).disabled) continue;
							const placeholder = (el as HTMLInputElement).placeholder ?? "";
							const label = el.getAttribute("aria-label") ?? placeholder ?? el.getAttribute("name") ?? "";
							results.push({
								tag: el.tagName.toLowerCase(),
								type: el.tagName === "SELECT" ? "select" : "text-input",
								text: `[iframe] ${label}`,
								selector: "iframe-action",
								placeholder,
								label,
								inputType: (el as HTMLInputElement).type ?? "text",
								top: el.getBoundingClientRect().top,
								frameUrl: window.location.href,
							});
						}

						return results.slice(0, 10); // max 10 per iframe
					});

					// Give iframe elements real selectors via frame locators
					for (const el of iframeElements) {
						const frameSelector = `iframe[src*="${new URL(frame.url()).pathname.slice(0, 30)}"]`;
						el.selector = frameSelector; // Mark as iframe element
						el.text = el.text.slice(0, 80);
					}
					elements.push(...iframeElements);
				} catch {
					/* iframe not accessible */
				}
			}
		} catch {
			/* ignore frame errors */
		}

		return elements.slice(0, MAX_ELEMENTS);
	}

	// ─── Element → AvailableAction mapping ─────────────────────

	private elementToAction(el: ScannedElement, index: number): AvailableAction | null {
		switch (el.type) {
			case "link": {
				const desc = `Link: "${el.text}"${el.href ? ` (${el.href})` : ""}`;
				return {
					name: `click-link-${index}`,
					description: desc.slice(0, MAX_DESCRIPTION_LEN),
					category: "navigation",
					params: [this.selectorParam(el.selector)],
					weight: ACTION_WEIGHTS["click-link"],
				};
			}
			case "button": {
				const desc = `Button: "${el.text}"`;
				return {
					name: `click-button-${index}`,
					description: desc.slice(0, MAX_DESCRIPTION_LEN),
					category: "interaction",
					params: [this.selectorParam(el.selector)],
					weight: ACTION_WEIGHTS["click-button"],
				};
			}
			case "text-input": {
				const hint = el.label || el.placeholder || el.inputType || "text";
				const desc = `Input: "${hint}" (${el.inputType ?? "text"})`;
				return {
					name: `fill-input-${index}`,
					description: desc.slice(0, MAX_DESCRIPTION_LEN),
					category: "form",
					params: [
						this.selectorParam(el.selector),
						{ name: "value", type: "string", required: true, description: "Text to type into the input", example: "" },
					],
					weight: ACTION_WEIGHTS["fill-input"],
				};
			}
			case "select": {
				const desc = `Select: "${el.text}" (${el.options?.length ?? 0} options)`;
				return {
					name: `select-option-${index}`,
					description: desc.slice(0, MAX_DESCRIPTION_LEN),
					category: "form",
					params: [
						this.selectorParam(el.selector),
						{
							name: "value",
							type: "enum",
							required: true,
							description: "Option to select",
							enumValues: el.options ?? [],
						},
					],
					weight: ACTION_WEIGHTS["select-option"],
				};
			}
			case "checkbox": {
				const state = el.checked ? "checked" : "unchecked";
				const desc = `Checkbox: "${el.text}" (${state})`;
				return {
					name: `toggle-check-${index}`,
					description: desc.slice(0, MAX_DESCRIPTION_LEN),
					category: "form",
					params: [this.selectorParam(el.selector)],
					weight: ACTION_WEIGHTS["toggle-check"],
				};
			}
			default:
				return null;
		}
	}

	private selectorParam(selector: string): ActionParam {
		return {
			name: "selector",
			type: "string",
			required: true,
			description: "CSS selector (use exactly as shown)",
			example: selector,
		};
	}

	// ─── Selector sanitization ────────────────────────────────

	/** Fix invalid selectors that LLMs sometimes generate */
	private sanitizeSelector(selector: string): string {
		// Reject empty or whitespace-only selectors
		if (!selector?.trim()) return "";
		// :contains("text") is not valid CSS — convert to Playwright text selector
		const containsMatch = selector.match(/^(\w+):contains\(['"](.+?)['"]\)$/);
		if (containsMatch) {
			const [, tag, text] = containsMatch;
			return `${tag}:has-text("${text}")`;
		}
		// Remove any remaining :contains() calls
		if (selector.includes(":contains(")) {
			return selector.replace(/:contains\([^)]+\)/g, "");
		}
		return selector;
	}

	// ─── Action executors ──────────────────────────────────────

	private async execClick(page: Page, selector: string): Promise<ActionResult> {
		selector = this.sanitizeSelector(selector);
		if (!selector) {
			return { success: false, error: "Element no longer exists on page (stale selector)", duration: 0 };
		}
		const urlBefore = page.url();
		const htmlBefore = await page.evaluate(() => document.body.innerHTML.length).catch(() => 0);

		// Track HTTP response status and network activity during click
		let responseStatus = 0;
		let hadNetworkActivity = false;
		const responseHandler = (response: {
			url: () => string;
			status: () => number;
			request: () => { resourceType: () => string };
		}) => {
			hadNetworkActivity = true;
			// Only capture status for document navigations, not assets/API calls
			if (response.request().resourceType() === "document") {
				responseStatus = response.status();
			}
		};
		page.on("response", responseHandler);

		let overlayDismissed = false;
		try {
			await page.click(selector, { timeout: ACTION_TIMEOUT });
		} catch (err) {
			const msg = err instanceof Error ? err.message : "";
			if (msg.includes("intercepts pointer events") || msg.includes("outside of the viewport")) {
				overlayDismissed = await this.dismissOverlay(page);
				if (overlayDismissed) {
					await page.click(selector, { timeout: 4000 });
				} else {
					page.off("response", responseHandler);
					return {
						success: false,
						error: "Click blocked by overlay/modal that could not be dismissed",
						duration: 0,
					};
				}
			} else {
				throw err;
			}
		}

		// Wait for navigation or DOM change
		await Promise.race([page.waitForNavigation({ timeout: 3000 }).catch(() => {}), page.waitForTimeout(1500)]);

		page.off("response", responseHandler);

		const urlAfter = page.url();
		const title = await page.title();
		const navigated = urlBefore !== urlAfter;
		const is404 = responseStatus === 404 || /^\s*(404|not found|page not found|nie znaleziono)\s*$/i.test(title);

		// Detect external domain redirect
		const baseHost = new URL(this.baseUrl).hostname;
		const currentHost = new URL(urlAfter).hostname;
		const leftDomain = navigated && baseHost !== currentHost;

		// Detect dead click (nothing happened)
		const htmlAfter = await page.evaluate(() => document.body.innerHTML.length).catch(() => 0);
		const domChanged = Math.abs(htmlAfter - htmlBefore) > 50; // threshold to ignore minor changes
		const isDeadClick = !navigated && !domChanged && !hadNetworkActivity;

		const warnings: string[] = [];
		if (overlayDismissed) warnings.push("overlay was blocking — dismissed automatically");
		if (leftDomain) warnings.push(`left the app domain → ${currentHost}`);
		if (isDeadClick) warnings.push("dead click — nothing happened (no navigation, no DOM change, no network activity)");

		return {
			success: !is404 && !isDeadClick,
			error: is404
				? `Navigated to 404 page: ${urlAfter}`
				: isDeadClick
					? "Dead click — element exists but clicking it did nothing"
					: undefined,
			response: {
				url: urlAfter,
				title,
				navigated,
				...(is404 && { status: 404 }),
				...(warnings.length > 0 && { warnings }),
			},
			duration: 0,
		};
	}

	private async execFill(page: Page, selector: string, value: string): Promise<ActionResult> {
		selector = this.sanitizeSelector(selector);
		if (!selector) {
			return { success: false, error: "Element no longer exists on page (stale selector)", duration: 0 };
		}
		try {
			await page.click(selector, { timeout: ACTION_TIMEOUT });
		} catch (err) {
			const msg = err instanceof Error ? err.message : "";
			if (msg.includes("intercepts pointer events") || msg.includes("outside of the viewport")) {
				await this.dismissOverlay(page);
				await page.click(selector, { timeout: 4000 });
			} else {
				throw err;
			}
		}
		await page.fill(selector, value);

		// Check for form validation errors after fill
		await page.waitForTimeout(300); // give time for validation to fire
		const validationErrors = await page
			.evaluate((sel: string) => {
				const input = document.querySelector(sel) as HTMLInputElement | null;
				if (!input) return [];
				const errors: string[] = [];
				// HTML5 validation
				if (input.validationMessage) errors.push(input.validationMessage);
				// aria-invalid
				if (input.getAttribute("aria-invalid") === "true") {
					const describedBy = input.getAttribute("aria-describedby");
					if (describedBy) {
						const desc = document.getElementById(describedBy);
						if (desc?.textContent?.trim()) errors.push(desc.textContent.trim());
					}
					if (errors.length === 0) errors.push("Field marked as invalid");
				}
				// Adjacent error elements
				const next = input.nextElementSibling;
				if (next?.classList.contains("error") || next?.getAttribute("role") === "alert") {
					if (next.textContent?.trim()) errors.push(next.textContent.trim());
				}
				return errors.slice(0, 3);
			}, selector)
			.catch(() => [] as string[]);

		if (validationErrors.length > 0) {
			return {
				success: false,
				error: `Validation error: ${validationErrors.join("; ")}`,
				response: { filled: value, validationErrors },
				duration: 0,
			};
		}

		return {
			success: true,
			response: { filled: value },
			duration: 0,
		};
	}

	private async execSelect(page: Page, selector: string, value: string): Promise<ActionResult> {
		await page.selectOption(selector, { label: value }, { timeout: ACTION_TIMEOUT });
		return { success: true, duration: 0 };
	}

	private async execToggle(page: Page, selector: string): Promise<ActionResult> {
		await page.click(selector, { timeout: ACTION_TIMEOUT });
		return { success: true, response: { toggled: true }, duration: 0 };
	}

	private async execScroll(page: Page, direction: 1 | -1): Promise<ActionResult> {
		await page.evaluate((dir) => {
			window.scrollBy(0, dir * window.innerHeight * 0.8);
		}, direction);
		await page.waitForTimeout(300);
		return { success: true, duration: 0 };
	}

	private async execGoBack(page: Page): Promise<ActionResult> {
		await page.goBack({ timeout: 5000 }).catch(() => {});
		const url = page.url();
		return { success: true, response: { url }, duration: 0 };
	}

	// ─── Iframe interaction ────────────────────────────────────

	private async execIframeClick(page: Page, iframeSelector: string, text: string): Promise<ActionResult> {
		// Find the iframe and interact with elements inside it
		const frames = page.frames().filter((f) => f !== page.mainFrame() && f.url() !== "about:blank");

		for (const frame of frames) {
			try {
				// Try to find and click element by text inside the frame
				const el = await frame
					.locator(`button:has-text("${text}"), a:has-text("${text}"), [role="button"]:has-text("${text}")`)
					.first();
				if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
					await el.click({ timeout: ACTION_TIMEOUT });
					await page.waitForTimeout(1000);
					return { success: true, response: { iframe: true, clicked: text }, duration: 0 };
				}
			} catch {
				/* try next frame */
			}
		}

		// Fallback: try clicking the first visible button/link in any iframe
		for (const frame of frames) {
			try {
				const btn = await frame.locator("button:visible, a:visible").first();
				if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
					const btnText = await btn.textContent().catch(() => "");
					await btn.click({ timeout: ACTION_TIMEOUT });
					await page.waitForTimeout(1000);
					return { success: true, response: { iframe: true, clicked: btnText?.trim() }, duration: 0 };
				}
			} catch {
				/* try next frame */
			}
		}

		return { success: false, error: "Could not find element in iframe", duration: 0 };
	}

	// ─── Overlay dismissal ─────────────────────────────────────

	/** Attempt to dismiss overlays/modals. Returns true if something was dismissed. */
	private async dismissOverlay(page: Page): Promise<boolean> {
		let dismissed = false;

		// Strategy 1: Press Escape (closes modals, popups, dialogs)
		await page.keyboard.press("Escape");
		await page.waitForTimeout(500);

		// Strategy 2: Close Radix/Headless UI dialogs by pressing Escape again
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);

		// Strategy 3: Force-click close/dismiss buttons (modals, consent, cookie banners)
		try {
			const closeSelectors = [
				// Generic modal close
				'[class*="modal"] button[class*="close"]',
				'[class*="modal"] [aria-label="Close"]',
				'[class*="modal"] [aria-label="Zamknij"]',
				'[data-state="open"] button[class*="close"]',
				'button[aria-label="Close"]',
				'button[aria-label="Dismiss"]',
				// Cookie consent — common libraries
				"#consent-reject",
				"#consent-accept",
				'[class*="consent"] button',
				'[class*="cookie"] button',
				// OneTrust
				"#onetrust-accept-btn-handler",
				"#onetrust-reject-all-handler",
				".onetrust-close-btn-handler",
				// CookieBot
				"#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
				"#CybotCookiebotDialogBodyButtonDecline",
				// Quantcast / CMP
				'[class*="qc-cmp"] button',
				'button[mode="primary"]',
				// GDPR generic
				'[class*="gdpr"] button',
				'[class*="privacy"] button[class*="accept"]',
				'[id*="cookie"] button',
				// Newsletter/popup close
				'[class*="popup"] button[class*="close"]',
				'[class*="newsletter"] button[class*="close"]',
				'[class*="popup"] [aria-label="Close"]',
			];
			for (const sel of closeSelectors) {
				const btn = await page.$(sel);
				if (btn && (await btn.isVisible().catch(() => false))) {
					await btn.click({ force: true }).catch(() => {});
					await page.waitForTimeout(300);
					dismissed = true;
					break;
				}
			}
		} catch {
			/* ignore */
		}

		// Strategy 4: Click outside any modal backdrop
		try {
			const backdrop = await page.$(
				'.modal-backdrop, [data-testid*="overlay"], [class*="overlay"], [class*="backdrop"]',
			);
			if (backdrop) {
				await backdrop.click({ force: true }).catch(() => {});
				await page.waitForTimeout(300);
				dismissed = true;
			}
		} catch {
			/* ignore */
		}

		// Strategy 5: Handle consent banners inside iframes (OneTrust, CookieBot, etc.)
		try {
			const frames = page.frames().filter((f) => f !== page.mainFrame() && f.url() !== "about:blank");
			for (const frame of frames.slice(0, 3)) {
				try {
					const closeBtn = await frame.$(
						'button[aria-label*="close" i], button[aria-label*="reject" i], #onetrust-close-banner, #CybotCookiebotDialogBodyButtonDecline, .cmp-close-button',
					);
					if (closeBtn) {
						await closeBtn.click({ force: true }).catch(() => {});
						await page.waitForTimeout(300);
						dismissed = true;
						break;
					}
				} catch {
					/* ignore frame access errors (CORS) */
				}
			}
		} catch {
			/* ignore */
		}

		// Strategy 6: Nuclear option — force remove pointer-events blockers via JS
		const nuked = await page
			.evaluate(() => {
				let removed = 0;
				document.documentElement.style.pointerEvents = "auto";
				document.body.style.pointerEvents = "auto";
				document
					.querySelectorAll('[data-radix-portal], [vaul-overlay], [data-state="open"][role="dialog"]')
					.forEach((el) => {
						(el as HTMLElement).style.pointerEvents = "none";
						removed++;
					});
				document.querySelectorAll('div[style*="pointer-events"], div[class*="overlay"]').forEach((el) => {
					const rect = el.getBoundingClientRect();
					if (rect.width > window.innerWidth * 0.8 && rect.height > window.innerHeight * 0.8) {
						(el as HTMLElement).style.pointerEvents = "none";
						removed++;
					}
				});
				return removed;
			})
			.catch(() => 0);
		if (nuked > 0) dismissed = true;
		await page.waitForTimeout(200);

		return dismissed;
	}

	// ─── Helpers ───────────────────────────────────────────────

	private getPage(ctx: ActionContext): Page | null {
		return this.sessions.get(ctx.auth.memberId)?.page ?? null;
	}

	private getActionType(name: string): string {
		// "click-link-3" → "click-link", "scroll-down" → "scroll-down"
		const match = name.match(/^(.+?)-\d+$/);
		return match ? match[1] : name;
	}

	private async readPageContent(page: Page): Promise<string> {
		try {
			const text = await Promise.race([
				page.evaluate(() => {
					const root = document.getElementById("root") ?? document.body;
					return root.innerText;
				}),
				new Promise<string>((resolve) => setTimeout(() => resolve(""), 2000)),
			]);
			return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
		} catch {
			return "";
		}
	}

	private flattenA11yTree(node: any, depth: number, maxDepth: number): string {
		if (!node || depth > maxDepth) return "";
		const indent = "  ".repeat(depth);
		let result = "";

		if (node.name && node.role !== "none" && node.role !== "generic") {
			const role = node.role ? `[${node.role}]` : "";
			const value = node.value ? ` = "${node.value}"` : "";
			result += `${indent}${role} ${node.name}${value}\n`;
		}

		if (node.children) {
			for (const child of node.children.slice(0, 20)) {
				result += this.flattenA11yTree(child, depth + 1, maxDepth);
			}
		}

		return result;
	}

	private async takeScreenshot(page: Page, label: string): Promise<void> {
		this.screenshotIdx++;
		const filename = `${String(this.screenshotIdx).padStart(3, "0")}-${label}.png`;
		await page
			.screenshot({
				path: join(this.screenshotDir, filename),
				fullPage: false,
			})
			.catch(() => {});
	}
}

// ─── Static actions (always available) ──────────────────────

const STATIC_ACTIONS: AvailableAction[] = [
	{
		name: "scroll-down",
		description: "Scroll down one viewport",
		category: "browser",
		params: [],
		weight: ACTION_WEIGHTS["scroll-down"],
	},
	{
		name: "scroll-up",
		description: "Scroll up one viewport",
		category: "browser",
		params: [],
		weight: ACTION_WEIGHTS["scroll-up"],
	},
	{
		name: "go-back",
		description: "Go back to previous page",
		category: "navigation",
		params: [],
		weight: ACTION_WEIGHTS["go-back"],
	},
	{
		name: "wait",
		description: "Observe the current page without acting",
		category: "browser",
		params: [],
		weight: ACTION_WEIGHTS.wait,
	},
];
