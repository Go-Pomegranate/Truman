// ─── NPC Engine — Public API ────────────────────────────────────
// Simulate realistic user personas interacting with your app.

// Core engine
export { SimulationEngine } from './engine/SimulationEngine.js';
export { Scheduler } from './engine/Scheduler.js';

// Family management
export { loadFamily, loadFamilies } from './family/FamilyLoader.js';
export { FamilyStateManager } from './family/FamilyState.js';

// AI decision making
export { DecisionEngine } from './agent/DecisionEngine.js';
export { PersonaBuilder } from './agent/PersonaBuilder.js';

// LLM providers
export { createProvider } from './agent/providers/types.js';
export { OpenAIProvider } from './agent/providers/OpenAIProvider.js';
export { OllamaProvider } from './agent/providers/OllamaProvider.js';
export { AnthropicProvider } from './agent/providers/AnthropicProvider.js';

// Adapters
export { HttpApiAdapter } from './adapters/HttpApiAdapter.js';

// Observer
export { ActionLogger } from './observer/ActionLogger.js';
export { VoiceNarrator } from './observer/VoiceNarrator.js';
export { SessionRecorder } from './observer/SessionRecorder.js';
export { BugExporter } from './observer/BugExporter.js';
export type { BugReport } from './observer/BugExporter.js';

// Types — re-export everything for consumers
export type {
  // Family config
  FamilyConfig,
  MemberConfig,
  ScheduleEntry,
  DayOfWeek,
  Lifestyle,
  MemberRole,
  // Runtime
  SimulationConfig,
  ActionContext,
  AppAdapter,
  AuthContext,
  AvailableAction,
  ActionParam,
  ChosenAction,
  ActionResult,
  AppState,
  // LLM
  LLMProvider,
  Decision,
  DecisionOptions,
  // Logging
  ActionLog,
  // State
  FamilyState,
  MemberState,
  IssueRecord,
  FamilyStats,
  // Reports
  SimulationReport,
  FamilyReport,
  MemberReport,
  ReportSummary,
  // Events
  EngineEvent,
  EventHandler,
} from './types.js';

// Adapter types
export type {
  HttpAdapterConfig,
  AuthStrategy,
  ActionDefinition,
  ActionParamDef,
} from './adapters/types.js';

// Provider types
export type { LLMProviderConfig } from './agent/providers/types.js';
