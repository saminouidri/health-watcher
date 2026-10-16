# Progress

## Origin

Split out of `command-center` on 2026-10-16 at the user's request. Health checks run on a separate machine (a Raspberry Pi 3) so the dashboard can tell when srxserver itself is down. The user also asked to simplify the stack for the Pi.

## Decisions

- **Stack changed from the brief** (Fastify/React/Vite/better-sqlite3) at the user's request ("simplify the stack"). It is now plain Node + `node:http` + `node:sqlite` + vanilla JS, TypeScript run via Node type stripping, with no build step. The Pi doesn't need to compile native modules or run Vite. Requires Node ≥ 22.18.
- **Tests use `node --test`** (built in) instead of vitest. The network is mocked with an injected `fetch`. `file-read` uses real temp files: a fresh temp dir sits on the same device as its parent, which is exactly how an unmounted share looks.
- **One config file, no `health:` section.** `config.local.yaml` merges endpoint overrides by `id`.
- **Bind address:** `host: lan` auto-picks the first private IPv4 and excludes Tailscale `100.x`. It never binds `0.0.0.0`.
- **Status semantics:**
  - down = check failed, timed out, or misconfigured.
  - degraded = passed but slower than `degradedLatencyMs`, or the module flagged it.
- **Timeouts** both abort the signal and race the promise, so a hung SMB `stat` (which ignores signals) still reports down on time. Caveat: the hung syscall still occupies a libuv thread until the OS gives up.
- **"Last error"** shows the most recent stored error even if the endpoint has recovered since, with its timestamp. It disappears once that result ages out of the last-N history.
- **Media checks** send `Range: bytes=0-65535`, accept 200 or 206, read one non-empty chunk, then cancel the body so no full download happens. They don't follow redirects, so a Stash `/login` redirect is reported as an auth problem.
- **Styling:** the brief's Design section was left as a placeholder, so I took the minimal option. All tokens are in `public/theme.css`, with light/dark via `prefers-color-scheme`.

## Verified against real sources (not guessed)

- **Jellyfin 10.11.8:** `/Videos/{itemId}/stream` with `static`, and the security scheme (`Authorization` header), from the live server's `/api-docs/openapi.json`.
- **Stash:** the `/scene/{id}/stream` route and the `ApiKey` header (or `apikey` query param), from stash's GitHub source (develop branch). srxserver's Stash has login enabled (`/` → 302 `/login`), so an API key is required.
- **Live run on srxserver (2026-10-16):** Jellyfin `/health` and Stash `/healthz` were up. `/Volumes/Main` was detected as a real mount.

## Open items for the user

- Set `JELLYFIN_API_KEY`, `STASH_API_KEY`, `itemId`, and `sceneId` in `config.local.yaml`. The media checks have not been run against the real servers yet because no keys are configured.
- Create a `.healthcheck` file on the NAS share and mount the share on the Pi (README has an fstab line).
- The Pi itself hasn't been set up. The unit file assumes user `pi` and `/home/pi/health-monitor`.

## Milestones

1. ✅ Check modules (http, jellyfin-media, stash-media, file-read), runner, SQLite history, scheduler, API, health page, tests, systemd unit, README.
