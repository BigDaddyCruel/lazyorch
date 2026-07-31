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
| **Logs** | Live `/v1/events` stream (demo seed when offline) |
| **Settings** | Daemon URL, Bearer token, poll interval, demo fallback |

**Gates badge** appears on Home / Run board nav when pending gates exist.

## Prerequisites

- Node.js ≥ 20, pnpm (repo root)
- Running daemon optional for UI development (demo board fills empty runs):

  ```bash
  pnpm --filter @lazyorch/cli exec node dist/index.js serve
  # or: lazyorch serve
  ```

- For native window builds only: [Rust](https://rustup.rs/) + platform WebView deps
  ([Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))

## Web UI (primary — CI-friendly)

From repo root:

```bash
pnpm install
pnpm --filter @lazyorch/gui dev        # http://127.0.0.1:1420 (CORS-allowlisted)
pnpm --filter @lazyorch/gui typecheck
pnpm --filter @lazyorch/gui test
pnpm --filter @lazyorch/gui build      # static assets → apps/gui/dist
```

Environment (optional):

| Variable | Meaning |
|----------|---------|
| `VITE_LAZYORCH_URL` | Default daemon base (default `http://127.0.0.1:7420`) |
| `VITE_LAZYORCH_TOKEN` | Default Bearer token |
| `VITE_USE_DEMO=0` | Disable demo board fallback |

Browser requests send `Origin`, so the daemon requires a Bearer token (see `~/.lazyorch/daemon.token`). Paste it under **Settings**.

## Tauri native shell (optional)

Scaffold lives in `src-tauri/`. Full native compile is **not** required for monorepo CI.

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
         /health, /v1/status, /v1/projects, /v1/runs,
         /v1/adapters, /v1/models/route, /v1/events
```

- **API client:** `src/api/client.ts`
- **Pure UI logic (tested):** `src/lib/*` (kanban, gates badge, phases)
- **Demo fixtures:** `src/api/demo-data.ts` when daemon runs are empty/unrich

Gate approve/reject remains CLI-first (`lazyorch gate`) until daemon gate HTTP is added; the board is read-only for gates.

## Tests

```bash
pnpm --filter @lazyorch/gui test
```

Unit/smoke tests cover kanban grouping, gate badges, phase timeline helpers, settings validation, and the daemon HTTP client (mocked `fetch`).
