// Jellyfin stream check.
// Endpoint: GET /Videos/{itemId}/stream?static=true (static = send the original file, no transcode),
// per the server's own OpenAPI spec (/api-docs/openapi.json, Jellyfin 10.11).
// Auth: the spec's only security scheme is the `Authorization` header, in the documented
// `MediaBrowser Token="<api key>"` form.
import { z } from 'zod';
import { readFirstChunk } from './stream.ts';
import { defineCheck } from './types.ts';

export default defineCheck({
  type: 'jellyfin-media',
  options: z.object({
    baseUrl: z.url().default('http://srxserver:8096'),
    /** Jellyfin item id (the `id=` in the web UI's details URL). */
    itemId: z.string().min(1),
    /** Name of the secret holding the API key (Dashboard → API Keys). */
    apiKeySecret: z.string().default('JELLYFIN_API_KEY'),
  }),
  describe: (o) => `stream item ${o.itemId} from ${o.baseUrl}`,
  async run(o, ctx) {
    const key = ctx.secret(o.apiKeySecret);
    if (!key) return { ok: false, message: `secret ${o.apiKeySecret} is not set (config.local.yaml or env)` };
    const url = `${o.baseUrl.replace(/\/$/, '')}/Videos/${encodeURIComponent(o.itemId)}/stream?static=true`;
    return readFirstChunk(ctx, url, { Authorization: `MediaBrowser Token="${key}"` });
  },
});
