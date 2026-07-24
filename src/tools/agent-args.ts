// src/tools/agent-args.ts
//
// Builds the argv array for `Bun.spawn` for a given (agent, allow_network,
// allowed_tools) triple. The single source for the FR-13 / FR-14 flag
// mapping. Everything else (including dispatch.ts and the test that proves
// AC-13) reads the resolved argv and the resolved network_enforcement
// label from here.
//
// Critical rules from AGENTS.md §5:
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

import type { AppConfig, AgentConfig } from "../config.ts";

/** Network enforcement label (FR-13). Three states — see AGENTS.md §5. */
export type NetworkEnforcement = "sandboxed" | "tools_only" | "allowed";

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
 * Finally we block Codex's `--add-dir` (P1 fix). `--add-dir /` or
 * `--add-dir <other-cwd>` would widen the sandbox beyond the validated
 * `cwd`, violating FR-14's cwd-anchored scope. The spec scopes writes
 * to the task's cwd; `--add-dir` is the documented escape hatch from
 * that scope and we treat it as a bypass.
 */
const FORBIDDEN_FLAG_SUBSTRINGS: Array<{ cli: "codex" | "claude" | "any"; needle: string }> = [
  // Codex (FR-14 table)
  { cli: "codex", needle: "danger-full-access" },
  { cli: "codex", needle: "dangerously-bypass-approvals-and-sandbox" },
  { cli: "codex", needle: "dangerously-bypass-hook-trust" },
  // Codex network-enable config key (FR-13)
  { cli: "codex", needle: "network_access=true" },
  // Codex sandbox-widening (FR-14 cwd-anchored scope)
  { cli: "codex", needle: "--add-dir" },
  // Claude (FR-14 table). Each forbidden flag has its own needle; we
  // also include a "dangerously-skip-permissions" fragment so
  // `--allow-dangerously-skip-permissions` is caught (the flag name
  // contains the same trailing substring, just with a `allow-` prefix).
  { cli: "claude", needle: "dangerously-skip-permissions" },
  { cli: "claude", needle: "bypassPermissions" },
];

/**
 * Validate a single argv segment list against the FR-14 forbidden table.
 * Returns the first forbidden needle found (if any), or null. The caller
 * decides whether to error (config load) or replace the args (built-in
 * defaults). Substring match is intentional — `--sandbox=danger-full-access`
 * is a real attack vector and whole-word equality would let it through.
 */
export function findForbiddenFlag(argv: readonly string[], cli: "codex" | "claude"): string | null {
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
export function assertArgvSafe(argv: readonly string[], cli: "codex" | "claude", source: string): void {
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
 * `allowed_tools` is a no-op for codex (per AGENTS.md §6 / the
 * REQUIREMENTS.md §6 spec for dispatch).
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
 * narrowest-scope guarantee. The config key is retained for the rare
 * case where a user wants to add additional non-sandbox flags
 * (e.g. `--add-dir` for legitimate cross-dir work), but the
 * `--sandbox workspace-write` itself is always prepended from the
 * compile-time baseline. If the user-supplied `sandbox_args` is
 * missing or empty, behavior is unchanged.
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

  // 5. Belt-and-braces (AGENTS.md §5): when network is off, deny web
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
 * Public entry point used by `dispatch`. Resolves the argv for the named
 * target agent. Throws on an unknown agent id (callers should validate
 * earlier).
 */
export function resolveAgentArgv(
  cfg: AppConfig,
  target_agent: "codex" | "claude",
  prompt: string,
  allow_network: boolean,
  allowed_tools?: string[] | null,
): ResolvedArgv {
  if (target_agent === "codex") {
    return resolveCodexArgv(cfg, prompt, allow_network);
  }
  return resolveClaudeArgv(cfg, prompt, allow_network, allowed_tools);
}
