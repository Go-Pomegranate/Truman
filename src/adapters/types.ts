import type { AppAdapter } from '../types.js';

export type { AppAdapter };

/**
 * Configuration for the generic HTTP API adapter.
 */
export interface HttpAdapterConfig {
  /** Base URL of the API (e.g. "http://localhost:3000/api") */
  baseUrl: string;
  /** How to authenticate members */
  auth: AuthStrategy;
  /** Map of action names to API endpoint definitions */
  actions: ActionDefinition[];
  /** Default headers sent with every request */
  defaultHeaders?: Record<string, string>;
  /** Endpoint to fetch current app state (GET) */
  stateEndpoint?: string;
}

export type AuthStrategy =
  | { type: 'bearer'; tokenEndpoint: string; bodyTemplate: Record<string, string> }
  | { type: 'cookie'; loginEndpoint: string; bodyTemplate: Record<string, string> }
  | { type: 'header'; headerName: string; valueTemplate: string }
  | { type: 'none' };

export interface ActionDefinition {
  name: string;
  description: string;
  category: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path template with :param placeholders (e.g. "/tasks/:id/complete") */
  path: string;
  /** Parameter definitions */
  params: ActionParamDef[];
  /** Weight for random selection */
  weight?: number;
}

export interface ActionParamDef {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum';
  required: boolean;
  description: string;
  /** Where does this param go? */
  in: 'body' | 'path' | 'query';
  enumValues?: string[];
  example?: string;
}
