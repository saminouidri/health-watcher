import { z } from 'zod';
import { defineCheck } from './types.ts';

export default defineCheck({
  type: 'http',
  options: z.object({
    url: z.url(),
    expectStatus: z.number().int().default(200),
    /** Optional substring the response body must contain. */
    bodyContains: z.string().optional(),
  }),
  describe: (o) => `GET ${o.url}`,
  async run(o, ctx) {
    const res = await ctx.fetch(o.url, { signal: ctx.signal, redirect: 'follow' });
    if (res.status !== o.expectStatus) {
      await res.body?.cancel();
      return { ok: false, message: `HTTP ${res.status} (expected ${o.expectStatus})` };
    }
    if (o.bodyContains !== undefined) {
      const body = await res.text();
      if (!body.includes(o.bodyContains)) {
        return { ok: false, message: `response body does not contain "${o.bodyContains}"` };
      }
    } else {
      await res.body?.cancel();
    }
    return { ok: true };
  },
});
