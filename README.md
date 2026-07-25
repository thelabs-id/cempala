# cempala

A local MCP server that lets independent AI coding agents — Claude Code and Codex CLI — hand work to each other on the same machine, in plain language from either agent's session.

> Part of the **thelabs** product family, alongside Dalang, Kayon, and Gamelan.

## What it does

From Claude, in the same turn:

> *"Have Codex generate a 512×512 blue circle PNG into this folder."*

From Codex:

> *"Have Claude refactor this file."*

Cempala exposes both **asynchronous mailbox** tools (`send_message`, `check_messages`, `create_task` / `claim_task` / `complete_task`) and a **synchronous `dispatch`** tool that shells out to the target agent's headless CLI mode (`codex exec`, `claude -p`) and returns the result inline. Every dispatch also writes a task row, so the async and sync paths share one audit log.

## Install

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/thelabs-id/cempala/main/scripts/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/thelabs-id/cempala/main/scripts/install.ps1 | iex
```

Both installers:
- detect OS + arch and download the matching pre-compiled binary
- verify a SHA-256 checksum before doing anything with the file
- drop the binary into `~/.cempala/bin` (macOS/Linux) or `%LOCALAPPDATA%\Cempala\bin` (Windows)
- add it to `PATH` for the current shell **and** for future shells
- run `cempala --init` to write a default `~/.cempala/config.toml` if absent
- auto-register with `claude` and/or `codex` MCP if found on `PATH`

The script is idempotent — re-running it (e.g. to upgrade) overwrites the binary in place and leaves existing config and MCP registrations untouched.

## The 8 MCP tools

| Tool | What it does | Spec |
|---|---|---|
| `send_message` | Write a row to the `messages` table. | FR-1 |
| `check_messages` | Return unread (or all, with `since`) messages addressed to an agent; mark read. | FR-2 |
| `create_task` | Create a mailbox task; validates `cwd` against the trust boundary. | FR-3 |
| `claim_task` | Claim a pending task; fails for non-`pending` states. | FR-4 |
| `complete_task` | Mark a claimed/running task `completed` or `failed`. | FR-5 |
| `dispatch` | Synchronously run a prompt in the target agent's CLI; returns the result or `running` at the wait timeout. `needs_approval` results carry a `reason` (`"outside_home"` or `"ancestor_of_denylist"`) so the caller can tell "approve this path" from "narrow the cwd". | FR-6 |
| `check_task` | Read current task state; reconciles a `running` task whose process has died. | FR-7 |
| `approve_path` | Persist a path outside the home into `approved_paths`. Denylisted paths cannot be approved. | FR-7a |

Every call is logged to `audit_log` with timing, args, and a short result summary. A reaper (FR-17) sweeps stale `running` tasks whose PID is dead and > 30 minutes old on every tool call.

## Trust & safety model

- **Default trust boundary** = your home directory (`os.homedir()`), zero config. (FR-11)
- **Baseline denylist** of sensitive roots under home (`.ssh`, `.aws`, `.gnupg`, `.docker`, `.config/gh`, browser credential stores, etc.) is **always** applied. Your `config.toml` can only *add* entries. (FR-11a)
- **Outside-home paths** return `needs_approval`, not an error. The calling agent relays this to the human; only after a `approve_path` call does a retry succeed. (FR-11b / FR-11c)
- **Cwd that is a strict ancestor of a denylist root** (e.g. `cwd: "~"`, which contains `~/.ssh` as a subpath) also returns `needs_approval`, with `reason: "ancestor_of_denylist"`. The escalation path here is *not* `approve_path` (the home directory cannot be approved as a whole — `canApprove` rejects it) but to **narrow the cwd** to a project subdirectory. This is symmetric to the "denylist wins" rule: a cwd broad enough to contain a denylist subpath would let the child access it, so the trust boundary forces explicit human confirmation rather than silently allowing the broad scope.
- **Even `approve_path`** refuses denylisted paths and their ancestors — there is no escalation path that lets a denylisted path become approved. (AC-10)
- **Path containment** uses one canonicalization routine (resolve symlinks → absolutize → normalize → Windows case-fold → `X === Y || X.startsWith(Y + sep)`). Sibling-prefix matches like `D:\clients\acme2` against root `D:\clients\acme` are excluded. (AC-11)
- **Symlinks inside an approved directory** that point at `~/.ssh` are still caught, because the canonicalization resolves the symlink before matching. (AC-12)
- **Sandbox scope** is set per agent CLI per dispatch:
  - Codex → `--sandbox workspace-write` (with `-c sandbox_workspace_write.network_access=true` only when `allow_network: true`). Egress is **OS-sandbox-enforced**.
  - Claude → `--tools "<baseline + WebFetch + WebSearch if allow_network>"` with `--disallowedTools "WebFetch,WebSearch"` only when `allow_network: false`. The web tools are removed, but Claude's `Bash` can still `curl`; the dispatch result reports this honestly as `network_enforcement: "tools_only"` rather than the stronger `"sandboxed"` (which only Codex gets).
- **`--add-dir`** is forbidden for both Codex and Claude — it's the documented escape hatch from the cwd-anchored scope on either CLI, and any `config.toml` that introduces it is rejected at config load time.

## Configuration

`~/.cempala/config.toml`:

```toml
[server]
db_path = "~/.cempala/cempala.db"
output_dir = "~/.cempala/outputs"

[trust]
# home_root defaults to os.homedir() when omitted
denylist = ["~/.ssh", "~/.aws"]  # add to the compiled baseline; cannot subtract

[dispatch]
default_wait_seconds = 120
max_wait_seconds = 600
allow_network_default = false

[dispatch.denylist]
patterns = ["rm -rf", "sudo ", "curl | sh"]  # add to the compiled baseline

[agents.codex]
exec_command = ["codex", "exec"]
sandbox_args = ["--sandbox", "workspace-write"]

[agents.claude]
exec_command = ["claude", "-p"]
permission_args = ["--permission-mode", "acceptEdits"]
```

All paths may use `~/` — `config.ts` expands against `os.homedir()` on read. The file's denylist arrays are starting points; the compile-time baseline is unioned on top and cannot be weakened by trimming.

## Development

```sh
bun install
bun run src/index.ts        # run the server (for manual testing)
bun test test/unit          # 140 unit tests across 10 files
CEMPALA_INTEGRATION=1 bun test test/integration   # spawns real codex + claude
bun x tsc --noEmit          # typecheck
bun build --compile src/index.ts --outfile dist/cempala.exe
```

Build all six release targets:

```sh
bash scripts/build-all.sh
```

Targets: `bun-darwin-{arm64,x64}`, `bun-linux-{arm64,x64}`, `bun-windows-{arm64,x64}.exe`. Each target needs a smoke test on real matching hardware before being tagged as a release artifact (a cross-compiled binary cannot be run on the build host).

## Architecture

- `src/index.ts` — MCP server entrypoint. Handles `--init`, `--version`, `--help`; otherwise starts stdio MCP server.
- `src/db/` — raw SQL schema + `bun:sqlite` client. No ORM.
- `src/security/` — the ONLY path comparator (`paths.ts`), the ONLY trust-boundary decider (`trust-boundary.ts`), the ONLY denylist compiler (`denylist.ts`). Tool handlers consume these; they never re-derive.
- `src/platform/` — `paths.ts` for OS-correct filesystem locations, `spawn.ts` for the cross-platform detached spawn + PID liveness wrapper.
- `src/tools/` — one file per tool. Always returns `{ok, data} | {ok: false, error, code}`. `needs_approval` is `ok: true` with `data.status === "needs_approval"`, not a failure.
- `src/reaper.ts` — FR-17: stale running task sweep, piggybacked on every tool call.
- `src/audit.ts` — FR-8: append-only `audit_log` writer.

See `REQUIREMENTS.md` for the full FR/NFR/AC spec, and `AGENTS.md` / `CLAUDE.md` for the build conventions and cross-platform rules.

## License

See `LICENSE`.
