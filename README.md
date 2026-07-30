<div align="center">

<img src="assets/cempala-logo.svg" alt="Cempala" width="88" height="88" />

# Cempala

### Cue your agents.

**One agent asks. The other just does it.** Same machine, plain language, one turn.

Cempala is a local [MCP](https://modelcontextprotocol.io) server that gets Claude Code and Codex CLI working together. Ask one for something and it pulls in the other, right there in the same session. No second window, no copy-paste, no cloud.

<p>
<img alt="Platforms: macOS · Linux · Windows" src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-555" />
<img alt="Runtime: Bun" src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-f472b6" />
<img alt="Transport: MCP (stdio)" src="https://img.shields.io/badge/transport-MCP%20stdio-6366f1" />
<img alt="Runtime dependencies: 1" src="https://img.shields.io/badge/runtime%20deps-1-2ea043" />
</p>

[Install](#install) · [How it works](#how-it-works) · [Tools](#the-8-mcp-tools) · [Trust &amp; safety](#trust--safety-model) · [Configuration](#configuration) · [Development](#development)

<sub>Part of the <b>theLabs</b> product family, alongside Dalang, Kayon, and Gamelan.</sub>

</div>

---

## Why

Claude Code and Codex are both capable, but on your machine neither knows the other exists. Every time you want them to team up, you become the courier. You copy the output from one window, paste it into the other, keep track of who did what, and do it again. Cempala takes you out of the middle.

Ask in plain language and the handoff happens for you:

> *"Ask Codex to add tests for the file I just changed, then run them."*
>
> *"Have Claude write a clear README for this project."*

## How it works

Cempala gives each agent two complementary ways to hand off work, backed by one shared SQLite notebook (`~/.cempala/cempala.db`) that both read and write:

- **`dispatch` (synchronous).** Shells out to the target agent's headless CLI (`codex exec`, `claude -p`), waits (bounded timeout), and returns the result inline in the same turn. You wait once; both do the work.
- **Mailbox (asynchronous).** `send_message` / `check_messages` and `create_task` -> `claim_task` -> `complete_task` leave work in a shared queue for the other agent to claim when it's ready. Nothing is lost if a job runs long.

Every `dispatch` also writes a task row, so the synchronous and mailbox paths share one audit log. Because it speaks standard MCP, any compatible agent can join later without server changes.

## Highlights

- **Instant handoff.** Delegate now, get the result back in the same reply.
- **Shared task queue.** Or leave it for the other agent to pick up later.
- **Plain-language requests.** No commands or config to learn.
- **Complete audit log.** Every handoff records the request, the folder it ran in, how long it took, and how it ended.
- **Local-first.** No account, no server to sign into, no open port. Delete `~/.cempala/` and it's gone.
- **Honest network control.** Handoffs run offline by default, and each result reports exactly what was enforced.

## Requirements

- **Bun** is not needed — the installer ships a self-contained binary.
- **At least one agent CLI**, on `PATH`: [Claude Code](https://claude.com/claude-code) (`claude`) and/or [Codex](https://developers.openai.com/codex/cli) (`codex`). Install both to hand work in either direction.
- **Each CLI must be signed in.** This is the requirement people trip over. Cempala holds no API keys and never talks to a model itself — it shells out to `claude` and `codex` and lets each one use its own credentials. If a CLI's session has expired, every handoff to that agent fails, typically with a `401`.

Check before you start:

```sh
claude -p "reply with OK"
```

```sh
codex exec "reply with OK"
```

If either prints an authentication error instead of `OK`, sign that CLI in — `claude auth` or `codex login` (`codex login status` shows where you stand) — and re-run the check. Credentials expire periodically, so it's worth re-checking whenever handoffs to one agent suddenly start failing: a `dispatch` result of `status: "failed"` carrying a `401` is almost always this, not a Cempala problem.

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

The script is idempotent. Re-running it (e.g. to upgrade) overwrites the binary in place, leaves an existing `config.toml` untouched, and re-points the MCP registrations at the new binary without duplicating them.

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

Every call is logged to `audit_log` with timing, args, and a short result summary. A reaper (FR-17) runs on every tool call and clears `running` tasks that are over 30 minutes old and no longer live, recording what actually happened — `completed` when the captured output shows the agent finished its turn, `failed` otherwise. A dead process ID on its own is deliberately not treated as a failed task: on Windows the agent CLIs run behind a launcher shim, so the recorded PID can die while the agent works on and finishes.

## Trust & safety model

- **Default trust boundary** = your home directory (`os.homedir()`), zero config. (FR-11)
- **Baseline denylist** of sensitive roots under home (`.ssh`, `.aws`, `.gnupg`, `.docker`, `.config/gh`, browser credential stores, etc.) is **always** applied. Your `config.toml` can only *add* entries. (FR-11a)
- **Outside-home paths** return `needs_approval`, not an error. The calling agent relays this to the human; only after a `approve_path` call does a retry succeed. (FR-11b / FR-11c)
- **Cwd that is a strict ancestor of a denylist root** (e.g. `cwd: "~"`, which contains `~/.ssh` as a subpath) also returns `needs_approval`, with `reason: "ancestor_of_denylist"`. The escalation here is *not* `approve_path`; the home directory cannot be approved as a whole, so `canApprove` rejects it. Instead you **narrow the cwd** to a project subdirectory. This is symmetric to the "denylist wins" rule: a cwd broad enough to contain a denylist subpath would let the child reach it, so the trust boundary forces explicit human confirmation rather than silently allowing the broad scope.
- **Even `approve_path`** refuses denylisted paths and their ancestors. No escalation path lets a denylisted path become approved. (AC-10)
- **Path containment** uses one canonicalization routine (resolve symlinks, absolutize, normalize, Windows case-fold, then `X === Y || X.startsWith(Y + sep)`). Sibling-prefix matches like `D:\clients\acme2` against root `D:\clients\acme` are excluded. (AC-11)
- **Symlinks inside an approved directory** that point at `~/.ssh` are still caught, because the canonicalization resolves the symlink before matching. (AC-12)
- **Sandbox scope** is set per agent CLI per dispatch:
  - Codex: `--sandbox workspace-write` (with `-c sandbox_workspace_write.network_access=true` only when `allow_network: true`). Egress is **OS-sandbox-enforced**.
  - Claude: `--tools "<baseline + WebFetch + WebSearch if allow_network>"`, plus `--disallowedTools "WebFetch,WebSearch"` only when `allow_network: false`. The web tools are removed, but Claude's `Bash` can still `curl`, so the dispatch result reports this honestly as `network_enforcement: "tools_only"` rather than the stronger `"sandboxed"` (which only Codex gets).
- **`--add-dir` is forbidden** for both Codex and Claude. It's the documented escape hatch from the cwd-anchored scope on either CLI, and any `config.toml` that introduces it is rejected at config load time.

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

All paths may use `~/`; `config.ts` expands them against `os.homedir()` on read. The file's denylist arrays are starting points. The compile-time baseline is unioned on top and cannot be weakened by trimming.

## Development

```sh
bun install
bun run src/index.ts        # run the server (for manual testing)
bun test test/unit          # 155 unit tests across 10 files
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

- `src/index.ts`: MCP server entrypoint. Handles `--init`, `--version`, `--help`; otherwise starts the stdio MCP server.
- `src/db/`: raw SQL schema + `bun:sqlite` client. No ORM.
- `src/security/`: the ONLY path comparator (`paths.ts`), the ONLY trust-boundary decider (`trust-boundary.ts`), the ONLY denylist compiler (`denylist.ts`). Tool handlers consume these; they never re-derive.
- `src/platform/`: `paths.ts` for OS-correct filesystem locations, `spawn.ts` for the cross-platform detached spawn + PID liveness wrapper.
- `src/tools/`: one file per tool. Always returns `{ok, data} | {ok: false, error, code}`. `needs_approval` is `ok: true` with `data.status === "needs_approval"`, not a failure.
- `src/reaper.ts`: FR-17, the stale running-task sweep, piggybacked on every tool call.
- `src/audit.ts`: FR-8, the append-only `audit_log` writer.

See `REQUIREMENTS.md` for the full FR/NFR/AC spec, and `AGENTS.md` / `CLAUDE.md` for the build conventions and cross-platform rules.

## The name

In Indonesian *wayang* theatre, the **cempala** is the small wooden mallet the puppeteer taps to cue the musicians and signal a change of scene. Here it plays the same role: a quiet cue that gets one agent to act on another's behalf.

## Disclaimer

Cempala is an independent project by theLabs. It is not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI. Claude and Claude Code are products of Anthropic; Codex and Codex CLI are products of OpenAI. Those names and trademarks belong to their respective owners, and are used here only to describe the tools Cempala works with.

## License

See [`LICENSE`](LICENSE).

<div align="center"><sub>© 2026 theLabs · <a href="https://thelabs.id">thelabs.id</a> · Cempala, cue your agents.</sub></div>
