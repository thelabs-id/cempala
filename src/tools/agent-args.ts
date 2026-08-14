// src/tools/agent-args.ts
//
// Builds the argv array for `Bun.spawn` for a given (agent, allow_network,
// allowed_tools) triple. The single source for the FR-13 / FR-14 flag
// mapping. Everything else (including dispatch.ts and the test that proves
// AC-13) reads the resolved argv and the resolved network_enforcement
// label from here.
//
// Critical rules:
//   - `--tools` defines which built-in tools exist for the session.
//     `--allowedTools` only pre-approves tools that would otherwise prompt,
//     and cannot take a tool away. Therefore the FR-14 restriction is
//     built with --tools, not --allowedTools.
//   - `--disallowedTools "WebFetch,WebSearch"` is conditional on
//     `allow_network = false` — when network is allowed those tools are
//     in --tools, so denying them at the same time contradicts itself.
//   - `allowed_tools` can only narrow the baseline; any name in it that
//     isn't already in the baseline is dropped, not added. WebFetch /
//     WebSearch are never in the baseline and are governed solely by
//     `allow_network`, so a caller cannot smuggle them back in through
//     `allowed_tools`.
//   - User config (config.toml) is NEVER allowed to weaken FR-14: any
//     flag from the forbidden list (FR-14 table) is rejected at config
//     load time. This is a one-line check, but the moment you skip it,
//     "the user can weaken the trust boundary via a TOML edit" becomes
//     true — and that's not the threat model we want.

import { isAbsolute } from "node:path";
import type { AppConfig, AgentConfig } from "../config.ts";
import { ACTIVITY_GRACE_MS } from "./task-liveness.ts";

/** The agent CLIs cempala knows how to spawn. */
export type AgentId = "codex" | "claude" | "antigravity" | "opencode";

/**
 * Network enforcement label (FR-13).
 *
 * The first three describe a restriction we actually imposed on the child:
 * codex is sandboxed, Claude/OpenCode have web tools taken away, or the
 * caller asked for network and got it.
 *
 * `not_enforceable` is the fourth, and it is an admission rather than a
 * restriction. The Antigravity CLI exposes no argv-level control over
 * network access — its `read_url` / `execute_url` permissions live in the
 * user's own agy settings, which cempala neither reads nor writes, and
 * `--sandbox` confines the commands the agent RUNS rather than the agent's
 * own reach. So a dispatch with `allow_network: false` still runs, and the
 * result says plainly that the request could not be enforced.
 *
 * Reporting one of the other three there would be the one failure this
 * label set exists to prevent: a caller reading "sandboxed" and believing
 * a guarantee that nothing in the argv backs up.
 */
export type NetworkEnforcement = "sandboxed" | "tools_only" | "allowed" | "not_enforceable";

/**
 * FR-14 baseline: the built-in tools that the spawned Claude session has
 * available. WebFetch and WebSearch are intentionally absent and are
 * toggled solely by `allow_network`.
 */
const CLAUDE_BASELINE_TOOLS = ["Read", "Write", "Edit", "Bash"] as const;

const WEB_TOOLS = ["WebFetch", "WebSearch"] as const;

/**
 * FR-14 forbidden flag table. A config that introduces any of these
 * substrings into the agent argv is rejected. Substring match (not whole
 * word) so `--sandbox=danger-full-access` and `--sandbox danger-full-access`
 * are both caught. Claude's "or any future bypass flag" caveat applies
 * symmetrically.
 *
 * We also block the Codex config key that enables network egress
 * (`-c sandbox_workspace_write.network_access=true`). If a user puts
 * this in their `agents.codex.exec_command`, our resolver would still
 * report `network_enforcement: "sandboxed"` for `allow_network=false`,
 * but the actual spawn would have network access. That's a real
 * guarantee violation — the reported label would lie. Rejecting the flag
 * at config-load time keeps the label honest.
 *
 * Finally we block `--add-dir` for BOTH clis (P1 fix). `--add-dir /` or
 * `--add-dir <other-cwd>` would widen the sandbox beyond the validated
 * `cwd`, violating FR-14's cwd-anchored scope. The spec scopes writes
 * to the task's cwd; `--add-dir` is the documented escape hatch from
 * that scope on both Codex and Claude and we treat it as a bypass on
 * either CLI. Claude's `--add-dir` (shown by `claude --help` as
 * `--add-dir <directories...>`) was previously missing from this list,
 * letting a config add Claude cwd-widening without config-load
 * rejection.
 */
const FORBIDDEN_FLAG_SUBSTRINGS: Array<{ cli: AgentId | "any"; needle: string }> = [
  // Codex (FR-14 table)
  { cli: "codex", needle: "danger-full-access" },
  { cli: "codex", needle: "dangerously-bypass-approvals-and-sandbox" },
  { cli: "codex", needle: "dangerously-bypass-hook-trust" },
  // Codex network-enable config key (FR-13)
  { cli: "codex", needle: "network_access=true" },
  // Sandbox-widening (FR-14 cwd-anchored scope) — applies to EVERY CLI.
  // `cli: "any"` is correct: `claude --help`, `codex --help` and
  // `agy --help` all document `--add-dir` with the same purpose, so
  // banning it on some but not others would let one agent bypass the
  // cwd scope the other two are held to.
  { cli: "any", needle: "--add-dir" },
  // Approval-bypass. Claude spells it `--dangerously-skip-permissions`
  // and Antigravity spells it identically (`agy --help`:
  // "Auto-approve all tool permission requests without prompting"), so
  // this is `any` rather than one entry per CLI — a needle that has to
  // be repeated for each new agent is a needle someone will forget to
  // repeat. The substring also catches Claude's
  // `--allow-dangerously-skip-permissions`, which differs only by
  // prefix.
  { cli: "any", needle: "dangerously-skip-permissions" },
  { cli: "claude", needle: "bypassPermissions" },
  // OpenCode calls this an explicit dangerous bypass. Cempala provides its
  // own narrow permission policy instead of allowing config to opt out.
  { cli: "opencode", needle: "--auto" },
];

/**
 * Validate a single argv segment list against the FR-14 forbidden table.
 * Returns the first forbidden needle found (if any), or null. The caller
 * decides whether to error (config load) or replace the args (built-in
 * defaults). Substring match is intentional — `--sandbox=danger-full-access`
 * is a real attack vector and whole-word equality would let it through.
 */
export function findForbiddenFlag(argv: readonly string[], cli: AgentId): string | null {
  for (const entry of FORBIDDEN_FLAG_SUBSTRINGS) {
    if (entry.cli !== "any" && entry.cli !== cli) continue;
    for (const arg of argv) {
      if (typeof arg !== "string") continue;
      if (arg.includes(entry.needle)) return entry.needle;
    }
  }
  return null;
}

/**
 * Validate a config-supplied argv list. Throws on a forbidden flag; the
 * caller is expected to bubble this up to a config-load error.
 */
export function assertArgvSafe(argv: readonly string[], cli: AgentId, source: string): void {
  const hit = findForbiddenFlag(argv, cli);
  if (hit) {
    throw new Error(
      `cempala config rejected: ${source} for agent '${cli}' contains forbidden flag '${hit}' ` +
      `(see FR-14). Trimming the config cannot weaken the baseline; this is a hard fail.`,
    );
  }
}

export interface ResolvedArgv {
  /** Full argv for Bun.spawn. argv[0] is the executable name. */
  argv: string[];
  /** Environment variables that must accompany this one dispatch. */
  env?: Record<string, string>;
  /** What kind of network enforcement is actually in effect (FR-13). */
  network_enforcement: NetworkEnforcement;
  /** Human-readable summary, for logs and tests. */
  description: string;
}

/**
 * Resolve the argv to spawn a Codex CLI invocation.
 *
 *   allow_network=false → --sandbox workspace-write          (FR-14 baseline)
 *   allow_network=true  → --sandbox workspace-write -c sandbox_workspace_write.network_access=true
 *
 * `allowed_tools` is a no-op for codex (per the dispatch spec).
 *
 * Implementation note: codex refuses to run outside a git repository
 * unless --skip-git-repo-check is supplied. We always add the flag —
 * trusting the user's trust-boundary check more than codex's own
 * directory-shape heuristic. This is not a bypass of any sandbox or
 * approval; it only affects whether the command runs at all.
 *
 * SECURITY: per FR-14, `--sandbox workspace-write` is part of the
 * always-applied baseline. We deliberately do NOT honor any
 * `sandbox_args` override in user config for the actual sandbox flag,
 * because that would let a TOML edit silently weaken the spec's
 * narrowest-scope guarantee. The config key is accepted for parsing
 * compatibility (so users can keep their existing toml without
 * breaking `cempala --init`), but its content is NOT appended to the
 * dispatch argv. The compile-time baseline is the single source of
 * truth for `--sandbox`/`--permission-mode`; everything else in
 * `sandbox_args` is also redundant with the broader FR-14 forbidden
 * list (e.g. `--add-dir` for cwd scope, `danger-full-access` for
 * sandbox widening), so the config key's remaining utility is
 * effectively zero. We keep the field rather than remove it so old
 * configs don't fail to parse.
 */
export function resolveCodexArgv(
  cfg: AppConfig,
  prompt: string,
  allow_network: boolean,
): ResolvedArgv {
  const a: AgentConfig = cfg.agents.codex;
  const argv: string[] = [...a.exec_command];
  // FR-14 baseline — always applied, not overridable via config.
  // The config's `sandbox_args` key is parsed and validated at config
  // load time (so config-time additions are still subject to the
  // FR-14 forbidden list) but is NOT appended here. Doing so would
  // either duplicate the baseline (when the config sets it to the
  // canonical FR-14 value) or duplicate individual flag values
  // (--sandbox, --permission-mode) when the config adds extra flags.
  // The baseline is the single source of truth for these pieces; the
  // config's `sandbox_args` is accepted for parsing compatibility
  // (and so users can add it without breaking on `cempala --init`)
  // but its content is not threaded into the dispatch argv.
  argv.push("--sandbox", "workspace-write");
  argv.push("--skip-git-repo-check");
  if (allow_network) {
    argv.push("-c", "sandbox_workspace_write.network_access=true");
  }
  argv.push("--json");
  argv.push(prompt);
  return {
    argv,
    network_enforcement: allow_network ? "allowed" : "sandboxed",
    description: `codex exec ${allow_network ? "workspace-write(net=on)" : "workspace-write(net=off)"}`,
  };
}

/**
 * Resolve the argv to spawn a Claude CLI invocation.
 *
 *   allow_network=false → --tools "<baseline>" --disallowedTools "WebFetch,WebSearch"
 *   allow_network=true  → --tools "<baseline + WebFetch + WebSearch>"  (no --disallowedTools)
 *
 * `allowed_tools` can only narrow the baseline. WebFetch / WebSearch are
 * never in the baseline and are governed by `allow_network` — and when
 * `allow_network` is true, they are MANDATORY: `allowed_tools` cannot
 * remove them. (A user who explicitly disallows web tools in
 * `allowed_tools` does not get to silently disable the network; the
 * network flag is the one and only toggle for web-tool presence. This
 * matches the spec's "WebFetch / WebSearch are never in the baseline
 * and are governed solely by `allow_network`" rule.)
 *
 * Implementation note: claude `-p` is positional in spirit — when the
 * prompt follows the other flags as the last argument, the CLI's input
 * parser fails to recognize it as the prompt and falls back to expecting
 * stdin. The fix is to put the prompt immediately after `-p`, before
 * the rest of the flags. The spec doesn't pin this layout but it is the
 * one that actually works in the current CLI.
 */
export function resolveClaudeArgv(
  cfg: AppConfig,
  prompt: string,
  allow_network: boolean,
  allowed_tools?: string[] | null,
): ResolvedArgv {
  const a: AgentConfig = cfg.agents.claude;
  // exec_command is e.g. ["claude", "-p"]; the prompt goes RIGHT after
  // -p, then the rest of the flags follow.
  const argv: string[] = [...a.exec_command, prompt];

  // 1. Start from the baseline. WebFetch/WebSearch are NEVER in the
  //    baseline — `allow_network` is the only thing that adds them.
  const tools: string[] = [...CLAUDE_BASELINE_TOOLS];

  // 2. Narrow via allowed_tools: intersection only, never addition. This
  //    cannot smuggle WebFetch/WebSearch in (they're not in `tools` to
  //    begin with). An explicit empty array is a valid (restrictive)
  //    value: it removes all baseline tools. Only `undefined` /
  //    `null` means "no restriction" — i.e. the caller didn't say.
  if (Array.isArray(allowed_tools)) {
    const filtered = tools.filter((t) => allowed_tools.includes(t));
    argv.push("--tools", filtered.join(","));
  } else {
    argv.push("--tools", tools.join(","));
  }

  // 3. Permission baseline — always applied. As with the codex
  //    --sandbox flag (above), config's permission_args is accepted
  //    for parsing but NOT appended to the dispatch argv. The
  //    baseline is the single source of truth.
  argv.push("--permission-mode", "acceptEdits");

  // 4. Output format: keep JSON for the wrapper to parse.
  argv.push("--output-format", "json");

  // 5. Belt-and-braces: when network is off, deny web
  //    tools explicitly. They are already absent from --tools in this
  //    case, so this is redundant for our baseline; but if the user has
  //    overridden the baseline elsewhere, the second line keeps the
  //    guarantee.
  if (!allow_network) {
    argv.push("--disallowedTools", [...WEB_TOOLS].join(","));
  }

  // 6. Web tools are MANDATORY when allow_network=true and cannot be
  //    removed by allowed_tools. We push them as separate --tools
  //    entries — Claude's --tools accepts comma-separated lists and
  //    combines duplicates into a single set.
  if (allow_network) {
    for (const w of WEB_TOOLS) {
      argv.push("--tools", w);
    }
  }

  return {
    argv,
    network_enforcement: allow_network ? "allowed" : "tools_only",
    description: `claude -p ${allow_network ? "tools=baseline+web" : "tools=baseline,web-denied"}`,
  };
}

/**
 * Resolve the argv to spawn an Antigravity CLI (`agy`) invocation.
 *
 *   allow_network=false → --sandbox                (network NOT enforced)
 *   allow_network=true  → --sandbox                (identical argv)
 *
 * The two cases producing the same argv is the honest outcome, not an
 * oversight. `agy --help` offers no counterpart to codex's
 * `sandbox_workspace_write.network_access` or to claude's `--tools` /
 * `--disallowedTools`: network reach is governed by the `read_url` and
 * `execute_url` permissions in the user's own agy settings, which cempala
 * does not touch. So `allow_network: false` cannot be enforced from here,
 * and the resolver says exactly that via `not_enforceable` rather than
 * borrowing a label whose guarantee it cannot keep.
 *
 * `--sandbox` is applied unconditionally, as the FR-14 narrowest-scope
 * baseline for this agent. It is the nearest analogue to codex's
 * `--sandbox workspace-write`: it confines the commands the agent runs
 * (sandbox-exec on macOS, nsjail on Linux, AppContainer on Windows). It is
 * NOT a network guarantee for the agent itself, which is precisely why it
 * does not earn the `sandboxed` label.
 *
 * `--mode accept-edits` is the counterpart to claude's
 * `--permission-mode acceptEdits`: without it, headless agy soft-denies
 * the approvals it cannot ask for and returns having done nothing.
 *
 * `allowed_tools` is a no-op here, as it is for codex — agy has no
 * argv-level tool allowlist. Silently accepting it and doing nothing is
 * the existing contract for an agent that cannot honor it; what we must
 * not do is report a narrower enforcement than we applied.
 */
export function resolveAntigravityArgv(
  cfg: AppConfig,
  prompt: string,
  cwd: string,
  allow_network: boolean,
): ResolvedArgv {
  const a: AgentConfig = cfg.agents.antigravity;
  // exec_command is e.g. ["agy", "-p"]; like claude's `-p`, the prompt is
  // the flag's value and goes immediately after it.
  const argv: string[] = [...a.exec_command, prompt];

  // Anchor agy to the validated cwd. This is NOT optional garnish, and it
  // is the one place cempala deliberately emits a flag its own config is
  // forbidden to contain — so the reasoning is worth stating in full.
  //
  // codex and claude take their working directory from the process:
  // `spawnDetached({ cwd })` is the single mechanism, and a relative path
  // in a prompt resolves there. agy does not work that way. It has a
  // WORKSPACE concept separate from the process cwd, and with no workspace
  // set it falls back to its own scratch directory. Measured against agy
  // 1.1.12: a dispatch with cwd=<project> asking for `./out.txt` wrote to
  // `~/.gemini/antigravity-cli/scratch/out.txt` instead. The work silently
  // landed somewhere the caller never looks, and FR-14's cwd-anchored
  // scope — which cempala validated the cwd for, and reported as enforced
  // — simply did not apply to this agent.
  //
  // `--add-dir` is on the FR-14 forbidden list, and that is not a
  // contradiction: the list is applied by `assertArgvSafe` to
  // CONFIG-supplied argv only. There it stops a `config.toml` widening the
  // scope past the validated cwd (`--add-dir /`). Here the argument IS the
  // validated cwd, so the flag does the opposite of widening — it narrows
  // agy from "my scratch dir, wherever that is" down to exactly the
  // directory cempala checked against the trust boundary and the denylist.
  // Forbidden from config, required in the baseline, for one reason: the
  // cwd is ours to set and nobody else's to change.
  //
  // The cwd must be absolute. dispatch passes the canonicalized path, and
  // a relative one here would be resolved by agy against whatever it
  // considers its own cwd — reintroducing exactly the ambiguity this flag
  // exists to remove.
  if (!cwd || !isAbsolute(cwd)) {
    throw new Error(
      `resolveAntigravityArgv requires an absolute cwd (got ${JSON.stringify(cwd)}); ` +
      `without it agy writes to its own scratch directory instead of the task's.`,
    );
  }
  argv.push("--add-dir", cwd);

  // FR-14 baseline — always applied, never sourced from config. As with
  // codex's --sandbox and claude's --permission-mode, the config's
  // sandbox_args / permission_args keys are parsed (and validated
  // against the forbidden list) but not threaded into the argv.
  argv.push("--mode", "accept-edits");
  argv.push("--sandbox");

  // Raise agy's own print-mode timeout to the reaper's window.
  //
  // agy is the only configured CLI that kills its own run on a
  // clock (`--print-timeout`, default 5m). Left at the default, an
  // Antigravity task would die at five minutes while cempala went on
  // tracking it for thirty — so a dispatch that timed out its wait and
  // told the caller to come back via `check_task` would resolve to a
  // truncated run, for a reason found nowhere in cempala's own settings.
  // codex and claude have no such self-limit, and an agent that quietly
  // stops early only when it happens to be this one is the kind of
  // asymmetry nobody thinks to look for.
  //
  // ACTIVITY_GRACE_MS is the right number to match: past it the reaper
  // sweeps the task regardless, so letting agy run longer would buy
  // nothing.
  argv.push("--print-timeout", `${Math.floor(ACTIVITY_GRACE_MS / 1000)}s`);

  // Output format: keep JSON so agent-output.ts gets the structured
  // envelope rather than prose it would have to hand back verbatim.
  argv.push("--output-format", "json");

  return {
    argv,
    network_enforcement: allow_network ? "allowed" : "not_enforceable",
    description: allow_network
      ? "agy -p sandbox(cmd) net=allowed"
      : "agy -p sandbox(cmd) net=requested-off-but-not-enforceable",
  };
}

/**
 * Runtime policy injected into every OpenCode dispatch.
 *
 * OpenCode's headless CLI operates its own permission system rather than an
 * OS sandbox. We therefore make its policy explicit for every spawned run:
 * normal workspace work remains available, but prompt/plan interaction,
 * external paths, subagents, and web tools (when networking is disallowed)
 * are denied. The policy arrives through OPENCODE_CONFIG_CONTENT, which
 * OpenCode loads as a runtime override after project configuration.
 *
 * This is intentionally a `tools_only` guarantee. Bash remains available so
 * an OpenCode agent can do ordinary development work, and a shell command can
 * still make a network request; claiming an OS-enforced no-network sandbox
 * would be false.
 */
function openCodeRuntimeConfig(allowNetwork: boolean): string {
  return JSON.stringify({
    permission: {
      "*": "allow",
      question: "deny",
      plan_enter: "deny",
      plan_exit: "deny",
      external_directory: "deny",
      task: "deny",
      webfetch: allowNetwork ? "allow" : "deny",
      websearch: allowNetwork ? "allow" : "deny",
    },
  });
}

/** Resolve an OpenCode non-interactive run and its runtime permissions. */
export function resolveOpenCodeArgv(
  cfg: AppConfig,
  prompt: string,
  allowNetwork: boolean,
): ResolvedArgv {
  const a: AgentConfig = cfg.agents.opencode;
  // An explicit empty --title makes OpenCode derive a local title from the
  // prompt instead of spending a second model request on session titling.
  // That keeps short headless dispatches single-request and makes provider
  // failures surface sooner.
  const argv = [...a.exec_command, "--format", "json", "--title", ""];
  if (a.model) argv.push("--model", a.model);
  argv.push(prompt);
  return {
    argv,
    network_enforcement: allowNetwork ? "allowed" : "tools_only",
    description: allowNetwork
      ? "opencode run format=json permissions=workspace,net=allowed"
      : "opencode run format=json permissions=workspace,web-tools-denied",
    env: { OPENCODE_CONFIG_CONTENT: openCodeRuntimeConfig(allowNetwork) },
  };
}

/**
 * Public entry point used by `dispatch`. Resolves the argv for the named
 * target agent. Throws on an unknown agent id (callers should validate
 * earlier).
 */
export function resolveAgentArgv(
  cfg: AppConfig,
  target_agent: AgentId,
  prompt: string,
  /**
   * The VALIDATED, canonical cwd — the same path dispatch spawns in.
   *
   * Required rather than optional on purpose. Only the antigravity branch
   * reads it today, and an optional parameter is one a future call site
   * forgets to pass; the failure that follows is silent (agy quietly
   * writing to its scratch dir), which is the worst kind to leave
   * available. Required means the compiler catches it.
   */
  cwd: string,
  allow_network: boolean,
  allowed_tools?: string[] | null,
): ResolvedArgv {
  if (target_agent === "codex") {
    return resolveCodexArgv(cfg, prompt, allow_network);
  }
  if (target_agent === "antigravity") {
    return resolveAntigravityArgv(cfg, prompt, cwd, allow_network);
  }
  if (target_agent === "opencode") {
    return resolveOpenCodeArgv(cfg, prompt, allow_network);
  }
  return resolveClaudeArgv(cfg, prompt, allow_network, allowed_tools);
}
