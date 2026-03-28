import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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
const MAX_SUMMARY_LEN = 800;
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
						execSync("npx playwright install chromium", { stdio: "pipe", timeout: 120_000 });
						console.log("  ✓ Chromium installed.\n");
					} catch {
						throw new Error(
							"Failed to auto-install Chromium. Run manually: npx playwright install chromium",
						);
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

		this.sessions.set(member.id, { context, page });

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

			let summary = `Page: ${title} (${pathname})\n\n`;
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

			return results;
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
		const urlBefore = page.url();

		try {
			await page.click(selector, { timeout: ACTION_TIMEOUT });
		} catch (err) {
			const msg = err instanceof Error ? err.message : "";
			// If blocked by overlay/iframe, try to dismiss and retry
			if (msg.includes("intercepts pointer events") || msg.includes("outside of the viewport")) {
				await this.dismissOverlay(page);
				// Retry once after dismissal with shorter timeout
				await page.click(selector, { timeout: 4000 });
			} else {
				throw err;
			}
		}

		// Wait for navigation or DOM change
		await Promise.race([page.waitForNavigation({ timeout: 3000 }).catch(() => {}), page.waitForTimeout(1500)]);

		const urlAfter = page.url();
		const title = await page.title();
		return {
			success: true,
			response: { url: urlAfter, title, navigated: urlBefore !== urlAfter },
			duration: 0,
		};
	}

	private async execFill(page: Page, selector: string, value: string): Promise<ActionResult> {
		selector = this.sanitizeSelector(selector);
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

	private async dismissOverlay(page: Page): Promise<void> {
		// Strategy 1: Press Escape (closes modals, popups, dialogs)
		await page.keyboard.press("Escape");
		await page.waitForTimeout(500);

		// Strategy 2: Close Radix/Headless UI dialogs by pressing Escape again
		// (some dialogs need Escape twice: once to close dropdown, once to close modal)
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);

		// Strategy 3: Force-click close buttons (modals, consent banners)
		try {
			const closeSelectors = [
				'[class*="modal"] button[class*="close"]',
				'[class*="modal"] [aria-label="Close"]',
				'[class*="modal"] [aria-label="Zamknij"]',
				'[data-state="open"] button[class*="close"]',
				'button[aria-label="Close"]',
				'button[aria-label="Dismiss"]',
				"#consent-reject",
				"#consent-accept",
				'[class*="consent"] button',
				'[class*="cookie"] button',
			];
			for (const sel of closeSelectors) {
				const btn = await page.$(sel);
				if (btn) {
					await btn.click({ force: true }).catch(() => {});
					await page.waitForTimeout(300);
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
			}
		} catch {
			/* ignore */
		}

		// Strategy 5: Nuclear option — force remove pointer-events blockers via JS
		// When <html> or a full-page overlay blocks everything, remove it
		await page
			.evaluate(() => {
				// Remove pointer-events: none from html/body
				document.documentElement.style.pointerEvents = "auto";
				document.body.style.pointerEvents = "auto";
				// Remove Radix overlays that block the entire page
				document
					.querySelectorAll('[data-radix-portal], [vaul-overlay], [data-state="open"][role="dialog"]')
					.forEach((el) => {
						(el as HTMLElement).style.pointerEvents = "none";
					});
				// Remove fixed/absolute positioned full-screen overlays
				document.querySelectorAll('div[style*="pointer-events"], div[class*="overlay"]').forEach((el) => {
					const rect = el.getBoundingClientRect();
					if (rect.width > window.innerWidth * 0.8 && rect.height > window.innerHeight * 0.8) {
						(el as HTMLElement).style.pointerEvents = "none";
					}
				});
			})
			.catch(() => {});
		await page.waitForTimeout(200);
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
