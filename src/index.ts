import http from 'node:http';
import path from 'node:path';
import { parseHealthConfig } from './config.ts';
import { HealthDb } from './db.ts';
import { loadConfig, repoRoot } from './load.ts';
import { Scheduler } from './scheduler.ts';
import { createHandler, resolveBindHost } from './server.ts';

const loaded = loadConfig();
const cfg = parseHealthConfig(loaded);
const db = new HealthDb(cfg.dbPath, cfg.historySize);
const scheduler = new Scheduler(cfg.endpoints, db, { fetch: globalThis.fetch, secret: loaded.secret });
for (const ep of cfg.endpoints) if (ep.configError) console.warn(`endpoint ${ep.id}: ${ep.configError}`);

const host = process.env.HOST ?? resolveBindHost(cfg.server.host);
const port = Number(process.env.PORT ?? cfg.server.port);
const server = http.createServer(
  createHandler({ scheduler, db, publicDir: path.join(repoRoot, 'public'), meta: { workspaceUrl: cfg.workspaceUrl } }),
);
server.listen(port, host, () => {
  console.log(`health-monitor listening on http://${host}:${port} (${cfg.endpoints.length} endpoints)`);
  scheduler.start();
});

const shutdown = () => {
  scheduler.stop();
  server.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
