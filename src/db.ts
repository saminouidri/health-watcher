import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CheckResult } from './runner.ts';

export interface HistoryPoint {
  t: number;
  status: CheckResult['status'];
  latencyMs: number | null;
}

export class HealthDb {
  private db: DatabaseSync;
  private historySize: number;

  constructor(file: string, historySize: number) {
    this.historySize = historySize;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS results (
        id INTEGER PRIMARY KEY,
        endpoint_id TEXT NOT NULL,
        checked_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        latency_ms INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS results_ep_time ON results (endpoint_id, checked_at);
    `);
  }

  insert(r: CheckResult) {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT INTO results (endpoint_id, checked_at, status, latency_ms, error) VALUES (?, ?, ?, ?, ?)')
        .run(r.endpointId, r.checkedAt, r.status, r.latencyMs, r.error);
      // Keep only the last N results per endpoint.
      this.db
        .prepare(
          `DELETE FROM results WHERE endpoint_id = ? AND id NOT IN
             (SELECT id FROM results WHERE endpoint_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?)`,
        )
        .run(r.endpointId, r.endpointId, this.historySize);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  latest(endpointId: string): CheckResult | undefined {
    const row = this.db
      .prepare('SELECT * FROM results WHERE endpoint_id = ? ORDER BY checked_at DESC, id DESC LIMIT 1')
      .get(endpointId) as unknown as Row | undefined;
    return row && toResult(row);
  }

  /** Last error message (results keep it even after the endpoint recovers). */
  lastError(endpointId: string): { at: number; error: string } | undefined {
    const row = this.db
      .prepare('SELECT checked_at, error FROM results WHERE endpoint_id = ? AND error IS NOT NULL ORDER BY checked_at DESC, id DESC LIMIT 1')
      .get(endpointId) as unknown as { checked_at: number; error: string } | undefined;
    return row && { at: row.checked_at, error: row.error };
  }

  history(endpointId: string): HistoryPoint[] {
    const rows = this.db
      .prepare('SELECT checked_at, status, latency_ms FROM results WHERE endpoint_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?')
      .all(endpointId, this.historySize) as unknown as Row[];
    return rows.reverse().map((r) => ({ t: r.checked_at, status: r.status as HistoryPoint['status'], latencyMs: r.latency_ms }));
  }

  close() {
    this.db.close();
  }
}

interface Row {
  endpoint_id: string;
  checked_at: number;
  status: string;
  latency_ms: number | null;
  error: string | null;
}

const toResult = (r: Row): CheckResult => ({
  endpointId: r.endpoint_id,
  checkedAt: r.checked_at,
  status: r.status as CheckResult['status'],
  latencyMs: r.latency_ms,
  error: r.error,
});
