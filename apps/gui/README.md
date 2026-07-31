# @lazyorch/gui

Windows-first LazyOrch desktop GUI: **Tauri 2** thin shell + **React/Vite** web UI.

The GUI is a pure client of the user-level daemon (HTTP + SSE). There is **no orchestration in Rust**.

## Screens (MVP)

| Screen | Purpose |
|--------|---------|
| **Home** | Connection status, projects, runs, pending gates, adapter health, model/tier dry-run |
| **Run board** | Run phase timeline + task kanban + gates list |
| **Plan** | Plan revision, issues, residual risks |
| **Agents** | Agent roster + adapter health + model/tier display |
| **Logs** | Live `/v1/events` stream (auto-reconnect; demo seed only when offline) |
| **Settings** | Daemon URL, Bearer token, poll interval, demo fallback |

**Gates badge** appears on Home / Run board nav when pending gates exist.

### Design screens deferred (post-MVP)

| Item | Notes |
|------|--------|
| **PR & CI** screen | Design lists this separately; not in MVP nav. Will surface forge PR/CI state when daemon exposes it. |
| **Gate approve/reject in GUI** | CLI-first (`lazyorch gate`); board gates are read-only. |
| **`ensureDaemon()` auto-start** | Design: CLI **and GUI** call `ensureDaemon()` (attach or spawn `serve --background`). This MVP requires a manually started daemon (`lazyorch serve`) + URL/token in Settings. Follow-up: invoke ensure from Tauri shell or a thin CLI sibling with clear offline UX if spawn fails. |
| **Shared OpenAPI/TS types package** | Client types are hand-mirrored stubs under `src/api/types.ts`. Generate or import from a shared package when run-detail/gate HTTP lands. |

## Prerequisites

- Node.js ≥ 20, pnpm (repo root)
- **Daemon must be running** for live data (MVP does not auto-spawn):

  ```bash
  pnpm --filter @lazyorch/cli exec node dist/index.js serve
  # or: lazyorch serve
  ```

- For UI development without a daemon, enable **demo fallback** in Settings (default on). Demo is used for **empty runs** or **offline transport only** — never when the daemon returns **401 Unauthorized**.
- For native window builds only: [Rust](https://rustup.rs/) + platform WebView deps
  ([Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))

## Auth (browser / Vite)

Browser requests send `Origin`, so the daemon **requires a Bearer token** on all non-`/health` routes (CSRF mitigation). Connectivity is gated on authenticated `GET /v1/status`, not public `/health` alone.

1. Start the daemon and read `~/.lazyorch/daemon.token` (or `%USERPROFILE%\.lazyorch\daemon.token`).
2. Paste the token under **Settings** → Save & reconnect.
3. Missing/wrong token → connection state **Auth required**; board stays empty (no demo mask).

## Web UI (primary — CI-friendly)

From repo root:

```bash
pnpm install
pnpm --filter @lazyorch/gui dev        # http://127.0.0.1:1420 (CORS-allowlisted)
pnpm --filter @lazyorch/gui typecheck
pnpm --filter @lazyorch/gui test
pnpm --filter @lazyorch/gui build      # static assets → apps/gui/dist
pnpm lint                              # includes apps/gui/src (browser globals)
```

Environment (optional):

| Variable | Meaning |
|----------|---------|
| `VITE_LAZYORCH_URL` | Default daemon base (default `http://127.0.0.1:7420`) |
| `VITE_LAZYORCH_TOKEN` | Default Bearer token |
| `VITE_USE_DEMO=0` | Disable demo board fallback by default |

## Tauri native shell (optional)

Scaffold lives in `src-tauri/`. Full native compile is **not** required for monorepo CI.

The shell is intentionally minimal (no process-shell plugin) until ensureDaemon / open-URL needs it.

```bash
cd apps/gui
pnpm install
# Generate proper multi-size icons when shipping:
#   pnpm tauri icon path/to/app-icon.png
pnpm tauri:dev      # dev window + vite
pnpm tauri:build    # release bundle (MSI/NSIS on Windows)
```

### Tauri build steps (Windows)

1. Install [Rust](https://rustup.rs/) stable and MSVC build tools / Visual Studio C++ workload.
2. Install WebView2 (usually preinstalled on Win10/11).
3. From repo root: `pnpm install` then `pnpm --filter @lazyorch/gui build` once to verify the web app.
4. `cd apps/gui && pnpm tauri:build`.
5. Artifacts under `apps/gui/src-tauri/target/release/bundle/`.

Replace placeholder icons under `src-tauri/icons/` before shipping (`pnpm tauri icon <png>`).

## Architecture

```
React UI ──HTTP/SSE──► LazyOrch daemon (packages/daemon)
              │
         /health (public liveness),
         /v1/status (auth gate), /v1/projects, /v1/runs,
         /v1/adapters, /v1/models/route, /v1/events (SSE + reconnect)
```

- **API client:** `src/api/client.ts` (`DaemonApiError`, `isUnauthorizedError`, SSE backoff)
- **Pure UI logic (tested):** `src/lib/*` (kanban, gates badge, phases)
- **Demo fixtures:** `src/api/demo-data.ts` — empty runs or offline only

## Tests

```bash
pnpm --filter @lazyorch/gui test
```

Unit/smoke tests cover kanban grouping, gate badges, phase timeline helpers, settings validation, unauthorized detection, getBoardRuns 401 non-masking, and SSE reconnect after EOF.
