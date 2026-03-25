// ─── Family Configuration (loaded from YAML) ───────────────────────

export type DayOfWeek = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type Lifestyle = "busy" | "relaxed" | "chaotic" | "structured";
export type MemberRole = "parent" | "teen" | "child" | "grandparent";

export interface FamilyConfig {
	id: string;
	name: string;
	lifestyle: Lifestyle;
	techSavviness: number; // 1-5
	timezone: string;
	members: MemberConfig[];
	/** Goal-driven user stories that NPCs execute */
	scenarios?: ScenarioConfig[];
	/** Custom metadata your adapter can use */
	meta?: Record<string, unknown>;
}

export interface MemberConfig {
	id: string;
	name: string;
	role: MemberRole;
	age?: number;
	/** Free-text persona description fed to the LLM */
	persona: string;
	/** Frustration tolerance 1-5 (1 = gives up fast) */
	patience: number;
	/** Override family-level tech savviness */
	techSavviness?: number;
	schedule: ScheduleEntry[];
	/** Which app features/modules this member uses */
	features: string[];
	/** Behavioral quirks injected into persona prompt */
	quirks: string[];
	meta?: Record<string, unknown>;
}

export interface ScheduleEntry {
	days: DayOfWeek[];
	/** Time window in HH:MM format */
	timeWindow: [string, string];
	/** Action type — adapter-specific or "random" for AI-chosen */
	action: string;
	/** Probability this action fires (0-1) */
	probability: number;
	/** Human-readable description for the LLM */
	description?: string;
}

// ─── Runtime Types ──────────────────────────────────────────────────

export interface SimulationConfig {
	/** Paths to family YAML files or inline FamilyConfig objects */
	families: (string | FamilyConfig)[];
	adapter: AppAdapter;
	llmProvider: LLMProvider;
	/** Time multiplier: 1 = real-time, 60 = 1 min → 1 hour */
	speed: number;
	/** Directory for action logs */
	logDir: string;
	/** Directory for persistent family state */
	stateDir: string;
	/** How often the scheduler ticks (ms). Default: 60000 (1 min) */
	tickInterval?: number;
	/** Max concurrent member sessions */
	concurrency?: number;
	/** Max actions per NPC session (default: 10) */
	maxActionsPerSession?: number;
	/** Hook called before each action — return false to skip */
	beforeAction?: (ctx: { auth: AuthContext; family: FamilyConfig; member: MemberConfig }) => Promise<boolean>;
	/** Hook called after each action */
	afterAction?: (log: ActionLog) => Promise<void>;
}

// ─── Action Context ─────────────────────────────────────────────────

export interface ActionContext {
	auth: AuthContext;
	family: FamilyConfig;
	member: MemberConfig;
}

// ─── App Adapter ────────────────────────────────────────────────────

export interface AuthContext {
	token: string;
	memberId: string;
	headers: Record<string, string>;
}

export interface AppAdapter {
	name: string;
	/** Base URL of the app API */
	baseUrl: string;
	/** Authenticate a simulated member, return auth context */
	authenticate(member: MemberConfig, family: FamilyConfig): Promise<AuthContext>;
	/** Return actions available to this member right now */
	getAvailableActions(ctx: ActionContext): Promise<AvailableAction[]>;
	/** Execute a chosen action */
	executeAction(action: ChosenAction, ctx: ActionContext): Promise<ActionResult>;
	/** Get current app state visible to this member */
	getAppState(ctx: ActionContext): Promise<AppState>;
	/** Optional cleanup after a session */
	cleanup?(ctx: ActionContext): Promise<void>;
}

export interface AvailableAction {
	name: string;
	description: string;
	category: string;
	/** Parameters the action accepts */
	params: ActionParam[];
	/** Weight for random selection (higher = more likely) */
	weight?: number;
}

export interface ActionParam {
	name: string;
	type: "string" | "number" | "boolean" | "date" | "enum";
	required: boolean;
	description: string;
	enumValues?: string[];
	example?: string;
}

export interface ChosenAction {
	name: string;
	params: Record<string, unknown>;
}

export interface ActionResult {
	success: boolean;
	/** HTTP status or app-specific code */
	statusCode?: number;
	response?: unknown;
	error?: string;
	/** How long the action took in ms */
	duration: number;
	/** Optional screenshot path (for browser adapters) */
	screenshot?: string;
}

export interface AppState {
	/** Summary of what the member sees, fed to LLM for context */
	summary: string;
	/** Structured data for programmatic access */
	data: Record<string, unknown>;
	/** Base64 PNG screenshot for vision mode */
	screenshot?: string;
}

// ─── LLM Provider ───────────────────────────────────────────────────

export interface LLMProvider {
	name: string;
	/** Ask the LLM to make a decision based on persona + context */
	decide(prompt: string, options?: DecisionOptions): Promise<Decision>;
}

export interface DecisionOptions {
	temperature?: number;
	maxTokens?: number;
	/** Base64 PNG screenshot of current page (for vision-capable models) */
	screenshot?: string;
	/** JSON schema the response must follow */
	responseSchema?: Record<string, unknown>;
}

export interface Decision {
	/** Which action to take */
	action: string;
	/** NPC's current goal — what they're trying to accomplish on this site */
	goal?: string;
	/** LLM's reasoning (useful for debugging) */
	reasoning: string;
	/** Parameters for the action */
	params: Record<string, unknown>;
	/** Current emotional state of the persona */
	mood?: string;
	/** Short inner thought about the UX — what the persona actually thinks (max 10 words) */
	thought?: string;
	/** Frustration level 0-1 (may trigger session abort) */
	frustration?: number;
	/** Whether the persona wants to continue or stop */
	wantsToContinue: boolean;
}

// ─── Action Logging ─────────────────────────────────────────────────

export interface ActionLog {
	timestamp: string;
	sessionId: string;
	familyId: string;
	familyName: string;
	memberId: string;
	memberName: string;
	memberRole: MemberRole;
	action: string;
	decision: Decision;
	result: ActionResult;
	/** Running frustration accumulator for this session */
	sessionFrustration: number;
	/** How many actions in this session so far */
	actionIndex: number;
}

// ─── Family State (persisted between sessions) ──────────────────────

export interface FamilyState {
	familyId: string;
	lastUpdated: string;
	members: Record<string, MemberState>;
	/** Cross-session stats */
	stats: FamilyStats;
}

export interface MemberState {
	memberId: string;
	lastSessionAt: string | null;
	totalSessions: number;
	totalActions: number;
	/** Running average frustration */
	avgFrustration: number;
	/** Features this member has successfully used */
	discoveredFeatures: string[];
	/** Issues encountered (for reporting) */
	issues: IssueRecord[];
	/** Last 20 actions for context */
	recentActions: string[];
}

export interface IssueRecord {
	timestamp: string;
	action: string;
	error: string;
	frustration: number;
	memberMood: string;
}

export interface FamilyStats {
	totalSessions: number;
	totalActions: number;
	successRate: number;
	avgSessionDuration: number;
	topIssues: { action: string; count: number; lastSeen: string }[];
}

// ─── Report ─────────────────────────────────────────────────────────

export interface SimulationReport {
	generatedAt: string;
	duration: string;
	families: FamilyReport[];
	summary: ReportSummary;
	scenarioResults?: ScenarioResult[];
	discoverability?: DiscoverabilityReport;
}

export interface FamilyReport {
	familyId: string;
	familyName: string;
	lifestyle: Lifestyle;
	members: MemberReport[];
	issues: IssueRecord[];
}

export interface MemberReport {
	memberId: string;
	memberName: string;
	role: MemberRole;
	sessionsRun: number;
	actionsPerformed: number;
	successRate: number;
	avgFrustration: number;
	discoveredFeatures: string[];
	blockedFeatures: string[];
	topIssues: string[];
}

export interface ReportSummary {
	totalFamilies: number;
	totalMembers: number;
	totalActions: number;
	overallSuccessRate: number;
	criticalIssues: IssueRecord[];
	uxBlockers: { feature: string; affectedMembers: string[]; description: string }[];
}

// ─── Scenarios (User Stories) ────────────────────────────────────────

export interface ScenarioConfig {
	id: string;
	/** When the scenario triggers */
	trigger: "schedule" | "random" | "always";
	/** For trigger: 'random' — chance to fire per run (0-1, default 1.0) */
	probability?: number;
	/** For trigger: 'schedule' — which days */
	days?: DayOfWeek[];
	/** For trigger: 'schedule' — time window */
	timeWindow?: [string, string];
	/** Member ID who executes this scenario */
	actor: string;
	/** Natural language goal given to LLM */
	goal: string;
	/** Expected action sequence (hint for LLM, not enforced in exploratory mode) */
	expected_flow: string[];
	/** Post-hoc success evaluation (exploratory mode) */
	success_criteria: SuccessCriterion[];
	/** Max actions before session ends (default 15) */
	maxActions?: number;
	/**
	 * Deterministic mode: skip LLM, execute `steps` exactly as defined.
	 * Params are fixtures, responses are asserted. Reproducible in CI.
	 */
	deterministic?: boolean;
	/** Fixed steps for deterministic mode — replaces LLM decision-making */
	steps?: DeterministicStep[];
}

export interface DeterministicStep {
	/** Action to execute */
	action: string;
	/** Fixed params — no LLM generation. Use $prev.{step}.{path} for chaining */
	params?: Record<string, unknown>;
	/** Assertions on the response */
	assert?: StepAssertion;
}

export interface StepAssertion {
	/** Expected HTTP status code */
	status?: number;
	/** Response body must contain this string (case-insensitive) */
	bodyContains?: string;
	/** Response body must NOT contain this string */
	bodyNotContains?: string;
	/** Response must be successful (default: true) */
	success?: boolean;
	/** Max response time in ms */
	maxDuration?: number;
}

export type SuccessCriterion =
	| { type: "action_chain"; actions: string[] }
	| { type: "action_performed"; action: string; minTimes?: number }
	| { type: "response_matches"; action: string; pattern: string };

export interface ScenarioResult {
	scenarioId: string;
	actor: string;
	goal: string;
	success: boolean;
	criteriaResults: { criterion: SuccessCriterion; passed: boolean; detail: string }[];
	actionsTaken: string[];
	totalActions: number;
	duration: number;
}

// ─── Discoverability ────────────────────────────────────────────────

export interface DiscoverabilityReport {
	overallScore: number; // 0-100
	featureBreakdown: FeatureDiscovery[];
	briefingCorrelation: number; // 0-1
	emptyStateReactions: { action: string; member: string; reaction: "created" | "frustrated" | "left" }[];
}

export interface FeatureDiscovery {
	feature: string;
	discovered: boolean;
	stepsToDiscover: number | null;
	discoveredBy: string[];
	organic: boolean; // true if found WITHOUT being in member's schedule
}

// ─── Events (for hooks / plugins) ───────────────────────────────────

export type EngineEvent =
	| { type: "simulation:start"; families: string[] }
	| { type: "simulation:stop"; reason: string }
	| { type: "session:start"; familyId: string; memberId: string; sessionId: string }
	| { type: "session:end"; familyId: string; memberId: string; sessionId: string; actions: number }
	| { type: "action:before"; familyId: string; memberId: string; action: string }
	| { type: "action:after"; log: ActionLog }
	| { type: "issue:detected"; issue: IssueRecord; familyId: string; memberId: string }
	| { type: "member:frustrated"; familyId: string; memberId: string; level: number }
	| { type: "scenario:start"; scenarioId: string; familyId: string; actor: string; goal: string }
	| { type: "scenario:end"; result: ScenarioResult }
	| { type: "tick"; time: string; scheduled: number };

export type EventHandler = (event: EngineEvent) => void | Promise<void>;
