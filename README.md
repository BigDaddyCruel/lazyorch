# LazyOrch

AI agent orchestration daemon with multi-backend adapters, CLI, and desktop GUI.

LazyOrch coordinates long-running agent work across backends (Claude, Codex, Agy, Grok, shell, and generic), with planning, scheduling, git/GitHub integration, and a local daemon API.

> **Status:** Early scaffold. Packages are stubs; domain logic lands in follow-up PRs.

## Design

See the full design document:

- [`docs/design-lazyorch.md`](docs/design-lazyorch.md)

OpenAPI placeholder: [`docs/openapi.yaml`](docs/openapi.yaml)

## Monorepo layout

```
lazyorch/
  packages/
    core/        # FSM, tasks, planning, scheduling, types
    daemon/      # HTTP/WS server, process entry
    cli/         # lazyorch CLI
    adapters/    # registry + claude, codex, agy, grok, shell, generic
    forge/       # git + github
    shared/      # logging, ids, config schemas
  apps/
    gui/         # Tauri 2 + React/Vite web UI MVP
  docs/
  tests/
```

## Requirements

- **Node.js** ≥ 20
- **pnpm** (see `packageManager` in root `package.json`)

## Setup

```bash
pnpm install
pnpm build
```

Line endings are LF (see `.gitattributes` and Prettier `endOfLine: "lf"`). On Windows, prefer
`git config core.autocrlf false` in this repo so format checks stay green.

## Build & cross-package imports

Packages export compiled output from `dist/` (`exports` → `./dist/index.js` + `.d.ts`). With
`moduleResolution: "NodeNext"`, workspace imports resolve through those package `exports`, not
via TypeScript source maps alone.

Workflow:

1. **`pnpm build`** / **`pnpm typecheck`** use root **`tsc -b`**, which follows project references
   and builds packages in dependency order.
2. After a clean clone or `pnpm clean`, run **`pnpm build`** (or `typecheck`) before relying on
   cross-package `@lazyorch/*` imports at runtime or in tools that resolve only published
   `exports`.
3. Per-package `build` / `typecheck` scripts also use `tsc -b` so filtered builds rebuild
   dependencies when needed.

Unit tests run from the **repo root** (`pnpm test` / Vitest config includes). There are no
per-package `test` scripts.

## Scripts

| Command             | Description                                      |
| ------------------- | ------------------------------------------------ |
| `pnpm lint`         | ESLint across the monorepo                       |
| `pnpm format`       | Prettier write                                   |
| `pnpm format:check` | Prettier check                                   |
| `pnpm typecheck`    | `tsc -b` (project references, emits `dist`)      |
| `pnpm test`         | Vitest from repo root                            |
| `pnpm build`        | `tsc -b` packages + GUI Vite build               |
| `pnpm clean`        | `tsc -b --clean`                                 |
| `pnpm gui:dev`      | Vite dev server for `@lazyorch/gui` (:1420)      |
| `pnpm gui:build`    | Production web build for the GUI                 |

Desktop (Tauri) steps: see [`apps/gui/README.md`](apps/gui/README.md).

## License

[MIT](LICENSE)
