import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

interface OpenAPISpec {
	openapi?: string;
	swagger?: string;
	info?: { title?: string; description?: string };
	servers?: { url: string }[];
	paths: Record<string, Record<string, OpenAPIOperation>>;
}

interface OpenAPIOperation {
	summary?: string;
	description?: string;
	operationId?: string;
	tags?: string[];
	parameters?: OpenAPIParam[];
	requestBody?: { content?: Record<string, { schema?: OpenAPISchema }> };
}

interface OpenAPIParam {
	name: string;
	in: "query" | "path" | "header" | "body";
	required?: boolean;
	description?: string;
	schema?: OpenAPISchema;
}

interface OpenAPISchema {
	type?: string;
	enum?: string[];
	format?: string;
	properties?: Record<string, OpenAPISchema>;
	required?: string[];
}

interface GeneratedAction {
	name: string;
	description: string;
	category: string;
	method: string;
	path: string;
	params: {
		name: string;
		type: string;
		required: boolean;
		in: string;
		description: string;
		enumValues?: string[];
		example?: string;
	}[];
	weight: number;
}

export interface InitResult {
	adapterPath: string;
	familyPath: string | null;
	stats: { added: number; skipped: number; total: number; mode: "created" | "merged" };
}

/**
 * Smart config generator — creates or merges Truman config.
 * If adapter.json already exists, only appends NEW endpoints (no duplicates).
 * If family YAML exists, skips it (doesn't overwrite custom personas).
 */
export class SetupGenerator {
	generateFromSpec(specPath: string, outputDir: string, baseUrl?: string): InitResult {
		const raw = readFileSync(resolve(specPath), "utf-8");
		const spec: OpenAPISpec = specPath.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
		const appName = spec.info?.title ?? "My App";
		const serverUrl = baseUrl ?? spec.servers?.[0]?.url ?? "http://localhost:3000";
		const newActions = this.extractActions(spec);
		return this.smartWrite(outputDir, serverUrl, appName, newActions);
	}

	async generateFromUrl(baseUrl: string, outputDir: string): Promise<InitResult> {
		const url = baseUrl.replace(/\/$/, "");

		// Try OpenAPI spec endpoints first
		for (const specUrl of [
			`${url}/openapi.json`,
			`${url}/swagger.json`,
			`${url}/api/openapi.json`,
			`${url}/api-docs`,
		]) {
			try {
				const resp = await fetch(specUrl, { signal: AbortSignal.timeout(3000) });
				if (resp.ok) {
					const text = await resp.text();
					const spec = JSON.parse(text) as OpenAPISpec;
					if (spec.paths) {
						const tmpPath = join(outputDir, ".tmp-spec.json");
						if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
						writeFileSync(tmpPath, text);
						return this.generateFromSpec(tmpPath, outputDir, url);
					}
				}
			} catch {
				/* continue */
			}
		}

		// No spec — probe common endpoints
		const probed = await this.probeEndpoints(url);
		return this.smartWrite(outputDir, url, "My App", probed);
	}

	// ─── Smart Write (create or merge) ────────────────────────────

	private smartWrite(outputDir: string, baseUrl: string, appName: string, newActions: GeneratedAction[]): InitResult {
		const adapterDir = join(outputDir, "adapters");
		const familyDir = join(outputDir, "families");
		if (!existsSync(adapterDir)) mkdirSync(adapterDir, { recursive: true });
		if (!existsSync(familyDir)) mkdirSync(familyDir, { recursive: true });

		const adapterPath = join(adapterDir, "adapter.json");
		let added = 0;
		let skipped = 0;
		let mode: "created" | "merged" = "created";

		if (existsSync(adapterPath)) {
			// MERGE mode — only add new endpoints
			mode = "merged";
			const existing = JSON.parse(readFileSync(adapterPath, "utf-8"));
			const existingNames = new Set((existing.actions ?? []).map((a: any) => a.name));
			const existingPaths = new Set((existing.actions ?? []).map((a: any) => `${a.method}:${a.path}`));

			for (const action of newActions) {
				const key = `${action.method}:${action.path}`;
				if (existingNames.has(action.name) || existingPaths.has(key)) {
					skipped++;
				} else {
					existing.actions.push(action);
					added++;
				}
			}

			writeFileSync(adapterPath, JSON.stringify(existing, null, 2));
		} else {
			// CREATE mode — fresh adapter
			const adapter = this.buildAdapter(baseUrl, newActions);
			writeFileSync(adapterPath, JSON.stringify(adapter, null, 2));
			added = newActions.length;
		}

		// Family — only create if doesn't exist (never overwrite custom personas)
		const familyPath = join(familyDir, "sample-family.yaml");
		let familyResult: string | null = null;
		if (!existsSync(familyPath)) {
			writeFileSync(familyPath, this.buildSampleFamily(appName, newActions));
			familyResult = familyPath;
		}

		return { adapterPath, familyPath: familyResult, stats: { added, skipped, total: newActions.length, mode } };
	}

	// ─── URL Probing ──────────────────────────────────────────────

	private async probeEndpoints(baseUrl: string): Promise<GeneratedAction[]> {
		const probes = [
			{ path: "/health", cat: "system" },
			{ path: "/users", cat: "users" },
			{ path: "/users/me", cat: "users" },
			{ path: "/tasks", cat: "tasks" },
			{ path: "/events", cat: "calendar" },
			{ path: "/calendar", cat: "calendar" },
			{ path: "/products", cat: "products" },
			{ path: "/orders", cat: "orders" },
			{ path: "/items", cat: "items" },
			{ path: "/posts", cat: "content" },
			{ path: "/messages", cat: "messaging" },
			{ path: "/notifications", cat: "notifications" },
		];

		const actions: GeneratedAction[] = [];
		const results = await Promise.allSettled(
			probes.map(async (p) => {
				const resp = await fetch(`${baseUrl}${p.path}`, {
					signal: AbortSignal.timeout(2000),
					headers: { Accept: "application/json" },
				});
				return { ...p, status: resp.status, ok: resp.ok };
			}),
		);

		for (const r of results) {
			if (r.status !== "fulfilled") continue;
			const { path, cat, status } = r.value;
			// 200, 401, 403 = endpoint exists. 404, 500 = doesn't exist or broken
			if (status < 404) {
				actions.push({
					name: `view-${cat}`,
					description: `View ${cat}`,
					category: cat,
					method: "GET",
					path,
					params: [],
					weight: 5,
				});
			}
		}

		return actions;
	}

	// ─── OpenAPI → Actions ─────────────────────────────────────────

	private extractActions(spec: OpenAPISpec): GeneratedAction[] {
		const actions: GeneratedAction[] = [];
		const seen = new Set<string>();

		for (const [path, methods] of Object.entries(spec.paths)) {
			for (const [method, op] of Object.entries(methods)) {
				if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
				const tag = op.tags?.[0] ?? this.guessCategory(path);
				const name = op.operationId ?? this.genName(method, path);
				if (seen.has(name)) continue;
				seen.add(name);

				actions.push({
					name,
					description: op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`,
					category: tag,
					method: method.toUpperCase(),
					path,
					params: this.extractParams(op, method),
					weight: method === "get" ? 7 : 5,
				});
			}
		}
		return actions;
	}

	private extractParams(op: OpenAPIOperation, method: string): GeneratedAction["params"] {
		const params: GeneratedAction["params"] = [];

		for (const p of op.parameters ?? []) {
			if (p.in === "header") continue;
			params.push({
				name: p.name,
				type: this.mapType(p.schema),
				required: p.required ?? false,
				in: p.in,
				description: p.description ?? p.name,
				enumValues: p.schema?.enum,
			});
		}

		if (method !== "get" && op.requestBody?.content) {
			const schema = op.requestBody.content["application/json"]?.schema;
			if (schema?.properties) {
				const req = new Set(schema.required ?? []);
				for (const [name, prop] of Object.entries(schema.properties)) {
					params.push({
						name,
						type: this.mapType(prop),
						required: req.has(name),
						in: "body",
						description: name,
						enumValues: prop.enum,
					});
				}
			}
		}
		return params;
	}

	// ─── Config Builders ───────────────────────────────────────────

	private buildAdapter(baseUrl: string, actions: GeneratedAction[]): object {
		return {
			baseUrl,
			auth: { type: "header", headerName: "Authorization", valueTemplate: "Bearer {{member.meta.token}}" },
			stateEndpoint: actions.find((a) => a.method === "GET")?.path ?? null,
			defaultHeaders: { "Content-Type": "application/json" },
			actions,
		};
	}

	private buildSampleFamily(appName: string, actions: GeneratedAction[]): string {
		const cats = [...new Set(actions.map((a) => a.category))];
		const features = cats
			.slice(0, 6)
			.map((c) => `      - ${c}`)
			.join("\n");
		const firstAction = actions[0]?.name ?? "random";
		const topActions = actions
			.slice(0, 3)
			.map((a) => a.name)
			.join(", ");

		return `# ─── Sample Family for ${appName} ─────────────────────────────
# Generated by Truman. Customize personas, schedules, and scenarios.

id: sample-family
name: The Smiths
lifestyle: structured
techSavviness: 3
timezone: UTC

members:
  - id: parent-alex
    name: Alex
    role: parent
    age: 35
    patience: 4
    persona: >
      Alex is a busy professional who uses ${appName} daily.
      Organized, checks things in the morning, expects the app to
      save them time. Gets frustrated with slow loading or confusing navigation.
    features:
${features}
    quirks:
      - Checks the app first thing in the morning
      - Creates entries with detailed descriptions
      - Gets frustrated if something takes more than 3 taps
    meta:
      token: test-token-alex
    schedule:
      - days: [mon, tue, wed, thu, fri]
        timeWindow: ["08:00", "08:30"]
        action: ${firstAction}
        probability: 0.9
        description: Morning check

  - id: teen-sam
    name: Sam
    role: teen
    age: 16
    patience: 2
    techSavviness: 5
    persona: >
      Sam is tech-savvy but has zero patience. Speed-taps through
      everything, never reads instructions, closes the app at the
      first sign of friction.
    features:
${features}
    quirks:
      - Speed-taps through everything
      - Never reads descriptions
      - Closes app if something is confusing
    meta:
      token: test-token-sam
    schedule:
      - days: [mon, wed, fri]
        timeWindow: ["16:00", "16:30"]
        action: random
        probability: 0.5
        description: After school — maybe checks the app

scenarios:
  - id: first-use
    trigger: always
    actor: parent-alex
    goal: >
      First time using the app. Explore what's available:
      1. Check the main view
      2. Try creating something
      3. Check the results
    expected_flow: [${topActions}]
    success_criteria:
      - type: action_performed
        action: ${firstAction}
`;
	}

	// ─── Helpers ───────────────────────────────────────────────────

	private mapType(s?: OpenAPISchema): string {
		if (!s) return "string";
		if (s.enum) return "enum";
		if (s.type === "integer" || s.type === "number") return "number";
		if (s.type === "boolean") return "boolean";
		if (s.type === "string" && (s.format === "date" || s.format === "date-time")) return "date";
		return "string";
	}

	private guessCategory(path: string): string {
		const parts = path.split("/").filter(Boolean);
		return parts[parts.length - 1]?.replace(/[^a-z]/gi, "") ?? "general";
	}

	private genName(method: string, path: string): string {
		const parts = path.split("/").filter((p) => p && !p.startsWith("{") && !p.startsWith(":"));
		const resource = parts[parts.length - 1] ?? "resource";
		const prefix = { get: "view", post: "create", put: "update", delete: "delete" }[method] ?? "manage";
		return `${prefix}-${resource}`;
	}
}
