import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import fileRead, { inferMountPoint } from '../src/checks/file-read.ts';
import http from '../src/checks/http.ts';
import jellyfinMedia from '../src/checks/jellyfin-media.ts';
import stashMedia from '../src/checks/stash-media.ts';
import type { CheckContext } from '../src/checks/types.ts';

/** A Response whose body is a stream we can observe (to assert it gets cancelled after one chunk). */
function streamResponse(status: number, chunks: Uint8Array[]) {
  let cancelled = false;
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(chunks[i++]);
      else c.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { res: new Response(body, { status }), wasCancelled: () => cancelled };
}

/** Context with a fake fetch that records its calls. No real network is used. */
function ctx(impl: () => Promise<Response>, secrets: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit & { headers: Record<string, string> } }[] = [];
  const c: CheckContext = {
    fetch: (async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
      calls.push({ url, init });
      return impl();
    }) as unknown as typeof fetch,
    signal: new AbortController().signal,
    secret: (n) => secrets[n],
  };
  return { c, calls };
}

const parse = <T>(m: { options: { parse(x: unknown): T } }, o: unknown) => m.options.parse(o);

describe('http', () => {
  it('passes on the expected status', async () => {
    const { c } = ctx(async () => new Response('ok'));
    assert.deepEqual(await http.run(parse(http, { url: 'http://x/health' }), c), { ok: true });
  });

  it('fails on an unexpected status', async () => {
    const { c } = ctx(async () => new Response('nope', { status: 503 }));
    assert.deepEqual(await http.run(parse(http, { url: 'http://x/' }), c), { ok: false, message: 'HTTP 503 (expected 200)' });
  });

  it('honours a custom expected status', async () => {
    const { c } = ctx(async () => new Response(null, { status: 204 }));
    assert.equal((await http.run(parse(http, { url: 'http://x/', expectStatus: 204 }), c)).ok, true);
  });

  it('checks the body substring', async () => {
    const { c: good } = ctx(async () => new Response('Healthy'));
    assert.equal((await http.run(parse(http, { url: 'http://x/', bodyContains: 'Healthy' }), good)).ok, true);
    const { c: bad } = ctx(async () => new Response('Unhealthy'));
    const r = await http.run(parse(http, { url: 'http://x/', bodyContains: 'Degraded' }), bad);
    assert.equal(r.ok, false);
    assert.match(r.message!, /does not contain "Degraded"/);
  });

  it('propagates network errors (the runner turns them into "down")', async () => {
    const { c } = ctx(async () => {
      throw new TypeError('fetch failed');
    });
    await assert.rejects(http.run(parse(http, { url: 'http://x/' }), c), /fetch failed/);
  });
});

describe('jellyfin-media', () => {
  const o = parse(jellyfinMedia, { itemId: 'abc123' });

  it('requests the static stream with MediaBrowser auth and a Range header, then stops after one chunk', async () => {
    const s = streamResponse(206, [new Uint8Array([1, 2, 3]), new Uint8Array(1_000_000)]);
    const { c, calls } = ctx(async () => s.res, { JELLYFIN_API_KEY: 'k3y' });
    assert.deepEqual(await jellyfinMedia.run(o, c), { ok: true });
    assert.equal(calls[0].url, 'http://srxserver:8096/Videos/abc123/stream?static=true');
    assert.equal(calls[0].init.headers.Authorization, 'MediaBrowser Token="k3y"');
    assert.equal(calls[0].init.headers.Range, 'bytes=0-65535');
    assert.equal(calls[0].init.redirect, 'manual');
    assert.equal(s.wasCancelled(), true);
  });

  it('accepts a 200 (server ignoring Range)', async () => {
    const { c } = ctx(async () => streamResponse(200, [new Uint8Array([9])]).res, { JELLYFIN_API_KEY: 'k' });
    assert.equal((await jellyfinMedia.run(o, c)).ok, true);
  });

  it('fails without an API key, without calling the server', async () => {
    const { c, calls } = ctx(async () => new Response());
    const r = await jellyfinMedia.run(o, c);
    assert.equal(r.ok, false);
    assert.match(r.message!, /JELLYFIN_API_KEY/);
    assert.equal(calls.length, 0);
  });

  it('explains 401 and 404', async () => {
    const { c: c401 } = ctx(async () => new Response('', { status: 401 }), { JELLYFIN_API_KEY: 'k' });
    assert.match((await jellyfinMedia.run(o, c401)).message!, /401.*API key/);
    const { c: c404 } = ctx(async () => new Response('', { status: 404 }), { JELLYFIN_API_KEY: 'k' });
    assert.match((await jellyfinMedia.run(o, c404)).message!, /404.*not found/);
  });

  it('fails when the stream is empty', async () => {
    const { c } = ctx(async () => streamResponse(206, []).res, { JELLYFIN_API_KEY: 'k' });
    const r = await jellyfinMedia.run(o, c);
    assert.equal(r.ok, false);
    assert.match(r.message!, /no data/);
  });
});

describe('stash-media', () => {
  const o = parse(stashMedia, { sceneId: 42 });

  it('requests /scene/{id}/stream with the ApiKey header', async () => {
    const { c, calls } = ctx(async () => streamResponse(206, [new Uint8Array([1])]).res, { STASH_API_KEY: 's3cret' });
    assert.deepEqual(await stashMedia.run(o, c), { ok: true });
    assert.equal(calls[0].url, 'http://srxserver:9999/scene/42/stream');
    assert.equal(calls[0].init.headers.ApiKey, 's3cret');
    assert.equal(calls[0].init.headers.Range, 'bytes=0-65535');
  });

  it('reports a login redirect as an auth problem and mentions the missing secret', async () => {
    const { c, calls } = ctx(async () => new Response(null, { status: 302, headers: { location: '/login?returnURL=%2F' } }));
    const r = await stashMedia.run(o, c);
    assert.equal(r.ok, false);
    assert.match(r.message!, /302 redirect to \/login.*STASH_API_KEY is not set/);
    assert.equal('ApiKey' in calls[0].init.headers, false);
  });
});

describe('file-read', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-file-read-'));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const { c } = ctx(async () => new Response());
  const write = (name: string, data: string) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, data);
    return p;
  };

  it('passes for a non-empty file', async () => {
    assert.deepEqual(await fileRead.run(parse(fileRead, { path: write('ok.txt', 'hello') }), c), { ok: true });
  });

  it('fails for an empty file', async () => {
    const r = await fileRead.run(parse(fileRead, { path: write('empty.txt', '') }), c);
    assert.equal(r.ok, false);
    assert.match(r.message!, /empty/);
  });

  it('fails for a missing file', async () => {
    const r = await fileRead.run(parse(fileRead, { path: path.join(tmp, 'nope.txt') }), c);
    assert.match(r.message!, /^file not found/);
  });

  it('verifies the checksum', async () => {
    const p = write('sum.txt', 'checksum me');
    const good = createHash('sha256').update('checksum me').digest('hex');
    assert.equal((await fileRead.run(parse(fileRead, { path: p, sha256: good }), c)).ok, true);
    const r = await fileRead.run(parse(fileRead, { path: p, sha256: 'a'.repeat(64) }), c);
    assert.equal(r.ok, false);
    assert.match(r.message!, /checksum mismatch/);
  });

  it('reports an unmounted share (mountpoint is a plain local directory) as not mounted', async () => {
    // A fresh dir is on the same device as its parent: exactly what an unmounted /mnt/share looks like.
    const mp = path.join(tmp, 'share');
    fs.mkdirSync(mp);
    const r = await fileRead.run(parse(fileRead, { path: path.join(mp, 'file.txt'), mountPoint: mp }), c);
    assert.equal(r.ok, false);
    assert.match(r.message!, /^share not mounted: .* not a mount/);
  });

  it('reports a missing mountpoint as not mounted', async () => {
    const mp = path.join(tmp, 'gone');
    const r = await fileRead.run(parse(fileRead, { path: path.join(mp, 'f'), mountPoint: mp }), c);
    assert.match(r.message!, /^share not mounted: .* does not exist/);
  });

  it('infers /Volumes/<share> as the mountpoint on macOS only', () => {
    assert.equal(inferMountPoint('/Volumes/Main/dir/.healthcheck', 'darwin'), '/Volumes/Main');
    assert.equal(inferMountPoint('/Users/me/file', 'darwin'), undefined);
    assert.equal(inferMountPoint('/Volumes/Main/x', 'linux'), undefined);
  });
});
