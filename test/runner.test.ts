import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { parseHealthConfig, type Endpoint } from '../src/config.ts';
import { HealthDb } from '../src/db.ts';
import { deepMerge, loadConfig } from '../src/load.ts';
import { describeError, runCheck } from '../src/runner.ts';
import { resolveBindHost } from '../src/server.ts';
import type { CheckModule, CheckOutcome } from '../src/checks/types.ts';

const deps = { fetch: globalThis.fetch, secret: () => undefined };

function ep(run: CheckModule['run'], extra: Partial<Endpoint> = {}): Endpoint {
  const module: CheckModule = { type: 'fake', options: z.any(), describe: () => 'fake', run };
  return { id: 'e', name: 'E', type: 'fake', target: 'fake', intervalMs: 60_000, timeoutMs: 1000, module, opts: {}, ...extra };
}

describe('runCheck', () => {
  it('maps ok → up with latency', async () => {
    const r = await runCheck(ep(async () => ({ ok: true })), deps);
    assert.equal(r.status, 'up');
    assert.equal(r.error, null);
    assert.ok(r.latencyMs! >= 0);
  });

  it('maps failure → down with the message', async () => {
    const r = await runCheck(ep(async () => ({ ok: false, message: 'boom' })), deps);
    assert.equal(r.status, 'down');
    assert.equal(r.error, 'boom');
  });

  it('times out (even if the check ignores the abort signal) and counts it as down', async () => {
    const r = await runCheck(ep(() => new Promise<CheckOutcome>(() => {}), { timeoutMs: 50 }), deps);
    assert.equal(r.status, 'down');
    assert.equal(r.error, 'timed out after 50 ms');
  });

  it('aborts the signal on timeout', async () => {
    let aborted = false;
    const run: CheckModule['run'] = (_o, c) =>
      new Promise((_, reject) =>
        c.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        }),
      );
    const r = await runCheck(ep(run, { timeoutMs: 30 }), deps);
    assert.equal(aborted, true);
    assert.equal(r.status, 'down');
  });

  it('reports degraded when slower than degradedLatencyMs', async () => {
    const slow = () => new Promise<CheckOutcome>((res) => setTimeout(() => res({ ok: true }), 40));
    const r = await runCheck(ep(slow, { degradedLatencyMs: 10 }), deps);
    assert.equal(r.status, 'degraded');
    assert.match(r.error!, /slow/);
  });

  it('turns thrown errors into down, surfacing the cause code', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:80'), { code: 'ECONNREFUSED' });
    const r = await runCheck(ep(async () => { throw new TypeError('fetch failed', { cause }); }), deps);
    assert.equal(r.status, 'down');
    assert.match(r.error!, /ECONNREFUSED/);
    assert.equal(describeError('x'), 'x');
  });

  it('never runs a misconfigured endpoint', async () => {
    const r = await runCheck({ ...ep(async () => ({ ok: true })), configError: 'bad' }, deps);
    assert.equal(r.status, 'down');
    assert.equal(r.error, 'bad');
  });
});

describe('config', () => {
  const load = (raw: unknown) => parseHealthConfig({ raw: raw as Record<string, unknown>, secret: () => undefined });

  it('merges config.local endpoint overrides by id', () => {
    const base = { endpoints: [{ id: 'a', url: 'x', n: 1 }, { id: 'b', url: 'y' }], keep: true };
    const over = { endpoints: [{ id: 'b', url: 'z' }, { id: 'c', url: 'w' }] };
    assert.deepEqual(deepMerge(base, over), {
      endpoints: [{ id: 'a', url: 'x', n: 1 }, { id: 'b', url: 'z' }, { id: 'c', url: 'w' }],
      keep: true,
    });
    assert.deepEqual(deepMerge({ list: [1, 2] }, { list: [3] }), { list: [3] });
  });

  it('flags unknown types, placeholders, invalid options and duplicates instead of crashing', () => {
    const c = load({
      endpoints: [
        { id: 'a', name: 'A', type: 'nope' },
        { id: 'b', name: 'B', type: 'jellyfin-media', itemId: 'CHANGE_ME' },
        { id: 'c', name: 'C', type: 'http', url: 'not a url' },
        { id: 'd', name: 'D', type: 'http', url: 'http://ok/' },
        { id: 'd', name: 'D2', type: 'http', url: 'http://ok/' },
      ],
    });
    const errs = Object.fromEntries(c.endpoints.map((e) => [e.name, e.configError]));
    assert.match(errs.A!, /unknown check type "nope"/);
    assert.match(errs.B!, /not configured: set itemId/);
    assert.match(errs.C!, /invalid config: url/);
    assert.equal(errs.D, undefined);
    assert.match(errs.D2!, /duplicate/);
    const d = c.endpoints.find((e) => e.name === 'D')!;
    assert.equal(d.target, 'GET http://ok/');
    assert.equal(d.intervalMs, 60_000);
    assert.equal(d.timeoutMs, 10_000);
  });

  it('parses the committed config.yaml', () => {
    const cfg = parseHealthConfig({ ...loadConfig(), secret: () => undefined });
    assert.ok(cfg.endpoints.length > 0);
    for (const e of cfg.endpoints) assert.doesNotMatch(e.configError ?? '', /invalid|unknown|duplicate/);
  });
});

describe('resolveBindHost', () => {
  const ifaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [{ address: '192.168.0.50', family: 'IPv4', internal: false }],
    tailscale0: [{ address: '100.69.101.67', family: 'IPv4', internal: false }],
  } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;

  it('picks the private LAN address, never Tailscale/loopback', () => {
    assert.equal(resolveBindHost('lan', ifaces), '192.168.0.50');
  });
  it('accepts IPs and interface names', () => {
    assert.equal(resolveBindHost('10.0.0.5', ifaces), '10.0.0.5');
    assert.equal(resolveBindHost('eth0', ifaces), '192.168.0.50');
    assert.throws(() => resolveBindHost('wlan9', ifaces), /wlan9/);
  });
});

describe('HealthDb', () => {
  it('keeps only the last N results and reports the last stored error', () => {
    const db = new HealthDb(':memory:', 3);
    for (let i = 0; i < 5; i++) {
      db.insert({ endpointId: 'x', checkedAt: i, status: i === 1 ? 'down' : 'up', latencyMs: i, error: i === 1 ? 'err' : null });
    }
    assert.deepEqual(db.history('x').map((h) => h.t), [2, 3, 4]);
    assert.equal(db.latest('x')?.checkedAt, 4);
    assert.equal(db.lastError('x'), undefined); // the failure was pruned with the history
    db.insert({ endpointId: 'x', checkedAt: 9, status: 'down', latencyMs: null, error: 'later' });
    assert.deepEqual(db.lastError('x'), { at: 9, error: 'later' });
    db.close();
  });
});
