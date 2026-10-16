// Reads a file (typically on a network share) and verifies it is non-empty, optionally matching a checksum.
// If the share is unmounted, its mountpoint is usually an empty directory on the local disk (or gone),
// and the file would just look "missing". We detect that explicitly by checking that the mountpoint is
// on a different device than its parent directory, and report "not mounted" instead.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineCheck, type CheckOutcome } from './types.ts';

const READ_BYTES = 64 * 1024;

/** On macOS, /Volumes/<name>/... implies the mountpoint /Volumes/<name>. */
export function inferMountPoint(file: string, platform = process.platform): string | undefined {
  if (platform !== 'darwin') return undefined;
  const m = /^\/Volumes\/[^/]+/.exec(path.posix.normalize(file));
  return m?.[0];
}

export async function checkMounted(mountPoint: string): Promise<CheckOutcome | null> {
  let mp, parent;
  try {
    mp = await fs.stat(mountPoint);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, message: `share not mounted: ${mountPoint} does not exist (${code})` };
  }
  if (!mp.isDirectory()) return { ok: false, message: `mount point ${mountPoint} is not a directory` };
  try {
    parent = await fs.stat(path.dirname(mountPoint));
  } catch {
    return null; // can't compare; fall through to reading the file
  }
  if (mp.dev === parent.dev) {
    return { ok: false, message: `share not mounted: ${mountPoint} is a plain local directory, not a mount` };
  }
  return null;
}

function sha256(file: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file, { signal })
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

export default defineCheck({
  type: 'file-read',
  options: z.object({
    path: z.string().min(1),
    /** Directory that must be a mount. Defaults to /Volumes/<share> for /Volumes paths on macOS; omit elsewhere. */
    mountPoint: z.string().optional(),
    /** Optional expected SHA-256 (hex) of the whole file. */
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
  }),
  describe: (o) => `read ${o.path}${o.sha256 ? ' (sha256)' : ''}`,
  async run(o, ctx) {
    const mountPoint = o.mountPoint ?? inferMountPoint(o.path);
    if (mountPoint) {
      const notMounted = await checkMounted(mountPoint);
      if (notMounted) return notMounted;
    }

    let st;
    try {
      st = await fs.stat(o.path);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      return { ok: false, message: err.code === 'ENOENT' ? `file not found: ${o.path}` : `cannot stat ${o.path}: ${err.code ?? err.message}` };
    }
    if (!st.isFile()) return { ok: false, message: `${o.path} is not a regular file` };
    if (st.size === 0) return { ok: false, message: `file is empty: ${o.path}` };

    if (o.sha256) {
      const actual = await sha256(o.path, ctx.signal);
      if (actual.toLowerCase() !== o.sha256.toLowerCase()) {
        return { ok: false, message: `checksum mismatch (got ${actual.slice(0, 12)}…)` };
      }
      return { ok: true };
    }

    // stat can be answered from cache; actually read bytes to prove the share serves data.
    const fh = await fs.open(o.path, 'r');
    try {
      const { bytesRead } = await fh.read(Buffer.alloc(READ_BYTES), 0, READ_BYTES, 0);
      if (bytesRead === 0) return { ok: false, message: `read 0 bytes from ${o.path}` };
    } finally {
      await fh.close();
    }
    return { ok: true };
  },
});
