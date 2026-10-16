import type { Endpoint } from './config.ts';
import type { Status } from './checks/types.ts';

export interface CheckResult {
  endpointId: string;
  checkedAt: number;
  status: Status;
  latencyMs: number | null;
  error: string | null;
}

export interface RunnerDeps {
  fetch: typeof fetch;
  secret(name: string): string | undefined;
}

class TimeoutError extends Error {}

/** Run one endpoint's check with a hard timeout. Never throws. */
export async function runCheck(ep: Endpoint, deps: RunnerDeps): Promise<CheckResult> {
  const checkedAt = Date.now();
  const done = (status: Status, latencyMs: number | null, error: string | null): CheckResult => ({
    endpointId: ep.id, checkedAt, status, latencyMs, error,
  });
  if (ep.configError || !ep.module) return done('down', null, ep.configError ?? 'not configured');

  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  // Racing the timeout (not just aborting) also covers work that ignores the signal, like a hung SMB stat.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new TimeoutError());
    }, ep.timeoutMs);
  });
  const start = performance.now();
  try {
    const outcome = await Promise.race([
      ep.module.run(ep.opts, { fetch: deps.fetch, signal: ac.signal, secret: deps.secret }),
      timeout,
    ]);
    const latency = Math.round(performance.now() - start);
    if (!outcome.ok) return done('down', latency, outcome.message ?? 'check failed');
    const slow = ep.degradedLatencyMs !== undefined && latency > ep.degradedLatencyMs;
    if (outcome.degraded || slow) {
      return done('degraded', latency, outcome.message ?? `slow: ${latency} ms > ${ep.degradedLatencyMs} ms`);
    }
    return done('up', latency, null);
  } catch (e) {
    const latency = Math.round(performance.now() - start);
    if (e instanceof TimeoutError || ac.signal.aborted) {
      return done('down', latency, `timed out after ${ep.timeoutMs} ms`);
    }
    return done('down', latency, describeError(e));
  } finally {
    clearTimeout(timer);
  }
}

/** Node's fetch hides the useful part (ECONNREFUSED, ENOTFOUND…) in error.cause. */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause;
  if (cause instanceof Error) return `${e.message}: ${cause.message}`;
  return e.message;
}
