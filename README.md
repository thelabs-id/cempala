<div align="center">

<img src="assets/cempala-logo.svg" alt="Cempala" width="88" height="88" />

# Cempala

### Cue your agents.

**One agent asks. The other just does it.** Same machine, plain language, one turn.

Cempala is a local [MCP](https://modelcontextprotocol.io) server that gets Claude Code, Codex CLI, Antigravity and OpenCode working together. Ask one for something and it pulls in another, right there in the same session. No second window, no copy-paste, no cloud service in the middle.

<p>
<a href="https://github.com/thelabs-id/cempala/actions/workflows/verify.yml"><img alt="verify" src="https://github.com/thelabs-id/cempala/actions/workflows/verify.yml/badge.svg" /></a>
<a href="https://github.com/thelabs-id/cempala/releases/latest"><img alt="latest release" src="https://img.shields.io/github/v/release/thelabs-id/cempala?color=6366f1" /></a>
<img alt="Platforms: macOS · Linux · Windows" src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-555" />
<img alt="Runtime: Bun" src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-f472b6" />
<img alt="Transport: MCP (stdio)" src="https://img.shields.io/badge/transport-MCP%20stdio-6366f1" />
<img alt="Runtime dependencies: 1" src="https://img.shields.io/badge/runtime%20deps-1-2ea043" />
</p>

[Install](#install) · [Uninstall](#uninstalling) · [How it works](#how-it-works) · [Tools](#the-8-mcp-tools) · [Trust &amp; safety](#trust--safety-model) · [Configuration](#configuration) · [Development](#development)

<sub>Part of the <b>theLabs</b> product family, alongside Dalang and Kayon.</sub>

</div>

---

## Why

Claude Code, Codex, Antigravity and OpenCode are all capable, but on your machine none of them knows the others exist. Every time you want them to team up, you become the courier. You copy the output from one window, paste it into another, keep track of who did what, and do it again. Cempala takes you out of the middle.

Ask in plain language and the handoff happens for you:

> *"Ask Codex to add tests for the file I just changed, then run them."*
>
> *"Have Claude write a clear README for this project."*
>
> *"Get Antigravity to review this migration and tell me what it would break."*

## How it works

Cempala gives each agent two complementary ways to hand off work, backed by one shared SQLite notebook (`~/.cempala/cempala.db`) that both read and write:

- **`dispatch` (synchronous).** Shells out to the target agent's headless CLI (`codex exec`, `claude -p`, `agy -p`, `opencode run`), waits (bounded timeout), and returns the result inline in the same turn. You wait once; both do the work.
- **Mailbox (asynchronous).** `send_message` / `check_messages` and `create_task` -> `claim_task` -> `complete_task` leave work in a shared queue for the other agent to claim when it's ready. Nothing is lost if a job runs long.

Every valid `dispatch` writes a task row before any policy check runs, so the synchronous and mailbox paths share one audit log. (A call rejected for malformed arguments returns before the row is written.) Because it speaks standard MCP, any compatible agent can call these tools and take part in the mailbox — agent identities are created on first use. Becoming a `dispatch` *target* is the narrower case: that needs the agent's headless flags mapped in `agent-args.ts`, so it's a code change rather than configuration.

For OpenCode, these directions are independent. The installer registers Cempala as an MCP server when the `opencode` CLI is on `PATH`, which is what lets **OpenCode call Cempala**; for **Cempala to dispatch work to OpenCode**, that CLI also needs a working provider configured. Either direction works without the other.

## Highlights

- **Instant handoff.** Delegate now, get the result back in the same reply.
- **Shared task queue.** Or leave it for the other agent to pick up later.
- **Plain-language requests.** No commands or config to learn.
- **Complete audit log.** Every MCP tool call is logged; each task and dispatch records the request, folder, duration, and outcome.
- **Local-first.** No account, no server to sign into, no open port. Your data lives in `~/.cempala/`; installation registers Claude, Codex, Antigravity, and OpenCode when available. The [uninstaller](#uninstalling) removes the registrations it created and the binary (your data stays unless you ask for it to go).
- **Honest network control.** Handoffs *ask* for no network by default, and every result that got as far as spawning reports what was actually enforced — including admitting when the request could not be enforced at all.

## Requirements

- **Bun** is not needed — the installer ships a self-contained binary.
- **At least one agent CLI**, on `PATH`: [Claude Code](https://claude.com/claude-code) (`claude`), [Codex](https://developers.openai.com/codex/cli) (`codex`), [Antigravity](https://antigravity.google/docs/cli) (`agy`), and/or [OpenCode](https://opencode.ai) (`opencode`). Install more than one to hand work in either direction.
- **Each CLI must be ready for non-interactive use.** This is the requirement people trip over. Cempala holds no API keys and never talks to a model itself — it shells out to the installed agent CLIs and lets each one use its own credentials or provider configuration. If a CLI session has expired or its provider is unavailable, handoffs to that agent fail, often with an authentication or provider error such as `401`.

Check before you start:

```sh
claude -p "reply with OK"
```

```sh
codex exec "reply with OK"
```

```sh
agy -p "reply with OK"
```

```sh
opencode run "reply with OK"
```

If any of them prints an authentication or provider error instead of `OK`, refresh that CLI's sign-in or provider configuration and re-run the check. Credentials expire periodically, so it's worth re-checking whenever handoffs to one agent suddenly start failing: a `dispatch` result of `status: "failed"` carrying a `401` is almost always this, not a Cempala problem. An unauthenticated `agy` is distinctive: it waits 60 seconds for a sign-in that a headless dispatch can never complete, then returns `authentication failed or timed out`.

## Install

Linux / macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/thelabs-id/cempala/main/scripts/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/thelabs-id/cempala/main/scripts/install.ps1 | iex
```

| Platform | Asset | Validation |
|---|---|---|
| Linux x64 | `cempala-linux-x64` | Linux 6.6 and a CI x64 runner |
| Linux arm64 | `cempala-linux-arm64` | a real ARM64 CI runner |
| macOS Apple Silicon | `cempala-darwin-arm64` | macOS 15 arm64 |
| macOS Intel | `cempala-darwin-x64` | macOS 15 x86_64 |
| Windows x64 | `cempala-windows-x64.exe` | Windows 11 |
| Windows ARM64 (manual) | `cempala-windows-arm64.exe` | Built, but not yet smoke-tested on Windows ARM hardware |

Every binary selected by an installer has been *run* on the platform it targets — a cross-compile that succeeds proves nothing about the artifact. `scripts/smoke-test.sh` is that check, and CI runs it against each installer-selected build artifact on matching hardware. The separately attached Windows ARM64 build is not selected by the installer and remains experimental until matching-hardware smoke coverage exists.

On **Windows on ARM** the installer fetches the tested x64 build, which runs under emulation. A native `windows-arm64` binary is available as a manual, experimental release asset, but it is not installer-selected until it has passed a matching-hardware smoke test.

Both installers:
- detect OS + architecture and download a supported pre-compiled binary
- verify a SHA-256 checksum before doing anything with the file
- drop the binary into `~/.cempala/bin` — the same place on every platform (`%USERPROFILE%\.cempala\bin` on Windows), deliberately **not** under `AppData`, which some agent clients cannot see from the processes they spawn
- put it on `PATH` for future shells — on Windows by updating the user `PATH` variable (and the current PowerShell process); on macOS and Linux by writing to the startup file your shell actually reads (see below). **Open a new shell afterwards**: a script piped into `bash` runs in a child process, so it cannot change the `PATH` of the shell you launched it from
- run `cempala --init` to write a default `~/.cempala/config.toml` if absent
- auto-register with `claude`, `codex` and/or `opencode` MCP if found on `PATH`, using each CLI's own `mcp add`. For OpenCode that writes `~/.config/opencode/opencode.jsonc` (or an `opencode.json` already there), keeping the comments and other servers in it intact — letting the CLI edit its own config is why that file survives the round trip unchanged
- register with Antigravity by merging an entry into `~/.gemini/config/mcp_config.json` (`%USERPROFILE%\.gemini\config\mcp_config.json` on Windows), which covers both the Antigravity IDE and the `agy` CLI. Antigravity has no `mcp add` subcommand, so this is a JSON edit rather than a CLI call — it preserves every other server and top-level key already in that file, and if the file can't be parsed it's left untouched and the exact snippet is printed for you to paste. You can re-run just this step with `cempala --register-antigravity`.

Each installer is idempotent, so re-running one to upgrade re-points every registration at the new binary rather than duplicating it.

### OpenCode MCP setup

OpenCode can use all Cempala tools as a standard local MCP server, and the installer sets that up for you whenever the `opencode` CLI is on `PATH` — the same as Claude Code and Codex. **Restart OpenCode afterwards**, then check it with `opencode mcp list`.

It registers by running the CLI's own command:

```sh
opencode mcp add cempala -- /absolute/path/to/cempala
```

which leaves this in `~/.config/opencode/opencode.jsonc` (or in an `opencode.json` you already had):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "cempala": {
      "type": "local",
      "command": ["/absolute/path/to/cempala"]
    }
  }
}
```

Run that command yourself if you install the `opencode` CLI later, using the exact executable path the installer printed — normally `~/.cempala/bin/cempala`, or `%USERPROFILE%\.cempala\bin\cempala.exe` on Windows. A project-root `opencode.json` works too if you want Cempala in one project rather than globally; the installer only ever touches the global file.

Letting `opencode mcp add` do the writing is deliberate: OpenCode's config is JSONC, and its own CLI is the thing that knows how to add an entry without discarding your comments or reformatting the rest. Uninstalling has to edit that file directly — OpenCode ships no `mcp remove` — so it cuts out the one entry and copies every other byte through unchanged.

To send work *to* OpenCode, no MCP entry is needed: install the `opencode` CLI, configure a working provider, then dispatch with `target_agent: "opencode"`. Cempala runs `opencode run --format json`, retains its JSONL output with the task, and returns the final response. The default model comes from your OpenCode configuration; set `[agents.opencode].model` in Cempala's config when a dispatch must use a specific configured provider/model.

On macOS and Linux "the file your shell actually reads" is `~/.zshrc` for zsh. For bash it's *two* files — a login one (`~/.bash_profile`, or whichever of `~/.bash_login` / `~/.profile` you already use) **and** `~/.bashrc` — because bash reads a different file depending on whether the shell is a login shell, and which one your terminal opens varies by platform. Picking one means being wrong for a lot of people. The snippet is guarded, so being read from both adds the directory to `PATH` exactly once.

The script is idempotent. Re-running it (e.g. to upgrade) leaves your machine in the state a fresh install would:

- **The binary is replaced even while it's running** — the normal case when upgrading, since an agent is usually holding cempala open as an MCP server. It's staged beside the target and renamed into place, so a running server keeps the file it already opened until it exits and nothing has to be killed.
- **Exactly one PATH block survives**, in the right file. A block written by an older version is replaced rather than stepped over, and one left behind in a file the installer no longer writes to is removed. A file that already holds the current block is left byte-identical.
- `config.toml` is left untouched, and the MCP registrations are re-pointed at the new binary without duplicating them.

Editing your shell config is the part with the least room for error, so on macOS and Linux the rules are narrow: a block is only ever removed together with the marker comment the installer itself wrote. Matching text without that marker — in a heredoc, a quoted string, or a line you wrote yourself — is left alone, and so are your line endings and a missing final newline. An rc file that's a symlink into a dotfiles repo is written *through*, so it stays a symlink.

## Uninstalling

```sh
curl -fsSL https://raw.githubusercontent.com/thelabs-id/cempala/main/scripts/uninstall.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/thelabs-id/cempala/main/scripts/uninstall.ps1 | iex
```

**Deleting `~/.cempala/` on its own is not enough**, which is why this exists. The installer can write its own install directory and `PATH` entry, plus registrations in Claude Code, Codex, Antigravity, and OpenCode when those clients are available. Remove only the directory and any registrations it made can survive, pointing at a binary that no longer exists — so an affected agent can report Cempala as a failed server until you remove the stale entry. The uninstaller removes all four. A project-root `opencode.json` you wrote yourself is the one exception: the installer never added that, so it does not come out either.

The uninstaller removes the registrations it can manage, the `PATH` entry and the executable, and by default keeps everything *else* under `~/.cempala/` — your config, database and audit log:

- **Registrations** go through each CLI's own `mcp remove`, so their config files stay theirs to edit. Antigravity and OpenCode ship no such command, so those two are edited directly — one key removed from each, every other server and setting left exactly as it was, and neither file ever deleted, because they're that agent's rather than ours.
- **The `PATH` export** is removed only where the marker comment the installer wrote is still present. A block someone has edited, a commented-out copy, or a file that merely mentions the same path is left alone — and your line endings and a missing final newline are preserved. Install then uninstall returns a startup file to its original bytes.
- **The OpenCode entry is cut out, not rewritten around.** OpenCode has no `mcp remove`, so `cempala --unregister-opencode` edits the config itself — every global file OpenCode reads, which is `opencode.json`, `opencode.jsonc` and the legacy `config.json` it still loads but no longer writes: it deletes the one `mcp.cempala` member and copies every other byte through, comments and indentation included. Install then uninstall returns that file to its original bytes, the same standard the shell startup files are held to. A config it cannot parse is left untouched and reported instead.
- **Your data is kept.** `~/.cempala/` holds the config, the task history and the audit log; that's a record, not installation debris, and uninstalling the software isn't an instruction to discard it. Only the binary is removed from it — and on Windows, if that binary is still open, it is renamed aside to `cempala.exe.old-…` for you to delete once the session holding it closes. Pass `--purge` (`-Purge` on Windows) to delete the whole directory.

**A step that can't be completed is reported as a failure, not smoothed over.** If a registration won't come out, an rc file can't be written, or the installed binary is too old to know these flags, the run prints what to finish by hand, exits non-zero under a `PARTIALLY uninstalled` banner, and *keeps the binary* — it's the only thing that can retry. When any of that happens *before* the purge step, `--purge` (`-Purge` on Windows) is refused outright, so a half-undone system doesn't also lose its database. (A failure during the deletion itself is different: by then some of the directory may already be gone. That is reported too, but it cannot be undone.)

`--dry-run` (`-DryRun` on Windows) prints the actions it would take and changes nothing. It doesn't invoke the agent CLIs at all, so it shows what would be attempted rather than predicting whether each step would succeed.

## The 8 MCP tools

| Tool | What it does | Spec |
|---|---|---|
| `send_message` | Write a row to the `messages` table. | FR-1 |
| `check_messages` | Return unread (or all, with `since`) messages addressed to an agent; mark read. | FR-2 |
| `create_task` | Create a mailbox task; validates `cwd` against the trust boundary. | FR-3 |
| `claim_task` | Claim a pending task; fails for non-`pending` states. | FR-4 |
| `complete_task` | Mark a claimed/running task `completed` or `failed`. | FR-5 |
| `dispatch` | Synchronously run a prompt in the target agent's CLI — `target_agent` is `"claude"`, `"codex"`, `"antigravity"` or `"opencode"`. Returns the result, or `running` at the wait timeout. A `completed`, `failed` or `running` result carries `network_enforcement`, saying what was actually applied. `needs_approval` results carry a `reason` (`"outside_home"` or `"ancestor_of_denylist"`) so the caller can tell "approve this path" from "narrow the cwd". | FR-6 |
| `check_task` | Read current task state; reconciles a `running` task whose process has died. | FR-7 |
| `approve_path` | Persist a path outside the home into `approved_paths`. Denylisted paths cannot be approved. | FR-7a |

Every call is logged to `audit_log` with timing, args, and a short result summary. A reaper (FR-17) runs on every tool call and clears `running` tasks that are over 30 minutes old and no longer live, recording what actually happened rather than blanket-failing them. A dead process ID on its own is deliberately not treated as a failed task: on Windows the agent CLIs run behind a launcher shim, so the recorded PID can die while the agent works on and finishes.

**Five code paths settle a task** — `dispatch`'s in-wait branch, its background reconcile, its orphan watcher, `check_task` and the reaper — and they all apply one rule, in one function, because near-copies of it had drifted before. A run's `stderr` is read whenever it failed *or* came back with nothing to say, since an empty answer is exactly when stderr is the only thing that can explain the outcome. And an agent that states on stderr that it deliberately produced no output is recorded as `failed`, whatever its exit code claimed — that isn't cempala inventing a verdict, it's reading one the CLI gave in prose instead of in its JSON.

## Trust & safety model

- **Default trust boundary** = your home directory (`os.homedir()`), zero config. (FR-11)
- **Baseline denylist** of sensitive roots under home (`.ssh`, `.aws`, `.gnupg`, `.docker`, `.config/gh`, browser credential stores, etc.) is **always** applied. Your `config.toml` can only *add* entries. (FR-11a)
- **Outside-home paths** return `needs_approval`, not an error. The calling agent relays this to the human; only after a `approve_path` call does a retry succeed. (FR-11b / FR-11c)
- **Cwd that is a strict ancestor of a denylist root** (e.g. `cwd: "~"`, which contains `~/.ssh` as a subpath) also returns `needs_approval`, with `reason: "ancestor_of_denylist"`. The escalation here is *not* `approve_path`; the home directory cannot be approved as a whole, so `canApprove` rejects it. Instead you **narrow the cwd** to a project subdirectory. This is symmetric to the "denylist wins" rule: a cwd broad enough to contain a denylist subpath would let the child reach it, so the trust boundary forces explicit human confirmation rather than silently allowing the broad scope.
- **Even `approve_path`** refuses denylisted paths and their ancestors. No escalation path lets a denylisted path become approved. (AC-10)
- **Path containment** uses one canonicalization routine (resolve symlinks, absolutize, normalize, Windows case-fold, then `X === Y || X.startsWith(Y + sep)`). Sibling-prefix matches like `D:\clients\acme2` against root `D:\clients\acme` are excluded. (AC-11)
- **A `cwd` that reaches a denylisted root through a symlink** is still denied, because canonicalization resolves it before matching — so pointing a symlink at `~/.ssh` and dispatching into it does not get past the check. Note the scope: cempala validates the `cwd` it is given. It does not scan the tree below an approved directory, and it cannot stop an already-running agent from following a symlink it finds there. (AC-12)
- **Sandbox scope** is set per agent CLI per dispatch:
  - Codex: `--sandbox workspace-write` (with `-c sandbox_workspace_write.network_access=true` only when `allow_network: true`). Egress is **OS-sandbox-enforced**.
  - Claude: `--tools "<baseline + WebFetch + WebSearch if allow_network>"`, plus `--disallowedTools "WebFetch,WebSearch"` only when `allow_network: false`. The web tools are removed, but Claude's `Bash` can still `curl`, so the dispatch result reports this honestly as `network_enforcement: "tools_only"` rather than the stronger `"sandboxed"` (which only Codex gets).
  - Antigravity: `--sandbox --mode accept-edits --add-dir <cwd>`. **`allow_network: false` cannot be enforced here**, and the result says so — see below. Its `--print-timeout` is also raised from agy's 5-minute default to the reaper's 30-minute window: agy is the only configured CLI that kills its own run on a clock, and at the default an Antigravity task would stop early while cempala went on tracking it.
  - OpenCode: `opencode run --format json` with a per-dispatch runtime permission policy. It denies questions, plan transitions, paths outside the validated workspace and nested subagents; `webfetch` and `websearch` are denied when `allow_network: false`. Its `Bash` tool can still make direct network requests, so the result honestly reports `network_enforcement: "tools_only"`, not `"sandboxed"`.
- **`--add-dir` is forbidden in `config.toml`** for every configured CLI. It's the documented escape hatch from the cwd-anchored scope, and any config that introduces it is rejected at load time. Cempala also rejects `--dangerously-skip-permissions` wherever present, plus OpenCode's `--auto`, so configuration cannot bypass its runtime permission policy.

  Cempala's own baseline does pass `--add-dir <cwd>` for Antigravity, and that is the opposite of an escape hatch — see below.

### Why Antigravity gets `--add-dir` when config may not

Codex and Claude take their working directory from the process: `spawnDetached({ cwd })` is the single mechanism, and a relative path in a prompt resolves there. **agy does not work that way.** It has a *workspace* concept separate from the process cwd, and with no workspace set it falls back to its own scratch directory.

Measured against agy 1.1.12: a dispatch with `cwd: <project>` asking for `./out.txt` wrote to `~/.gemini/antigravity-cli/scratch/out.txt`. The work silently landed somewhere the caller never looks, and the cwd-anchored scope — which cempala had validated the cwd for — simply did not apply to that agent.

So the baseline passes `--add-dir <the validated cwd>`. The flag stays forbidden in `config.toml`, and there is no contradiction between the two: the forbidden list is applied to *config-supplied* argv, where `--add-dir /` would **widen** scope past the validated cwd. In the baseline the argument **is** the validated cwd, so it **narrows** agy from "my scratch dir, wherever that is" down to exactly the directory cempala checked against the trust boundary and the denylist. Forbidden from config, required in the baseline, for one reason: the cwd is cempala's to set and nobody else's to change.

### What `allow_network` actually buys you, per agent

A `dispatch` that reached the point of spawning — a `completed`, `failed` or `running` result — carries a `network_enforcement` field. It describes what was *applied*, not what was *asked for*:

| Agent | `allow_network: false` | `allow_network: true` |
|---|---|---|
| `codex` | `"sandboxed"` — OS sandbox blocks egress | `"allowed"` |
| `claude` | `"tools_only"` — web tools removed, but `Bash` can still `curl` | `"allowed"` |
| `opencode` | `"tools_only"` — web tools and external paths denied, but Bash can still make network requests | `"allowed"` |
| `antigravity` | `"not_enforceable"` — **the request could not be applied** | `"allowed"` |

Antigravity gets a fourth label because `agy` exposes no argv-level network switch: it has no counterpart to Codex's `network_access` config key or Claude's `--tools` / `--disallowedTools`. Its network reach is governed by the `read_url` and `execute_url` permissions in *your own* agy settings, which Cempala neither reads nor writes. `--sandbox` is still applied — it confines the commands the agent *runs* (`sandbox-exec` on macOS, `nsjail` on Linux, AppContainer on Windows) — but that isn't a guarantee about the agent's own reach, so it doesn't earn the `"sandboxed"` label.

The dispatch still runs. Reporting `"sandboxed"` here would be the one failure this label set exists to prevent: a caller reading a guarantee that nothing in the command line backs up. If an Antigravity dispatch must be offline, set it in agy's own permissions.

### Antigravity and shell commands

`--mode accept-edits` lets agy read and write files in the dispatch cwd, the same way `--permission-mode acceptEdits` does for Claude. **Shell commands are a different matter.** In headless mode agy auto-denies any tool needing a permission it cannot prompt for, and it does so quietly: the run exits `0`, reports `status: "SUCCESS"`, returns an empty answer, and writes the only explanation to stderr.

Cempala reports that as a **failure**, with the reason attached:

```
status: "failed", exit_code: 1
result:  jetski: no output produced — a tool required the "command" permission
         that headless mode cannot prompt for, so it was auto-denied. Add an
         allow-rule under permissions.allow in settings.json …
```

That is not cempala overruling the agent. The agent said it produced no output — it just said so in prose on stderr rather than in its JSON envelope, and a run that announces it did nothing did not succeed. It's the same principle already applied to Claude's `is_error: true` alongside a zero exit.

The match is deliberately narrow, and only fires on that explicit did-nothing statement. An empty answer on its own stays `completed`: a prompt whose whole effect is a file edit can legitimately return no prose, and failing that would be its own misreport.

If you want Antigravity dispatches to run shell commands, add an allow-rule under `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`. Cempala will **not** pass `--dangerously-skip-permissions` to get around this — it's on the FR-14 forbidden list, and a `config.toml` that tries to add it is rejected at load time. Which tool agy reaches for isn't always predictable, so a prompt phrased toward file edits ("create the file at …") tends to work where one phrased toward the shell ("run a command to …") gets denied.

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

[agents.antigravity]
exec_command = ["agy", "-p"]
sandbox_args = ["--sandbox"]
permission_args = ["--mode", "accept-edits"]

[agents.opencode]
exec_command = ["opencode", "run"]
# Optional explicit provider/model, e.g. "opencode/big-pickle".
# model = "opencode/big-pickle"
```

All paths may use `~/`; `config.ts` expands them against `os.homedir()` on read. The file's denylist arrays are starting points. The compile-time baseline is unioned on top and cannot be weakened by trimming.

For safety, `sandbox_args` and `permission_args` are accepted only for backward-compatible configuration parsing; dispatch ignores their values and always applies Cempala's fixed per-agent sandbox and permission baseline. `exec_command` is the configurable command prefix; OpenCode's optional `model` is the only additional dispatch setting.

The dispatch agent ids are `codex`, `claude`, `antigravity` (binary: `agy`) and `opencode` (binary: `opencode`). Those are the names you pass as `target_agent`; executable names stay in `exec_command`.

## Development

```sh
bun install
bun run start               # run the server (for manual testing)
bun run typecheck           # tsc --noEmit
bun run test                # unit tests (bun test test/unit)
bun run test:install        # installer tests
bun run test:uninstall      # uninstaller tests
bun run test:integration    # exercises real Codex, Claude, and Antigravity CLIs
# Set CEMPALA_OPENCODE_INTEGRATION=1 and CEMPALA_OPENCODE_MODEL=<provider/model>
# to include the live OpenCode dispatch test (and ensure OpenCode is on PATH).
bun run build               # compile a binary for this platform
```

Build all six platform targets, with a `checksums.txt` the installers can verify against:

```sh
bash scripts/build-all.sh
```

Targets: `bun-darwin-{arm64,x64}`, `bun-linux-{arm64,x64}`, `bun-windows-{arm64,x64}.exe`.

A cross-compiled binary can't be run on the build host, so a successful build says nothing about the artifact. Every installer-selected target must pass:

```sh
bash scripts/smoke-test.sh dist/cempala-linux-x64
```

That drives the real MCP protocol — handshake, `tools/list`, and a message round-tripped through SQLite — rather than just checking `--version`, since "the binary starts" isn't the interesting failure mode. It runs in a temp `HOME`, so it never touches your real `~/.cempala`.

The installers are the one piece the Bun suite can't reach, and they're also the first and last thing every user runs, so they have suites of their own:

```sh
bash scripts/test-install.sh
```

```sh
bash scripts/test-uninstall.sh
```

Both drive the real scripts in a throwaway `HOME` with stub agent CLIs — `test-install.sh` against a stubbed `curl` and a release fixture, `test-uninstall.sh` against a *real compiled* cempala, since the uninstaller delegates its two delicate steps to the binary and a stub would prove almost nothing. Both run every case under `/bin/bash` as well as the bash on your `PATH`. Running them under the *oldest* bash you support is the point, not a detail: macOS still ships bash 3.2, which is what `curl … | bash` gets there, and it differs from any bash you're likely to have locally — an empty array expanded under `set -u` is an error rather than nothing. CI runs both on macOS as well as Linux for exactly that reason.

The uninstaller suite leans hardest on the failure modes, because those are the ones that quietly do damage: an unwritable rc file, a CLI whose `mcp remove` fails, a config it can't parse, a binary too old to know the flags. Each asserts the non-zero exit and the partial-uninstall banner, plus binary retention where a retry needs it; the purge-after-failure cases additionally assert that the database survives. A cleanup that can't finish must never look like one that did.

`.github/workflows/verify.yml` runs the unit suite on Linux, macOS and Windows, both installer suites on Linux and macOS, and smoke-tests every installer-selected build artifact on matching hardware. The binaries are built once and shipped to each runner, so what gets tested is the exact build output rather than a fresh per-platform rebuild. The experimental Windows ARM64 build is intentionally excluded until matching hardware is available. Some of the suite is meaningful only off Windows — the `spawnDetached` survival test is skipped there by design — so CI is the only place it actually executes.

## Architecture

- `src/index.ts`: MCP server entrypoint. Handles `--init`, `--register-antigravity`, `--unregister-antigravity`, `--unregister-opencode`, `--remove-path-block`, `--version`, `--help`; otherwise starts the stdio MCP server.
- `src/register-opencode.ts`: the *removal* half of the OpenCode registration, and only that half. Adding is `opencode mcp add`, which is non-interactive, idempotent, and comment-preserving — when a CLI ships a working subcommand, using it beats reimplementing it. There is no `opencode mcp remove`, so this is a byte-level cut through the JSONC rather than a parse-and-reserialise: reserialising would strip the comments the installer was careful to keep. Refuses anything it cannot scan confidently.
- `src/register-antigravity.ts`: the `mcp_config.json` merge, and its inverse. Lives in the binary rather than in the two installers, because a correct JSON merge in bash means depending on `jq` or `python3`, and writing it twice — once in bash, once in PowerShell — is two implementations of one rule. Takes an advisory lock, verifies the file hasn't changed since it was read, and backs up before writing.
- `src/uninstall-path-block.ts`: removes the `PATH` block `install.sh` writes. Here rather than in `uninstall.sh` for the same reason — except that this block is *written* in bash, so the writer and the remover genuinely are in two languages. They cannot share code: `install.sh` is fetched over the network and executed directly, so it has no sibling files to source. A unit test reads `install.sh` and asserts the marker and body constants still match, and that assertion is the only thing keeping the two in step.
- `src/db/`: raw SQL schema + `bun:sqlite` client. No ORM.
- `src/security/`: the ONLY path comparator (`paths.ts`), the ONLY trust-boundary decider (`trust-boundary.ts`), the ONLY denylist compiler (`denylist.ts`). Tool handlers consume these; they never re-derive.
- `src/platform/`: `paths.ts` for OS-correct filesystem locations, `spawn.ts` for the cross-platform detached spawn + PID liveness wrapper.
- `src/tools/`: one handler file per MCP tool, plus the shared helpers they lean on — `agent-args.ts` for the spawn argv, `agent-output.ts` for parsing what an agent wrote and settling its outcome, `task-liveness.ts` for deciding whether a run is still going. Handlers always return `{ok, data} | {ok: false, error, code}`; `needs_approval` is `ok: true` with `data.status === "needs_approval"`, not a failure.
- `src/reaper.ts`: FR-17, the stale running-task sweep, piggybacked on every tool call.
- `src/audit.ts`: FR-8, the append-only `audit_log` writer.
- `scripts/`: `install.sh` / `install.ps1` and `uninstall.sh` / `uninstall.ps1`, each pair self-contained so it can be run straight from a URL; `build-all.sh` for the six platform targets; `smoke-test.sh` for the per-platform check CI runs against workflow build artifacts; and `test-install.sh` / `test-uninstall.sh`, the suites for the two scripts Bun can't reach.

## The name

In Indonesian *wayang* theatre, the **cempala** is the small wooden mallet the puppeteer taps to cue the musicians and signal a change of scene. Here it plays the same role: a quiet cue that gets one agent to act on another's behalf.

## Disclaimer

Cempala is an independent project by theLabs. It is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI or Google. Claude and Claude Code are products of Anthropic; Codex and Codex CLI are products of OpenAI; Antigravity is a product of Google. Those names and trademarks belong to their respective owners, and are used here only to describe the tools Cempala works with.

## License

See [`LICENSE`](LICENSE).

<div align="center"><sub>© 2026 theLabs · <a href="https://thelabs.id">thelabs.id</a> · Cempala, cue your agents.</sub></div>
