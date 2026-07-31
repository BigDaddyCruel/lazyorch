# LazyOrch release & install notes (private beta)

Operator notes for installing LazyOrch, running the daemon, and hardening defaults on Windows and Unix. Architecture details: [`design-lazyorch.md`](./design-lazyorch.md). Day-to-day CLI: [`user-guide.md`](./user-guide.md). Daemon HTTP surface: [`openapi.yaml`](./openapi.yaml) (private-beta freeze).

## Status

LazyOrch is **private-beta ready** for dogfood on a single operator machine:

- CLI + user-level daemon (loopback)
- Multi-adapter registry (claude / codex / agy / grok / shell / generic)
- Planning → implement → review/QA → forge MVP
- Windows GUI MVP (Tauri)
- Secret scrubbing on session env + prompt materialization; display redaction in `lazyorch logs`

Not yet a full production SaaS: no multi-tenant daemon, no cloud control plane, no signed installers.

## Install options

### A. Monorepo / local development (current default)

```bash
git clone <repo-url> lazyorch
cd lazyorch
pnpm install
pnpm build
# CLI binary from workspace package:
pnpm --filter @lazyorch/cli exec lazyorch -- --help
# or link the bin after build:
node packages/cli/dist/index.js --help
```

Requirements: **Node.js ≥ 20**, **pnpm** (see root `packageManager`).

### B. Global npm install (when published)

Once a release is published to the registry:

```bash
npm install -g lazyorch
# provides `lazyorch` (CLI) and may ship `lazyorchd` depending on package layout
lazyorch --help
```

**Private beta:** packages are still `private: true` / `0.0.0` in the monorepo. Prefer option A until a versioned public tarball exists. If you publish a workspace subset:

1. Build all packages (`pnpm build`).
2. Publish `@lazyorch/*` in dependency order (or a single meta-package that bundles `dist/`).
3. Ensure the published `bin.lazyorch` points at the CLI entry with a Node shebang.
4. Document the exact npm package name in the release tag notes.

### C. Desktop GUI (Windows-first)

See [`apps/gui/README.md`](../apps/gui/README.md) for Tauri dev/build. GUI talks to the loopback daemon (`http://127.0.0.1:7420` by default) with Bearer auth when `Origin` is present.

## First run checklist

```bash
lazyorch init
lazyorch doctor
lazyorch serve --background
lazyorch start "Your idea"
lazyorch status
lazyorch gate list
```

- Daemon state: `~/.lazyorch/` (or `%USERPROFILE%\.lazyorch\`) — lockfile, token, optional worktrees.
- Project state: `<repo>/.lazyorch/`.
- Token file: `~/.lazyorch/daemon.token` (mode 0600 / Windows user ACL). Do not commit or paste into tickets.

## Windows notes

### Node / PATH

- Install Node 20+ LTS; ensure `node` and `npm`/`pnpm` are on `PATH` for the same user that runs the daemon.
- Coding CLIs (`claude`, `codex`, …) must be discoverable via `PATH`/`PATHEXT` or set as absolute `binary` paths in `.lazyorch/config.yml`.
- Prefer absolute paths when using version managers or npx shims.

### Long paths

```bash
git config --global core.longpaths true
```

Worktrees + monorepos can exceed legacy `MAX_PATH` without this.

### Worktree root (default)

On Windows, worktrees default under:

`%USERPROFILE%\.lazyorch\worktrees\<project_hash>\<task_id>\`

(short root **outside** the repo). Override with `workspace.worktree_root` if needed. Avoid nesting under OneDrive/Documents when possible.

### Windows Defender / antivirus

Real-time scanning of worktrees, `node_modules`, and session logs can slow agent runs. Optional exclusions (least privilege):

| Kind | Example |
|------|---------|
| Folders | `%USERPROFILE%\.lazyorch\`, repo `node_modules`, pnpm store |
| Processes | `node.exe`, `git.exe`, coding CLI executables |

**Do not** put secrets into worktree paths; exclusions reduce AV coverage.

### Line endings (contributors)

This repo uses LF. Prefer `git config core.autocrlf false` in the clone so format checks stay green.

### Shell / PowerShell

- Shell adapter allowlist is **basename-based** (`node`, `npm`, `pnpm`, …). `node.exe` matches `node`.
- Cancel uses process-tree kill (`taskkill /T /F /PID`).
- Running the daemon as a different user than the CLI breaks token/lock paths — use one interactive user for private beta.

## Security defaults (private beta)

| Control | Behavior |
|---------|----------|
| Daemon bind | `127.0.0.1` only by default |
| Bearer token | Required off-loopback, with browser `Origin`, or `--require-auth`; context **writes** always require Bearer |
| Session env | Scrubbed: no `GH_TOKEN` / `GITHUB_TOKEN` / `LAZYORCH_*` / `*_TOKEN` / `*_SECRET` / API keys in shell/generic spawn env |
| Coding CLI env | Same scrub, then re-inject allowlisted vendor keys (`ANTHROPIC_*`, `OPENAI_*`, `XAI_*`) for live auth |
| Prompts | `scrubText` redacts common token prefixes before writing `prompt.md` |
| `lazyorch logs` | Display-time redaction only; durable JSONL on disk is not rewritten |
| GUI Logs page | Display-time redaction of event payloads (same token patterns); SSE wire still raw |
| Shell adapter | Allowlist + deny_patterns — **not a full sandbox** (see below) |
| GitHub forge | Forge-owned; `gh` is **not** on the default agent shell allowlist |

### Shell allowlist (sandbox boundary)

Default allowed basenames: `git`, `npm`, `pnpm`, `node`, `npx`, `vitest`, `tsc`, `eslint`.

Default deny patterns: `rm -rf /`, `git push --force`, `git push -f`.

**Important:** once a binary is allowlisted, argv is largely unconstrained unless a deny pattern matches (e.g. `node -e`, `npm exec`). For unattended private-beta runs:

1. Keep the default allowlist; do **not** add unrestricted shells (`bash`, `cmd`, `powershell`) without a human gate.
2. Add project-specific deny patterns (e.g. `node\s+-e`, destructive disk tools) in `.lazyorch/config.yml` under `shell.deny_patterns`.
3. Prefer deterministic acceptance commands that invoke known scripts (`pnpm test`, `tsc -b`) rather than ad-hoc one-liners.
4. Outside-allowlist commands should go through approval policy / gates (scheduler concern).

See also the shell section in [`user-guide.md`](./user-guide.md#shell-adapter-allowlist).

## OpenAPI freeze

[`openapi.yaml`](./openapi.yaml) documents the private-beta HTTP surface. Clients (GUI, external tools) should treat path/method contracts as stable within `api_major: 1`. Additive response fields may appear; removals require a major bump.

## Verification before tagging a beta

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
lazyorch doctor   # in a sample repo after init
```

## Further reading

- User guide: [`user-guide.md`](./user-guide.md)
- Design / threat model: [`design-lazyorch.md`](./design-lazyorch.md) (Security & Privacy)
- OpenAPI: [`openapi.yaml`](./openapi.yaml)
