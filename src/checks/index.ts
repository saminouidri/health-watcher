import fileRead from './file-read.ts';
import http from './http.ts';
import jellyfinMedia from './jellyfin-media.ts';
import stashMedia from './stash-media.ts';
import type { CheckModule } from './types.ts';

/** Registry of check types. Add new modules here. */
export const checkModules: Record<string, CheckModule<any>> = Object.fromEntries(
  [http, jellyfinMedia, stashMedia, fileRead].map((m) => [m.type, m]),
);
