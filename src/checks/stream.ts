// Shared helper for media checks: request the start of a stream and read the first chunk only.
import type { CheckContext, CheckOutcome } from './types.ts';

export const RANGE_BYTES = 64 * 1024;

export async function readFirstChunk(
  ctx: CheckContext,
  url: string,
  headers: Record<string, string>,
): Promise<CheckOutcome> {
  const res = await ctx.fetch(url, {
    headers: { ...headers, Range: `bytes=0-${RANGE_BYTES - 1}` },
    // Auth failures on these servers show up as redirects to a login page; don't follow them.
    redirect: 'manual',
    signal: ctx.signal,
  });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    const to = res.headers.get('location') ?? '?';
    return { ok: false, message: `HTTP ${res.status} redirect to ${to} (authentication required or API key invalid?)` };
  }
  if (res.status !== 200 && res.status !== 206) {
    await res.body?.cancel();
    const hint = res.status === 401 || res.status === 403 ? ' — check the API key' : res.status === 404 ? ' — item not found' : '';
    return { ok: false, message: `HTTP ${res.status}${hint}` };
  }
  if (!res.body) return { ok: false, message: `HTTP ${res.status} with no body` };

  const reader = res.body.getReader();
  try {
    // Skip any empty chunks; the first non-empty one proves media bytes are flowing.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { ok: false, message: `HTTP ${res.status} but the stream ended with no data` };
      if (value && value.byteLength > 0) return { ok: true };
    }
  } finally {
    // Stop the transfer: we only wanted the first chunk, not the whole file.
    await reader.cancel().catch(() => {});
  }
}
