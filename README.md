# LazyOrch

AI agent orchestration daemon with multi-backend adapters, CLI, and desktop GUI.

LazyOrch coordinates long-running agent work across backends (Claude, Codex, Agy, Grok, shell, and generic), with planning, scheduling, git/GitHub integration, and a local daemon API.

> **Status:** Active development. Core orchestration, adapters, CLI, and forge MVP are in tree; GUI remains early.

## User guide

Operator docs (init, doctor, start, gates, adapters, custom CLIs, Windows Defender/path notes):

- **[`docs/user-guide.md`](docs/user-guide.md)**

## Design

Full design document and key decisions:

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
    gui/         # Tauri 2 + web UI (placeholder)
  docs/          # design + user-guide.md
  tests/
    fixtures/    # adapter record/replay samples (fake mode)
    e2e/         # planning freeze + implement smoke (no live LLM)
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

Unit and E2E tests run from the **repo root** (`pnpm test` / Vitest config includes
`packages/**` and `tests/**`). There are no per-package `test` scripts.

Adapter **fake-mode** fixtures (record/replay without LLM keys) live under
[`tests/fixtures/adapters/`](tests/fixtures/adapters/). Planning freeze + implement
smoke is in [`tests/e2e/`](tests/e2e/). See the [user guide](docs/user-guide.md#fake--record-modes-ci-without-live-llms).

## Scripts

| Command             | Description                                      |
| ------------------- | ------------------------------------------------ |
| `pnpm lint`         | ESLint across the monorepo                       |
| `pnpm format`       | Prettier write                                   |
| `pnpm format:check` | Prettier check                                   |
| `pnpm typecheck`    | `tsc -b` (project references, emits `dist`)      |
| `pnpm test`         | Vitest from repo root                            |
| `pnpm build`        | `tsc -b` all TypeScript packages                 |
| `pnpm clean`        | `tsc -b --clean`                                 |

## License

[MIT](LICENSE)
