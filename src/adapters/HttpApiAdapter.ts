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
import type { HttpAdapterConfig, ActionDefinition } from './types.js';

/**
 * Generic HTTP API adapter.
 * Configure with action definitions and auth strategy — works with any REST API.
 */
export class HttpApiAdapter implements AppAdapter {
  name: string;
  baseUrl: string;
  private config: HttpAdapterConfig;

  constructor(config: HttpAdapterConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl;
    this.name = `http:${new URL(config.baseUrl).hostname}`;
  }

  async authenticate(member: MemberConfig, family: FamilyConfig): Promise<AuthContext> {
    const auth = this.config.auth;

    switch (auth.type) {
      case 'none':
        return { token: '', memberId: member.id, headers: {} };

      case 'header': {
        const value = this.interpolate(auth.valueTemplate, { member, family });
        // Interpolate defaultHeaders per-member (e.g. userId from member.meta)
        const extraHeaders = this.config.defaultHeaders
          ? this.interpolateObject(this.config.defaultHeaders, { member, family })
          : {};
        return {
          token: value,
          memberId: member.id,
          headers: { [auth.headerName]: value, ...extraHeaders },
        };
      }

      case 'bearer': {
        const body = this.interpolateObject(auth.bodyTemplate, { member, family });
        const resp = await fetch(`${this.baseUrl}${auth.tokenEndpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error(`Auth failed for ${member.name}: ${resp.status}`);
        const data = (await resp.json()) as { token?: string; access_token?: string };
        const token = data.token ?? data.access_token ?? '';
        return {
          token,
          memberId: member.id,
          headers: { Authorization: `Bearer ${token}` },
        };
      }

      case 'cookie': {
        const body = this.interpolateObject(auth.bodyTemplate, { member, family });
        const resp = await fetch(`${this.baseUrl}${auth.loginEndpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error(`Auth failed for ${member.name}: ${resp.status}`);
        const cookies = resp.headers.get('set-cookie') ?? '';
        return {
          token: cookies,
          memberId: member.id,
          headers: { Cookie: cookies },
        };
      }
    }
  }

  async getAvailableActions(_ctx: ActionContext): Promise<AvailableAction[]> {
    return this.config.actions.map((def) => ({
      name: def.name,
      description: def.description,
      category: def.category,
      weight: def.weight,
      params: def.params.map(
        (p): ActionParam => ({
          name: p.name,
          type: p.type,
          required: p.required,
          description: p.description,
          enumValues: p.enumValues,
          example: p.example,
        }),
      ),
    }));
  }

  async executeAction(action: ChosenAction, ctx: ActionContext): Promise<ActionResult> {
    const def = this.config.actions.find((a) => a.name === action.name);
    if (!def) {
      return { success: false, error: `Unknown action: ${action.name}`, duration: 0 };
    }

    const start = Date.now();

    try {
      const { url, body } = this.buildRequest(def, action.params);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...this.config.defaultHeaders,
        ...ctx.auth.headers,
      };

      const resp = await fetch(url, {
        method: def.method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      const duration = Date.now() - start;
      const responseData = resp.headers.get('content-type')?.includes('json')
        ? await resp.json()
        : await resp.text();

      return {
        success: resp.ok,
        statusCode: resp.status,
        response: responseData,
        error: resp.ok ? undefined : `HTTP ${resp.status}`,
        duration,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        duration: Date.now() - start,
      };
    }
  }

  async getAppState(ctx: ActionContext): Promise<AppState> {
    if (!this.config.stateEndpoint) {
      return { summary: 'App state not configured', data: {} };
    }

    try {
      const resp = await fetch(`${this.baseUrl}${this.config.stateEndpoint}`, {
        headers: { ...this.config.defaultHeaders, ...ctx.auth.headers },
      });

      if (!resp.ok) {
        return { summary: `Could not fetch app state (HTTP ${resp.status})`, data: {} };
      }

      const data = (await resp.json()) as Record<string, unknown>;
      return {
        summary: this.summarizeState(data),
        data,
      };
    } catch {
      return { summary: 'Failed to fetch app state', data: {} };
    }
  }

  private buildRequest(
    def: ActionDefinition,
    params: Record<string, unknown>,
  ): { url: string; body: Record<string, unknown> | null } {
    let path = def.path;
    const queryParts: string[] = [];
    const body: Record<string, unknown> = {};

    for (const paramDef of def.params) {
      const value = params[paramDef.name];
      if (value === undefined) continue;

      switch (paramDef.in) {
        case 'path':
          path = path.replace(`:${paramDef.name}`, String(value));
          break;
        case 'query':
          queryParts.push(`${paramDef.name}=${encodeURIComponent(String(value))}`);
          break;
        case 'body':
          body[paramDef.name] = value;
          break;
      }
    }

    const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
    const url = `${this.baseUrl}${path}${queryString}`;
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(def.method) && Object.keys(body).length > 0;

    return { url, body: hasBody ? body : null };
  }

  private summarizeState(data: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        parts.push(`${key}: ${value.length} items`);
      } else if (typeof value === 'object' && value !== null) {
        parts.push(`${key}: ${Object.keys(value).length} fields`);
      } else {
        parts.push(`${key}: ${String(value)}`);
      }
    }
    return parts.join('\n') || 'Empty state';
  }

  private interpolate(
    template: string,
    ctx: { member: MemberConfig; family: FamilyConfig },
  ): string {
    return template
      .replace(/\{\{member\.meta\.(\w+)\}\}/g, (_, key) => {
        const meta = ctx.member.meta as Record<string, unknown> | undefined;
        return String(meta?.[key] ?? '');
      })
      .replace(/\{\{member\.(\w+)\}\}/g, (_, key) => String((ctx.member as unknown as Record<string, unknown>)[key] ?? ''))
      .replace(/\{\{family\.meta\.(\w+)\}\}/g, (_, key) => {
        const meta = ctx.family.meta as Record<string, unknown> | undefined;
        return String(meta?.[key] ?? '');
      })
      .replace(/\{\{family\.(\w+)\}\}/g, (_, key) => String((ctx.family as unknown as Record<string, unknown>)[key] ?? ''))
      .replace(/\{\{env\.(\w+)\}\}/g, (_, key) => process.env[key] ?? '');
  }

  private interpolateObject(
    template: Record<string, string>,
    ctx: { member: MemberConfig; family: FamilyConfig },
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(template)) {
      result[key] = this.interpolate(value, ctx);
    }
    return result;
  }
}
