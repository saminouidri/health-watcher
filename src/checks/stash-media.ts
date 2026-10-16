// Stash stream check.
// Endpoint: GET /scene/{id}/stream — the direct-stream route (internal/api/routes_scene.go), which is
// also what the GraphQL field Scene.paths.stream resolves to.
// Auth: `ApiKey` request header (pkg/session/session.go: ApiKeyHeader = "ApiKey"); key from
// Settings → Security → API Key. Unauthenticated requests are redirected to /login.
import { z } from 'zod';
import { readFirstChunk } from './stream.ts';
import { defineCheck } from './types.ts';

export default defineCheck({
  type: 'stash-media',
  options: z.object({
    baseUrl: z.url().default('http://srxserver:9999'),
    /** Numeric scene id (from /scenes/<id> in the web UI). */
    sceneId: z.union([z.string().min(1), z.number().int()]).transform(String),
    /** Name of the secret holding the API key. Leave unset in config.local.yaml if Stash has no login. */
    apiKeySecret: z.string().default('STASH_API_KEY'),
  }),
  describe: (o) => `stream scene ${o.sceneId} from ${o.baseUrl}`,
  async run(o, ctx) {
    const key = ctx.secret(o.apiKeySecret);
    const url = `${o.baseUrl.replace(/\/$/, '')}/scene/${encodeURIComponent(o.sceneId)}/stream`;
    const outcome = await readFirstChunk(ctx, url, key ? { ApiKey: key } : {});
    if (!outcome.ok && !key && outcome.message?.includes('redirect')) {
      outcome.message = `${outcome.message} — secret ${o.apiKeySecret} is not set`;
    }
    return outcome;
  },
});
