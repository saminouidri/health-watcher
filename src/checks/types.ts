// Common interface for check modules. To add a check type: create a file exporting a
// CheckModule and register it in ./index.ts.
import type { z } from 'zod';

export type Status = 'up' | 'degraded' | 'down';

export interface CheckContext {
  /** Injected so tests can mock the network. */
  fetch: typeof fetch;
  /** Aborted when the check's timeout elapses. Pass it to fetch and any other cancellable work. */
  signal: AbortSignal;
  /** Resolve a secret by name (env var, then `secrets:` in config.local.yaml). */
  secret(name: string): string | undefined;
}

export interface CheckOutcome {
  ok: boolean;
  /** Passed, but something is off (module-specific). Latency thresholds are applied by the runner. */
  degraded?: boolean;
  /** Short human-readable reason; shown as the card's error when not ok/degraded. */
  message?: string;
}

export interface CheckModule<O = unknown> {
  type: string;
  /** Validates the type-specific fields of an endpoint entry (unknown keys are ignored). */
  options: z.ZodType<O>;
  /** One-line description of what is checked, shown on the card (must not include secrets). */
  describe(opts: O): string;
  run(opts: O, ctx: CheckContext): Promise<CheckOutcome>;
}

/** Helper to keep option types inferred when declaring a module. */
export const defineCheck = <S extends z.ZodType>(m: CheckModule<z.infer<S>> & { options: S }) => m;
