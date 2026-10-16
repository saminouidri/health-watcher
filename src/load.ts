// Loads config.yaml (committed) merged with config.local.yaml (gitignored) and .env.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

/** Project root: the nearest ancestor of this file containing package.json. */
export const repoRoot = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('could not locate project root (package.json)');
    dir = parent;
  }
  return dir;
})();

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Deep-merge `over` onto `base`. Objects merge recursively. Arrays of objects that all carry an
 * `id` merge element-wise by id (so config.local.yaml can override one endpoint's fields, e.g. a
 * different file path on another machine); any other array is replaced wholesale.
 */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (isObj(base) && isObj(over)) {
    const out: Obj = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
    return out;
  }
  const byId = (a: unknown): a is Obj[] => Array.isArray(a) && a.every((x) => isObj(x) && typeof x.id === 'string');
  if (byId(base) && byId(over)) {
    const out = base.map((b) => {
      const o = over.find((x) => x.id === b.id);
      return o ? (deepMerge(b, o) as Obj) : b;
    });
    for (const o of over) if (!base.some((b) => b.id === o.id)) out.push(o);
    return out;
  }
  return over;
}

function readYaml(file: string): Obj {
  if (!fs.existsSync(file)) return {};
  const parsed = YAML.parse(fs.readFileSync(file, 'utf8'));
  if (parsed == null) return {};
  if (!isObj(parsed)) throw new Error(`${file}: top level must be a mapping`);
  return parsed;
}

export interface LoadedConfig {
  raw: Obj;
  /** Look up a secret: environment variable first, then `secrets:` in config.local.yaml. */
  secret(name: string): string | undefined;
}

export function loadConfig(root = repoRoot): LoadedConfig {
  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const configFile = process.env.HM_CONFIG ?? path.join(root, 'config.yaml');
  const localFile = process.env.HM_CONFIG_LOCAL ?? path.join(root, 'config.local.yaml');
  const raw = deepMerge(readYaml(configFile), readYaml(localFile)) as Obj;
  const secrets = isObj(raw.secrets) ? raw.secrets : {};
  delete raw.secrets;
  return {
    raw,
    secret: (name) => {
      const v = process.env[name] ?? secrets[name];
      return typeof v === 'string' && v.length > 0 ? v : undefined;
    },
  };
}
