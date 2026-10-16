import path from 'node:path';
import { z } from 'zod';
import { repoRoot, type LoadedConfig } from './load.ts';
import { serverSchema, zodMessage } from './server.ts';
import { checkModules } from './checks/index.ts';
import type { CheckModule } from './checks/types.ts';

const endpointSchema = z.looseObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
  name: z.string().min(1),
  type: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  intervalSeconds: z.number().positive().optional(),
  /** If set, a passing check slower than this is reported as "degraded". */
  degradedLatencyMs: z.number().int().positive().optional(),
});

export const healthConfigSchema = z.object({
  server: serverSchema.default({ host: 'lan', port: 4400 }),
  /** Link to the command-center (workspace) app shown in the header (optional). */
  workspaceUrl: z.url().optional(),
  checkIntervalSeconds: z.number().positive().default(60),
  historySize: z.number().int().positive().default(60),
  defaultTimeoutMs: z.number().int().positive().default(10_000),
  dbPath: z.string().default('data/health.db'),
  endpoints: z.array(endpointSchema).default([]),
});

export interface Endpoint {
  id: string;
  name: string;
  type: string;
  target: string;
  intervalMs: number;
  timeoutMs: number;
  degradedLatencyMs?: number;
  module?: CheckModule<any>;
  opts?: unknown;
  /** Set when the entry is invalid; the endpoint is shown as down with this message and never run. */
  configError?: string;
}

export interface HealthConfig {
  server: z.infer<typeof serverSchema>;
  workspaceUrl?: string;
  historySize: number;
  dbPath: string;
  endpoints: Endpoint[];
}

export function parseHealthConfig(loaded: LoadedConfig): HealthConfig {
  const parsed = healthConfigSchema.safeParse(loaded.raw);
  if (!parsed.success) throw new Error(`config.yaml: ${zodMessage(parsed.error)}`);
  const c = parsed.data;

  const seen = new Set<string>();
  const endpoints = c.endpoints.map((e): Endpoint => {
    const base = {
      id: e.id,
      name: e.name,
      type: e.type,
      target: '',
      intervalMs: (e.intervalSeconds ?? c.checkIntervalSeconds) * 1000,
      timeoutMs: e.timeoutMs ?? c.defaultTimeoutMs,
      degradedLatencyMs: e.degradedLatencyMs,
    };
    if (seen.has(e.id)) return { ...base, configError: `duplicate endpoint id "${e.id}"` };
    seen.add(e.id);
    const module = checkModules[e.type];
    if (!module) {
      return { ...base, configError: `unknown check type "${e.type}" (known: ${Object.keys(checkModules).join(', ')})` };
    }
    const placeholder = Object.entries(e).find(([, v]) => v === 'CHANGE_ME');
    if (placeholder) return { ...base, configError: `not configured: set ${placeholder[0]} in config.local.yaml` };
    const opts = module.options.safeParse(e);
    if (!opts.success) return { ...base, configError: `invalid config: ${zodMessage(opts.error)}` };
    return { ...base, module, opts: opts.data, target: module.describe(opts.data) };
  });

  return {
    server: c.server,
    workspaceUrl: c.workspaceUrl,
    historySize: c.historySize,
    dbPath: path.resolve(repoRoot, c.dbPath),
    endpoints,
  };
}
