import { chromium, type Browser, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AppAdapter,
  AuthContext,
  ActionContext,
  MemberConfig,
  FamilyConfig,
  ActionResult,
  AvailableAction,
  ChosenAction,
  AppState,
  ActionParam,
} from '../types.js';

// ─── Route mapping: Truman action → SPA page ──────────────────────
// Override via PlaywrightAdapterConfig.actionRoutes or set sensible defaults.
// Falls back to /dashboard for unknown actions.
const DEFAULT_ACTION_ROUTES: Record<string, string> = {};

export interface PlaywrightAdapterConfig {
  baseUrl: string;
  headless?: boolean;
  screenshotDir?: string;
  slowMo?: number;
  /** Custom action → SPA route mapping. Falls back to /dashboard for unknown actions. */
  actionRoutes?: Record<string, string>;
}

/**
 * Browser-based adapter — NPC navigates real UI via Playwright.
 * Uses accessibility tree for LLM context (cheap, works with gpt-4o-mini).
 * Falls back to HTTP API for data mutations.
 */
export class PlaywrightAdapter implements AppAdapter {
  name = 'playwright';
  baseUrl: string;
  private config: PlaywrightAdapterConfig;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private screenshotDir: string;
  private screenshotIdx = 0;
  private httpBaseUrl: string;

  constructor(config: PlaywrightAdapterConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl;
    this.httpBaseUrl = config.baseUrl.replace(/\/$/, '');
    this.screenshotDir = config.screenshotDir ?? '.truman/screenshots';
    if (!existsSync(this.screenshotDir)) {
      mkdirSync(this.screenshotDir, { recursive: true });
    }
  }

  async authenticate(member: MemberConfig, _family: FamilyConfig): Promise<AuthContext> {
    // Launch browser if not yet running
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: this.config.headless ?? true,
        slowMo: this.config.slowMo,
      });
    }

    // Reuse existing page if still open (scenarios reuse member sessions)
    if (this.page && !this.page.isClosed()) {
      // Just navigate to dashboard for the new member
      try {
        await this.page.goto(`${this.baseUrl}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 8000 });
        await this.page.waitForTimeout(500);
        await this.takeScreenshot(`${member.id}-reuse`);
        return { token: `truman-${member.id}`, memberId: member.id, headers: {} };
      } catch {
        // Page broken — create new one
      }
    }

    // Create new page (context) for this member's session
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: {
        'Authorization': `Bearer truman-${member.id}`,
        'userId': `truman-${member.id}`,
        'X-Truman': 'true',
        'X-Truman-Family': _family.id,
      },
    });
    this.page = await context.newPage();

    // Navigate to dashboard — MOCK_AUTH handles auth via headers
    await this.page.goto(`${this.baseUrl}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await this.page.waitForTimeout(1000); // let SPA hydrate

    await this.takeScreenshot(`${member.id}-login`);

    return {
      token: `truman-${member.id}`,
      memberId: member.id,
      headers: {},
    };
  }

  async getAvailableActions(_ctx: ActionContext): Promise<AvailableAction[]> {
    // Return same actions as HTTP adapter — the action set doesn't change
    return BROWSER_ACTIONS;
  }

  async executeAction(action: ChosenAction, ctx: ActionContext): Promise<ActionResult> {
    if (!this.page) {
      return { success: false, error: 'No browser page', duration: 0 };
    }

    const start = Date.now();

    try {
      const routes = { ...DEFAULT_ACTION_ROUTES, ...this.config.actionRoutes };
      const route = routes[action.name];
      if (route) {
        const currentPath = new URL(this.page.url()).pathname;
        if (currentPath !== route) {
          await this.page.goto(`${this.baseUrl}${route}`, { waitUntil: 'domcontentloaded', timeout: 8000 });
          await this.page.waitForTimeout(500);
        }
      }

      let result: ActionResult;

      switch (action.name) {
        case 'check-briefing':
          result = await this.execBriefing();
          break;
        case 'view-tasks':
          result = await this.execViewTasks();
          break;
        case 'manage-tasks':
          result = await this.execCreateTask(action.params);
          break;
        case 'complete-task':
          result = await this.execCompleteTask(action.params);
          break;
        case 'manage-calendar':
        case 'plan-week':
          result = await this.execViewCalendar();
          break;
        case 'create-event':
          result = await this.execCreateEvent(action.params);
          break;
        default:
          // Fallback: just navigate and read the page
          result = await this.execGenericRead(action.name);
      }

      result.duration = Date.now() - start;
      await this.takeScreenshot(`${ctx.member.id}-${action.name}`);
      return result;
    } catch (err) {
      const duration = Date.now() - start;
      await this.takeScreenshot(`${ctx.member.id}-${action.name}-error`);
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        duration,
      };
    }
  }

  async getAppState(_ctx: ActionContext): Promise<AppState> {
    if (!this.page) return { summary: 'No browser page', data: {} };

    try {
      // Get accessibility tree — what a screen reader would see
      // @ts-expect-error — page.accessibility is deprecated in newer Playwright but still functional
      const a11y = await this.page.accessibility.snapshot();
      const summary = this.flattenA11yTree(a11y, 0, 3); // max depth 3

      return {
        summary: `Current page: ${new URL(this.page.url()).pathname}\n\n${summary}`,
        data: { url: this.page.url() },
      };
    } catch {
      return { summary: 'Could not read page', data: {} };
    }
  }

  async cleanup(_ctx: ActionContext): Promise<void> {
    // Don't close page — reuse between sessions for performance
    // Browser is closed in close() after simulation ends
  }

  /** Call after simulation ends to close browser */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  // ─── Action Implementations ────────────────────────────────────

  private async execBriefing(): Promise<ActionResult> {
    const page = this.page!;
    await page.waitForTimeout(500);

    const text = await this.readPageContent();
    return {
      success: true,
      statusCode: 200,
      response: { summary: text },
      duration: 0,
    };
  }

  private async execViewTasks(): Promise<ActionResult> {
    const page = this.page!;
    await page.waitForTimeout(800);

    const text = await this.readPageContent();
    return {
      success: true,
      statusCode: 200,
      response: { summary: text },
      duration: 0,
    };
  }

  private async execCreateTask(params: Record<string, unknown>): Promise<ActionResult> {
    const page = this.page!;
    const title = String(params.title ?? 'New task');

    // Dismiss any overlays/modals blocking interaction
    await this.dismissOverlays();

    // Try to find and click "Add task" button
    const addBtn = await page.$('button:has-text("Add"), button:has-text("Dodaj"), button:has-text("+"), [data-testid="add-task"]');
    if (!addBtn) {
      // Fallback to HTTP API
      return this.httpFallback('POST', '/api/tasks', { title, priority: params.priority ?? 'medium' });
    }

    await addBtn.click();
    await page.waitForTimeout(300);

    // Fill the task title input
    const input = await page.$('input[name="title"], input[placeholder*="task"], input[placeholder*="zadani"], textarea[name="title"]');
    if (input) {
      await input.fill(title);
      await page.waitForTimeout(200);

      // Submit
      const submit = await page.$('button[type="submit"], button:has-text("Save"), button:has-text("Zapisz"), button:has-text("Dodaj")');
      if (submit) await submit.click();
      await page.waitForTimeout(500);
    }

    return {
      success: true,
      statusCode: 201,
      response: { title, created: true },
      duration: 0,
    };
  }

  private async execCompleteTask(params: Record<string, unknown>): Promise<ActionResult> {
    const page = this.page!;

    // Try to click first uncompleted task checkbox
    const checkbox = await page.$('[data-testid="task-checkbox"]:not([data-checked]), input[type="checkbox"]:not(:checked), [role="checkbox"][aria-checked="false"]');
    if (checkbox) {
      await checkbox.click();
      await page.waitForTimeout(500);
      return { success: true, statusCode: 200, response: { completed: true }, duration: 0 };
    }

    // Fallback to HTTP
    const taskId = params.taskId;
    if (taskId) {
      return this.httpFallback('POST', `/api/tasks/${taskId}/complete`, {});
    }

    return { success: false, error: 'No task checkbox found on page', duration: 0 };
  }

  private async execViewCalendar(): Promise<ActionResult> {
    await this.page!.waitForTimeout(500);
    const text = await this.readPageContent();
    return { success: true, statusCode: 200, response: { summary: text }, duration: 0 };
  }

  private async execCreateEvent(params: Record<string, unknown>): Promise<ActionResult> {
    // Calendar event creation is complex UI — fallback to HTTP
    return this.httpFallback('POST', '/api/events', {
      title: params.title ?? 'New event',
      startTime: params.startTime,
      endTime: params.endTime,
    });
  }

  private async execGenericRead(actionName: string): Promise<ActionResult> {
    await this.page!.waitForTimeout(500);
    const text = await this.readPageContent();
    return { success: true, statusCode: 200, response: { action: actionName, pageContent: text }, duration: 0 };
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /** Read visible page text safely — never blocks more than 2s */
  private async readPageContent(): Promise<string> {
    if (!this.page) return '';
    try {
      // Try #root first (React app container), then body
      const text = await Promise.race([
        this.page.evaluate(() => {
          const root = document.getElementById('root') ?? document.body;
          return root.innerText;
        }),
        new Promise<string>((resolve) => setTimeout(() => resolve(''), 2000)),
      ]);
      return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    } catch {
      return '';
    }
  }

  /** Dismiss onboarding overlays, modals, toasts that block interaction */
  private async dismissOverlays(): Promise<void> {
    if (!this.page) return;
    try {
      // Click away any overlay backdrops
      const overlay = await this.page.$('[aria-hidden="true"].fixed.inset-0, [data-radix-dialog-overlay], .overlay-backdrop');
      if (overlay) {
        await this.page.keyboard.press('Escape');
        await this.page.waitForTimeout(300);
      }
      // Close any toast notifications
      const closeBtn = await this.page.$('[data-dismiss], button[aria-label="Close"], button[aria-label="Zamknij"]');
      if (closeBtn) await closeBtn.click().catch(() => {});
    } catch { /* ignore */ }
  }

  private async httpFallback(method: string, path: string, body: Record<string, unknown>): Promise<ActionResult> {
    const page = this.page!;
    const ctx = page.context();

    // Use page's fetch to inherit cookies/headers from browser context
    const result = await page.evaluate(
      async ({ url, method, body }) => {
        const resp = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: method !== 'GET' ? JSON.stringify(body) : undefined,
        });
        const data = await resp.json().catch(() => resp.text());
        return { ok: resp.ok, status: resp.status, data };
      },
      { url: `${this.httpBaseUrl}${path}`, method, body },
    );

    return {
      success: result.ok,
      statusCode: result.status,
      response: result.data,
      error: result.ok ? undefined : `HTTP ${result.status}`,
      duration: 0,
    };
  }

  private async takeScreenshot(label: string): Promise<void> {
    if (!this.page) return;
    this.screenshotIdx++;
    const filename = `${String(this.screenshotIdx).padStart(3, '0')}-${label}.png`;
    await this.page.screenshot({
      path: join(this.screenshotDir, filename),
      fullPage: false,
    });
  }

  private flattenA11yTree(node: any, depth: number, maxDepth: number): string {
    if (!node || depth > maxDepth) return '';
    const indent = '  '.repeat(depth);
    let result = '';

    if (node.name && node.role !== 'none' && node.role !== 'generic') {
      const role = node.role ? `[${node.role}]` : '';
      const value = node.value ? ` = "${node.value}"` : '';
      result += `${indent}${role} ${node.name}${value}\n`;
    }

    if (node.children) {
      for (const child of node.children.slice(0, 20)) { // limit children to prevent huge trees
        result += this.flattenA11yTree(child, depth + 1, maxDepth);
      }
    }

    return result;
  }
}

// ─── Available Actions (browser-compatible subset) ──────────────

const BROWSER_ACTIONS: AvailableAction[] = [
  { name: 'check-briefing', description: 'View dashboard with daily briefing', category: 'briefing', params: [], weight: 10 },
  { name: 'view-tasks', description: 'View task list', category: 'tasks', params: [], weight: 7 },
  {
    name: 'manage-tasks', description: 'Create a new task via the UI', category: 'tasks',
    params: [{ name: 'title', type: 'string', required: true, description: 'Task title', example: 'Kupić mleko' }],
    weight: 8,
  },
  {
    name: 'complete-task', description: 'Click checkbox on a task to complete it', category: 'tasks',
    params: [{ name: 'taskId', type: 'number', required: false, description: 'Task ID (optional, clicks first unchecked)' }],
    weight: 5,
  },
  { name: 'manage-calendar', description: 'View calendar page', category: 'calendar', params: [], weight: 7 },
  {
    name: 'create-event', description: 'Create calendar event', category: 'calendar',
    params: [
      { name: 'title', type: 'string', required: true, description: 'Event title' },
      { name: 'startTime', type: 'string', required: true, description: 'ISO datetime' },
      { name: 'endTime', type: 'string', required: true, description: 'ISO datetime' },
    ],
    weight: 5,
  },
  { name: 'plan-week', description: 'View weekly calendar', category: 'calendar', params: [], weight: 6 },
  { name: 'manage-wellness', description: 'View wellness page', category: 'wellness', params: [], weight: 5 },
  { name: 'manage-meals', description: 'View meals page', category: 'meals', params: [], weight: 4 },
  { name: 'manage-finance', description: 'View finance page', category: 'finance', params: [], weight: 3 },
];
