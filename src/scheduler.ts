import type { Endpoint } from './config.ts';
import type { HealthDb } from './db.ts';
import { runCheck, type CheckResult, type RunnerDeps } from './runner.ts';

/** Runs every endpoint on its interval; manual checks join an in-flight run instead of overlapping it. */
export class Scheduler {
  private inflight = new Map<string, Promise<CheckResult>>();
  private timers: NodeJS.Timeout[] = [];

  readonly endpoints: Endpoint[];
  private db: HealthDb;
  private deps: RunnerDeps;

  constructor(endpoints: Endpoint[], db: HealthDb, deps: RunnerDeps) {
    this.endpoints = endpoints;
    this.db = db;
    this.deps = deps;
  }

  start() {
    // Misconfigured endpoints are shown with their config error and never run.
    for (const ep of this.endpoints.filter((e) => !e.configError)) {
      void this.check(ep.id);
      this.timers.push(setInterval(() => void this.check(ep.id), ep.intervalMs));
    }
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  isRunning(id: string) {
    return this.inflight.has(id);
  }

  check(id: string): Promise<CheckResult> {
    const existing = this.inflight.get(id);
    if (existing) return existing;
    const ep = this.endpoints.find((e) => e.id === id);
    if (!ep) return Promise.reject(new Error(`unknown endpoint ${id}`));
    const p = runCheck(ep, this.deps)
      .then((r) => {
        this.db.insert(r);
        return r;
      })
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  checkAll() {
    return Promise.all(this.endpoints.map((e) => this.check(e.id)));
  }
}
