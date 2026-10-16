# health-monitor

A small health dashboard for the homelab. It checks services on `srxserver` (and srxserver itself) from another machine, a Raspberry Pi 3, so it can still report when the Mac mini is down.

- A grid of endpoint cards, each showing status (up / degraded / down), latency, last-checked time, last error, and a latency sparkline.
- Checks run server-side on an interval (default 60 s). You can also run them manually per card or with **Check all**.
- The last N results per endpoint are kept in SQLite.

Companion app: **command-center** (projects, wiki, Claude usage) runs on srxserver at `http://srxserver:4401`.

## Stack (deliberately light for a Pi 3)

- **TypeScript, no build step.** Node ≥ 22.18 runs `.ts` files directly (type stripping), and `tsc` is used only for type-checking.
- **`node:http`** for the server, about 100 lines in `src/server.ts`.
- **`node:sqlite`** (built into Node) for history, so there are no native modules to compile on ARM.
- **Plain HTML/CSS/JS** frontend in `public/`, with no bundler.
- **Runtime dependencies:** `yaml` and `zod`, both pure JS.

## Setup

```sh
node --version          # needs >= 22.18 (22.x LTS or newer)
npm install --omit=dev  # add dev deps (typescript) only if you want `npm run typecheck`
cp config.local.example.yaml config.local.yaml   # then fill in keys / ids
npm start
```

Open `http://<pi-ip>:4400`.

### On the Raspberry Pi 3

Use **Raspberry Pi OS Lite (64-bit)**. Node publishes arm64 builds, and a 64-bit OS avoids 32-bit ARM support gaps. Install Node 22 or 24 LTS from NodeSource or the official tarball, then clone this repo to `/home/pi/health-monitor`.

Mount the NAS share for the `file-read` check, for example in `/etc/fstab`:

```
//192.168.1.235/Main  /mnt/nas-main  cifs  credentials=/home/pi/.smbcredentials,ro,uid=pi,nofail,_netdev  0  0
```

## Network binding (LAN only, no auth)

There is **no authentication**. The server binds to one LAN address only, never `0.0.0.0`:

- `server.host: lan` (the default) picks the first private IPv4 (10/8, 172.16/12, 192.168/16) and skips loopback and Tailscale/CGNAT `100.x` addresses.
- You can set an explicit IP (`192.168.0.50`) or an interface name (`eth0`, `wlan0`).
- The `HOST` and `PORT` env vars override the config.

Don't expose this port outside your LAN.

## Configuration

`config.yaml` is committed and holds no secrets. `config.local.yaml` (gitignored) is deep-merged over it. Endpoint lists merge **by `id`**, so you only list the fields you override. Secrets go under `secrets:` in `config.local.yaml` or in environment variables / `.env`; env vars win.

```yaml
server: { host: lan, port: 4400 }
workspaceUrl: http://srxserver:4401   # header link (optional)
checkIntervalSeconds: 60              # default for every endpoint
historySize: 60                       # results kept per endpoint
defaultTimeoutMs: 10000
dbPath: data/health.db
endpoints: [ ... ]
```

Every endpoint has `id` (slug, unique), `name`, `type`, and optionally:

- `timeoutMs` (a timeout counts as **down**)
- `intervalSeconds`
- `degradedLatencyMs` (a passing check slower than this is **degraded**)

An endpoint with an unknown type, invalid options, or a `CHANGE_ME` placeholder shows as down with the reason. The other endpoints keep working.

### `http`

GET a URL. It passes on the expected status, with an optional body substring match. Redirects are followed.

```yaml
- id: jellyfin
  name: Jellyfin
  type: http
  url: http://srxserver:8096/health
  expectStatus: 200        # default 200
  bodyContains: Healthy    # optional
  degradedLatencyMs: 2000
```

### `jellyfin-media`

Requests the start of an item's stream and passes if bytes arrive within the timeout. The transfer is cancelled after the first chunk.

- **Endpoint:** `GET /Videos/{itemId}/stream?static=true` with `Range: bytes=0-65535`
- **Auth header:** `Authorization: MediaBrowser Token="<key>"`

Both were taken from the server's own OpenAPI spec at `/api-docs/openapi.json` (Jellyfin 10.11).

```yaml
- id: jellyfin-media
  name: Jellyfin playback
  type: jellyfin-media
  baseUrl: http://srxserver:8096        # default
  itemId: 0123456789abcdef0123456789abcdef   # the id= in the web UI's item URL
  apiKeySecret: JELLYFIN_API_KEY        # secret name (default); create the key under Dashboard → API Keys
```

### `stash-media`

Works the same way for a Stash scene.

- **Endpoint:** `GET /scene/{id}/stream`, the direct-stream route in Stash's `internal/api/routes_scene.go`. It's also what GraphQL `Scene.paths.stream` points to.
- **Auth header:** `ApiKey: <key>`, per `pkg/session/session.go`.

A redirect to `/login` is reported as an auth problem.

```yaml
- id: stash-media
  name: Stash playback
  type: stash-media
  baseUrl: http://srxserver:9999   # default
  sceneId: 42                      # from /scenes/<id>
  apiKeySecret: STASH_API_KEY      # Settings → Security → API Key; leave unset if Stash has no login
```

### `file-read`

Reads a file and verifies it's non-empty, optionally matching a SHA-256. If `mountPoint` is set, the check first verifies that it is a **real mount**, meaning a different device from its parent directory. An unmounted share is reported as `share not mounted: …` instead of a confusing "file not found" from the empty local directory. On macOS, `/Volumes/<share>/…` paths infer `mountPoint` automatically.

```yaml
- id: nas
  name: Synology NAS
  type: file-read
  path: /mnt/nas-main/.healthcheck
  mountPoint: /mnt/nas-main
  sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08   # optional
  timeoutMs: 15000
```

Create a small, stable file on the share for this, for example `echo ok > .healthcheck` in the share root.

### Adding a check type

Create `src/checks/<type>.ts` exporting `defineCheck({ type, options: zodSchema, describe, run })`, then add it to `src/checks/index.ts`. `run` gets the validated options and a context with `fetch`, an abort `signal` (the timeout), and `secret(name)`. It returns `{ ok, degraded?, message? }`.

## Development

```sh
npm run dev        # binds 127.0.0.1, restarts on change
npm test           # node --test; network is mocked
npm run typecheck
```

## Run as a service (systemd, Raspberry Pi)

```sh
sudo cp deploy/health-monitor.service /etc/systemd/system/
# edit User= / WorkingDirectory= / node path (`which node`) if yours differ
sudo systemctl daemon-reload
sudo systemctl enable --now health-monitor
journalctl -u health-monitor -f
```

The unit waits for `network-online.target` and restarts every 10 s on failure, which also covers starting before the LAN address is assigned.
