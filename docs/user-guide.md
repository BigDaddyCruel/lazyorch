# LazyOrch user guide

Operator guide for initializing a project, checking the environment, starting runs, resolving gates, and registering adapters. For architecture and key decisions, see [`design-lazyorch.md`](./design-lazyorch.md).

## Requirements

- **Node.js** ≥ 20
- **pnpm** (see root `packageManager`)
- At least one coding CLI on `PATH` (or configured absolute path): Claude Code, Codex, Grok, Agy, shell, or a custom generic CLI
- **Git** available for worktrees and integrate
- **GitHub CLI (`gh`)** optional for forge MVP paths (PRs/checks/merge)

## Quick start

```bash
# From a git repository root
pnpm install          # monorepo / local dev
pnpm build            # emit package dist/ for workspace imports

# Or, once published globally:
# npm i -g lazyorch

lazyorch init
lazyorch doctor
lazyorch serve --background
lazyorch start "Add a health check endpoint and wire it into CI"
lazyorch status
```

## Project layout after `init`

```text
<repo>/
  .lazyorch/
    config.yml       # operator config (adapters, gates, slots, team, …)
    project.json     # project id + name
    runs/            # durable run / plan / gate state (created on start)
```

All business logic runs in a **user-level daemon**. The CLI is a client that also reads/writes local state under `.lazyorch/` for offline-friendly commands.

---

## `lazyorch init`

Creates the project skeleton.

```bash
lazyorch init
lazyorch init --name my-app
lazyorch init --repo /path/to/repo
lazyorch init --force          # overwrite config.yml / project.json
```

| Option | Meaning |
|--------|---------|
| `--name <n>` | Display name (default: directory basename) |
| `--repo <path>` | Repository root (default: cwd) |
| `--force` | Overwrite existing skeleton files |

Does **not** start the daemon or create a run.

---

## `lazyorch doctor`

Validates config, slot packing, and adapter bindings.

```bash
lazyorch doctor
lazyorch doctor --repo /path/to/repo
lazyorch doctor --ci              # headless defaults (timeout_action fail when unset)
lazyorch doctor --no-ci           # force interactive semantics even under CI env
```

- **Errors** fail the command (e.g. invalid YAML, packing that cannot start work).
- **Missing adapter binaries** are typically **warnings** so you can still edit config offline.
- In CI (`--ci` or `CI`/`GITHUB_ACTIONS`), gate `timeout_action` **effective default when the field is unset** is **fail** (KD-44). `lazyorch init` writes `timeout_action: none` explicitly; under CI, `doctor` **warns** rather than rewriting the skeleton. Set `gates.timeout_action: fail` in config (or remove the pin so CI default applies) for fail-closed headless runs.

Fix unbound adapters with absolute paths in `config.yml` or `lazyorch adapter register`, then re-run `doctor`.

---

## `lazyorch serve`

Ensures the user-level daemon is running.

```bash
lazyorch serve
lazyorch serve --background
lazyorch serve --port 8741 --host 127.0.0.1
lazyorch serve --home <lazyorch-home> --once
```

GUI and CLI both talk to this daemon. Prefer one daemon per user machine; projects register under the home directory registry.

---

## `lazyorch start`

Creates a **run** from an idea (phase `Inception`). Full orchestration ticks are daemon-owned; `start` persists the durable run entity and optional pins.

```bash
lazyorch start "Refactor auth middleware and add tests"
lazyorch start -f idea.md
lazyorch start "Ship feature X" --budget-usd 25
lazyorch start "…" --tier large --adapter claude
lazyorch start "…" --model claude-opus-4-6 --repo /path/to/repo
```

| Option | Meaning |
|--------|---------|
| positional / `-f` | Idea text or file |
| `--budget-usd n` | Soft budget hint on run context (not hard-enforced by `start`) |
| `--tier` | Pin model tier (`nano`…`xlarge`) |
| `--model` | Pin concrete model id |
| `--adapter` | Pin adapter id |
| `--repo` | Project root |

Pins are stored as a structured model pin under context key `model_pin/run` for `routeModel` / `models route --run`.

**Note:** `--yes` is **not** implemented and is rejected (exit 2) so operators are not misled about auto-skipping gates.

---

## Status, runs, and logs

```bash
lazyorch status
lazyorch status <run_id>
lazyorch status <run_id> --check          # exit 3 if pending gates (CI)

lazyorch run list
lazyorch run show <run_id>
lazyorch run show <run_id> --gate-exit    # same exit-3 opt-in

lazyorch logs --run <run_id>
lazyorch logs --run <run_id> --limit 50
lazyorch logs --run <run_id> --follow
```

Observational commands (`status`, `run show`, `gate list`) exit **0** by default when gates are pending. Pass `--check` or `--gate-exit` to exit **3** for CI.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | ok |
| 1 | error |
| 2 | usage |
| 3 | gate required / pending (opt-in on observational commands) |
| 4 | adapter missing |
| 5 | plan FSM / validators precondition |
| 6 | multi-PR not implemented (reserved) |

---

## Gates

Human (or CI) control points. List and resolve with:

```bash
lazyorch gate list
lazyorch gate list --run <run_id>
lazyorch gate list --all
lazyorch gate list --check              # exit 3 if any pending

lazyorch gate approve <gate_id> [--run id] [--decision action]
lazyorch gate reject  <gate_id> [--run id] [--decision action]
```

### Common gate types

| Type | When | Approve / reject notes |
|------|------|------------------------|
| `plan_approve` | Plan frozen | Approve → `Implementing`. Reject needs `--decision cancel\|revise` |
| `plan_dispute` | Writer `wontfix` vs reviewer re-open (high/critical) | `--decision accept_wontfix\|force_addressed\|abort` |
| `plan_max_rounds` | Consensus exhausted | `--decision force_approve\|edit\|abort` |
| `merge` | MergeReady | Approve records merge intent for forge |
| `human_intervention` | Terminal task policy / storm | Operator decides next steps |

Multi-outcome gates **require** `--decision`. Prefer `gate list` after `start` / planning to see payload hints.

Headless CI **effective default when unset** is fail-closed (`timeout_action: fail`), not auto-approve. Init skeletons pin `none` until you change config (doctor warns under CI).

---

## Adapters

LazyOrch runs agent sessions through a local **adapter registry**.

### Built-ins

| Id | Kind | Notes |
|----|------|-------|
| `claude` | first-class coding | Claude Code CLI |
| `codex` | first-class coding | OpenAI Codex CLI (`codex exec`) |
| `agy` | first-class coding | Best-effort model flag; bind binary via config if needed |
| `grok` | first-class coding | Candidates: `grok`, `grok-cli`, `xai` |
| `shell` | deterministic | Allowlisted commands only (no LLM) |
| *(generic)* | user-registered | `start_template` argv expansion |

### CLI

```bash
lazyorch adapter list
lazyorch adapter list --enabled
lazyorch adapter list --probe          # live version checks
lazyorch adapter test claude
lazyorch adapter test
```

List is resolve-only by default (no version spawn). Unbound adapters warn (exit 0); hard probe errors fail (exit 1).

### Config (`adapters` section)

```yaml
adapters:
  default: claude
  preference_order: [claude, codex, grok, agy, shell]
  # Optional per-id overrides: binary path, enabled, models, …
```

### Fake / record modes (CI without live LLMs)

Coding adapters support:

| Mode | Env / option | Behavior |
|------|----------------|----------|
| `live` | default | Spawn real binary |
| `fake` | `LAZYORCH_ADAPTER_MODE=fake` | No process; canned `SessionResult`; unbound OK |
| `record` | `LAZYORCH_ADAPTER_MODE=record` | Real spawn path + capture start records (bound binary required) |

**Hand-authored golden fixtures** (not live `record` captures) for first-class coding adapters live under [`tests/fixtures/adapters/`](../tests/fixtures/adapters/) (`<id>.fake.json`). Argv shapes match default **test registration** binaries (`/bin/<id>`), not PATH discovery on a real Windows install. Vertical planning→implement smoke (pure fakes, no daemon/CLI) is under [`tests/e2e/`](../tests/e2e/).

```bash
# Example: run unit + e2e tests (no LLM keys)
pnpm test
```

---

## Registering custom CLIs

Anything outside the first-class set is a **generic** adapter: thin `start_template` → argv, no usage parse.

### Via CLI templates

```bash
# Seed from built-in examples (aider, opencode)
lazyorch adapter register --from-template aider
lazyorch adapter register --from-template opencode

# Hand-roll
lazyorch adapter register \
  --id aider \
  --binary aider \
  --name Aider \
  --start-template "{binary} --model {model} --yes-always --message-file {prompt_file}" \
  --models-args "[]"

lazyorch adapter test --id aider
lazyorch adapter list --probe
```

### Via `.lazyorch/config.yml`

```yaml
adapters:
  registry:
    - id: aider
      display_name: Aider
      binary: aider            # PATH name or absolute path
      start_template: "{binary} --model {model} --yes-always --message-file {prompt_file}"
      version_args: ["--version"]
      capabilities:
        worktree_ok: true
        usage_reporting: none
        tier_map:
          small: gpt-4o-mini
          medium: gpt-4o
          large: gpt-4o
```

### `start_template` placeholders

| Placeholder | Value |
|-------------|--------|
| `{binary}` | Resolved executable |
| `{model}` | Concrete model id from router |
| `{prompt_file}` | Absolute path to session `prompt.md` |
| `{prompt}` | **Contents** of prompt.md (single argv token) |
| `{cwd}` | Session working directory (worktree/root) |
| `{session_dir}` | Session directory under runs/…/sessions |
| `{timeout_ms}` | Session timeout |
| `{args_prefix}` | Extra argv from `args_prefix` |
| `{agent_id}` / `{task_id}` | When present |

Prefer `{prompt_file}` when the CLI has a message-file flag. Prefer whole-token `{prompt}` for positional message CLIs (e.g. OpenCode). Templates are tokenized **before** substitution so paths and multi-line prompts stay single argv entries.

### Model list probes

Set `models_args` when the CLI can list models non-interactively (e.g. OpenCode: `["models"]`). Configured `capabilities.models` always wins for routing allowlists.

---

## Models (dry-run route)

```bash
lazyorch models route --role worker
lazyorch models route --role plan_writer --tier large
lazyorch models route --run <run_id> --adapter claude
lazyorch models route --signals '{"loc":1200}' --budget-pressure
```

Pure router dry-run (no session spawn). Exit **4** on adapter resolution errors. `--run` loads context `model_pin/run`; CLI flags override.

---

## Shared context KV

```bash
lazyorch context list --run <id>
lazyorch context get <key> --run <id>
lazyorch context set <key> <value> --run <id>
lazyorch context delete <key> --run <id>
```

Used for pins, operator notes, and cross-session facts (not secrets).

---

## Windows notes (paths, long paths, Defender)

LazyOrch is **Windows-first** for the GUI and fully supported on the CLI.

### Worktree root

Default worktree placement:

| Platform | Default root |
|----------|----------------|
| Non-Windows | `<repo>/.lazyorch/worktrees/<task_id>/` |
| **Windows** | `%USERPROFILE%\.lazyorch\worktrees\<project_hash>\<task_id>\` |

Windows uses a **short root outside the repo** to reduce path-length pressure and Defender scan cost on the working tree. Override with `workspace.worktree_root` in config when needed.

### Long paths

Enable Git long paths (recommended on Windows):

```bash
git config --global core.longpaths true
# or repo-local:
git config core.longpaths true
```

Deep monorepos + worktrees can exceed legacy `MAX_PATH` without this.

### Line endings

This repo uses LF (`.gitattributes`, Prettier `endOfLine: "lf"`). Prefer:

```bash
git config core.autocrlf false
```

in this clone so format checks stay green.

### Windows Defender / antivirus

Heavy AV real-time scanning of:

- worktree roots (`%USERPROFILE%\.lazyorch\worktrees\…`)
- package manager caches (`node_modules`, pnpm store)
- session log directories under `.lazyorch/runs/`

can slow agent runs and git worktree operations.

**Recommendations:**

1. Add **Process** exclusions for `node.exe`, coding CLIs (`claude.exe`, `codex.exe`, …), and `git.exe` if your policy allows.
2. Add **Folder** exclusions for:
   - `%USERPROFILE%\.lazyorch\`
   - the repo’s `node_modules` (dev machines)
   - optional: pnpm store (`%LOCALAPPDATA%\pnpm\store`)
3. Keep secrets out of worktree paths; exclusions reduce scan coverage—use least privilege folders only.
4. Prefer the default **external** worktree root rather than nesting under a heavily scanned Documents/OneDrive tree.

### PATH and binaries

- Discovery uses `PATH` + `PATHEXT` on Windows (`where.exe` semantics).
- Prefer absolute `binary` paths in config when CLIs are installed outside PATH (npx shims, version managers).
- Cancel uses process-tree kill (`taskkill /T /F /PID` on Windows).

### Shell adapter

Deterministic tasks use the shell adapter with an **allowlist**. Do not put unrestricted interactive shells on the allowlist for unattended runs.

---

## Typical operator loop

```bash
lazyorch init && lazyorch doctor
lazyorch serve --background
lazyorch start "Your idea here" --tier large
lazyorch status --check          # may exit 3 while planning gates pending
lazyorch gate list
lazyorch gate approve <gate_id>  # e.g. plan_approve after freeze
lazyorch status <run_id>
# … more gates (merge, intervention) as the run progresses
lazyorch logs --run <run_id> --limit 100
```

## Further reading

- Design doc: [`design-lazyorch.md`](./design-lazyorch.md)
- OpenAPI placeholder: [`openapi.yaml`](./openapi.yaml)
- E2E fixtures: [`../tests/fixtures/`](../tests/fixtures/)
- E2E smoke tests: [`../tests/e2e/`](../tests/e2e/)
