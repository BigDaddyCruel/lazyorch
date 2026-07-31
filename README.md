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
    gui/         # Tauri 2 + web UI (placeholder)
  docs/
  tests/
```

## Requirements

- **Node.js** ≥ 20
- **pnpm** (see `packageManager` in root `package.json`)

## Setup

```bash
pnpm install
```

## Scripts

| Command              | Description                          |
| -------------------- | ------------------------------------ |
| `pnpm lint`          | ESLint across the monorepo           |
| `pnpm format`        | Prettier write                       |
| `pnpm format:check`  | Prettier check                       |
| `pnpm typecheck`     | TypeScript `--noEmit` in all packages |
| `pnpm test`          | Vitest (unit)                        |
| `pnpm build`         | Build all packages                   |

## License

[MIT](LICENSE)
