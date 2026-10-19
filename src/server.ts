// Minimal HTTP layer on node:http: a few JSON routes plus static files from public/.
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { HealthDb } from './db.ts';
import type { Scheduler } from './scheduler.ts';

export const serverSchema = z.object({
  /** "lan" (auto-detect private IPv4), an IP literal, or an interface name like "eth0". */
  host: z.string().default('lan'),
  port: z.number().int().positive(),
});
export type ServerConfig = z.infer<typeof serverSchema>;

const isPrivateV4 = (ip: string) =>
  /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

/** Resolve the configured host to a concrete address to bind. Never falls back to 0.0.0.0. */
export function resolveBindHost(spec: string, ifaces = os.networkInterfaces()): string {
  if (net.isIP(spec)) return spec;
  if (spec === 'localhost') return '127.0.0.1';
  const v4 = (name: string) =>
    (ifaces[name] ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address);
  if (spec === 'lan') {
    // Private ranges only: skips loopback, link-local, and VPN/Tailscale CGNAT (100.64/10) addresses.
    const all = Object.keys(ifaces).sort().flatMap(v4).filter(isPrivateV4);
    if (all.length === 0) throw new Error('host "lan": no private IPv4 address found on any interface');
    return all[0];
  }
  const addrs = v4(spec);
  if (addrs.length === 0) throw new Error(`host "${spec}": not an IP and no IPv4 address on an interface of that name`);
  return addrs[0];
}

/** Turn a zod error into a readable one-liner. */
export function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
};

export interface Deps {
  scheduler: Scheduler;
  db: HealthDb;
  publicDir: string;
  meta: { workspaceUrl?: string };
}

export function endpointView(id: string, { scheduler, db }: Pick<Deps, 'scheduler' | 'db'>) {
  const ep = scheduler.endpoints.find((e) => e.id === id)!;
  return {
    id: ep.id,
    name: ep.name,
    type: ep.type,
    target: ep.target,
    intervalSeconds: ep.intervalMs / 1000,
    timeoutMs: ep.timeoutMs,
    configError: ep.configError ?? null,
    running: scheduler.isRunning(ep.id),
    latest: db.latest(ep.id) ?? null,
    lastError: db.lastError(ep.id) ?? null,
    history: db.history(ep.id),
  };
}

export function createHandler(deps: Deps): http.RequestListener {
  const { scheduler } = deps;
  const all = () => scheduler.endpoints.map((e) => endpointView(e.id, deps));

  return async (req, res) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const p = url.pathname;
      const m = req.method ?? 'GET';

      if (p.startsWith('/api/')) {
        if (m === 'GET' && p === '/api/ping') return json(200, { ok: true });
        if (m === 'GET' && p === '/api/meta') return json(200, { workspaceUrl: deps.meta.workspaceUrl ?? null });
        if (m === 'GET' && p === '/api/endpoints') return json(200, all());
        if (m === 'POST' && p === '/api/check-all') {
          await scheduler.checkAll();
          return json(200, all());
        }
        const check = /^\/api\/endpoints\/([^/]+)\/check$/.exec(p);
        if (m === 'POST' && check) {
          const id = decodeURIComponent(check[1]);
          if (!scheduler.endpoints.some((e) => e.id === id)) return json(404, { error: 'unknown endpoint' });
          await scheduler.check(id);
          return json(200, endpointView(id, deps));
        }
        return json(404, { error: 'not found' });
      }

      if (m !== 'GET' && m !== 'HEAD') return json(405, { error: 'method not allowed' });
      // Static files. Single page, so anything unknown serves index.html.
      const rel = p === '/' ? 'index.html' : path.normalize(p).replace(/^[/\\]+/, '');
      let file = path.join(deps.publicDir, rel);
      if (!file.startsWith(deps.publicDir + path.sep)) file = path.join(deps.publicDir, 'index.html');
      let body: Buffer;
      try {
        body = await fs.readFile(file);
      } catch {
        file = path.join(deps.publicDir, 'index.html');
        body = await fs.readFile(file);
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(m === 'HEAD' ? undefined : body);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(500, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    }
  };
}
