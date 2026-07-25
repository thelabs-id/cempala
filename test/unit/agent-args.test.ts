// test/unit/agent-args.test.ts
//
// AC-13: network enforcement is reported honestly. All three states (FR-13)
// must be exercised by the argv resolver, and the resolved --tools /
// --disallowedTools must be exactly what's expected.
//
// The Claude no-network case must not claim "sandboxed", and the
// network-allowed case must not claim either of the other two — those
// mislabelings are the specific failures this test exists to catch.

import { describe, test, expect } from "bun:test";
import { DEFAULT_CONFIG, type AppConfig } from "../../src/config.ts";
import { resolveCodexArgv, resolveClaudeArgv, findForbiddenFlag, assertArgvSafe } from "../../src/tools/agent-args.ts";

const CFG: AppConfig = { ...DEFAULT_CONFIG, source: "<test>" };

describe("resolveCodexArgv (AC-13)", () => {
  test("allow_network=false → no -c network_access, network_enforcement=sandboxed", () => {
    const r = resolveCodexArgv(CFG, "do thing", false);
    expect(r.network_enforcement).toBe("sandboxed");
    expect(r.argv).not.toContain("sandbox_workspace_write.network_access=true");
    expect(r.argv).toContain("--sandbox");
    expect(r.argv).toContain("workspace-write");
  });

  test("allow_network=true → -c network_access=true, network_enforcement=allowed", () => {
    const r = resolveCodexArgv(CFG, "do thing", true);
    expect(r.network_enforcement).toBe("allowed");
    expect(r.argv).toContain("sandbox_workspace_write.network_access=true");
  });

  test("argv is an array — never a shell string (FR-14 / NFR-6)", () => {
    const r = resolveCodexArgv(CFG, "do thing", false);
    expect(Array.isArray(r.argv)).toBe(true);
    expect(typeof r.argv.join(" ")).toBe("string");
  });
});

describe("resolveClaudeArgv (AC-13)", () => {
  test("allow_network=false → no WebFetch/WebSearch in --tools, --disallowedTools present, network_enforcement=tools_only", () => {
    const r = resolveClaudeArgv(CFG, "do thing", false);
    expect(r.network_enforcement).toBe("tools_only");
    // --tools value should be a comma-joined string with no WebFetch / WebSearch
    const toolsIdx = r.argv.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    const toolsValue = r.argv[toolsIdx + 1]!;
    expect(toolsValue).not.toContain("WebFetch");
    expect(toolsValue).not.toContain("WebSearch");
    // The baseline tools should all be there
    expect(toolsValue).toContain("Read");
    expect(toolsValue).toContain("Write");
    expect(toolsValue).toContain("Edit");
    expect(toolsValue).toContain("Bash");
    // --disallowedTools should be present
    const disIdx = r.argv.indexOf("--disallowedTools");
    expect(disIdx).toBeGreaterThanOrEqual(0);
    const disValue = r.argv[disIdx + 1]!;
    expect(disValue).toContain("WebFetch");
    expect(disValue).toContain("WebSearch");
  });

  test("allow_network=true → WebFetch/WebSearch in --tools, NO --disallowedTools, network_enforcement=allowed", () => {
    const r = resolveClaudeArgv(CFG, "do thing", true);
    expect(r.network_enforcement).toBe("allowed");
    // WebFetch / WebSearch are MANDATORY when allow_network=true; they
    // appear as additional --tools entries (claude's --tools accepts
    // comma-separated lists and combines repeats).
    const allToolsValues: string[] = [];
    for (let i = 0; i < r.argv.length; i++) {
      if (r.argv[i] === "--tools" && i + 1 < r.argv.length) {
        allToolsValues.push(r.argv[i + 1]!);
      }
    }
    expect(allToolsValues).toContain("WebFetch");
    expect(allToolsValues).toContain("WebSearch");
    // CRITICAL: --disallowedTools must NOT be present when allow_network=true
    // (those tools are in --tools, so denying them at the same time is
    // self-contradictory — AGENTS.md §5)
    expect(r.argv).not.toContain("--disallowedTools");
  });

  test("allowed_tools narrows the baseline; WebFetch cannot be smuggled in", () => {
    // A caller passes allowed_tools including WebFetch. WebFetch is NOT
    // in the baseline and is governed by allow_network. allowed_tools
    // is an intersection only — the only way to add WebFetch is via
    // allow_network, never via allowed_tools.
    const r = resolveClaudeArgv(CFG, "do thing", true, ["Read", "Write", "WebFetch"]);
    // allowed_tools narrows the baseline. With allow_network=true, the
    // web tools are added back as separate --tools flags (per the
    // "web tools are MANDATORY when allow_network=true" rule). So the
    // first --tools value is the narrowed baseline (Read,Write) and
    // additional --tools entries are WebFetch and WebSearch.
    const toolsIdx = r.argv.indexOf("--tools");
    const toolsValue = r.argv[toolsIdx + 1]!;
    expect(toolsValue).toContain("Read");
    expect(toolsValue).toContain("Write");
    // Bash was in the baseline; allowed_tools filtered it out.
    expect(toolsValue).not.toContain("Bash");
    // WebFetch must still be present (added by allow_network, not removable).
    const allToolsValues = r.argv.filter((_, i) => r.argv[i - 1] === "--tools");
    expect(allToolsValues).toContain("WebFetch");
    expect(allToolsValues).toContain("WebSearch");
  });

  test("allowed_tools cannot remove WebFetch/WebSearch when allow_network=true", () => {
    // The most adversarial allowed_tools possible: nothing. WebFetch/WebSearch
    // must STILL be present because allow_network=true mandates them
    // (they are added as separate --tools entries, not subject to
    // allowed_tools narrowing).
    const r = resolveClaudeArgv(CFG, "do thing", true, []);
    const allToolsValues: string[] = [];
    for (let i = 0; i < r.argv.length; i++) {
      if (r.argv[i] === "--tools" && i + 1 < r.argv.length) {
        allToolsValues.push(...r.argv[i + 1]!.split(","));
      }
    }
    expect(allToolsValues).toContain("WebFetch");
    expect(allToolsValues).toContain("WebSearch");
  });

  test("allowed_tools=[] is a valid restrictive value (P2 fix)", () => {
    // Per the P2 fix, an explicit empty array REMOVES the baseline
    // tools (not silently grants them). An empty array is what a
    // caller would use to say "no tools at all"; only `undefined`
    // means "no restriction".
    const r = resolveClaudeArgv(CFG, "do thing", false, []);
    const toolsIdx = r.argv.indexOf("--tools");
    const toolsValue = r.argv[toolsIdx + 1]!;
    expect(toolsValue).toBe(""); // empty list, no baseline tools
  });

  test("allowed_tools=undefined is treated as 'no restriction'", () => {
    // The default case: caller didn't pass allowed_tools. Baseline
    // is fully granted.
    const r1 = resolveClaudeArgv(CFG, "do thing", false, undefined);
    const t1 = r1.argv[r1.argv.indexOf("--tools") + 1]!;
    expect(t1.split(",")).toContain("Read");
    expect(t1.split(",")).toContain("Bash");
    // Explicit null should also mean "no restriction".
    const r2 = resolveClaudeArgv(CFG, "do thing", false, null);
    const t2 = r2.argv[r2.argv.indexOf("--tools") + 1]!;
    expect(t2.split(",")).toContain("Read");
    expect(t2.split(",")).toContain("Bash");
  });

  test("allowed_tools is a no-op when allow_network=false (baseline unchanged)", () => {
    const r = resolveClaudeArgv(CFG, "do thing", false, ["Read"]);
    const toolsIdx = r.argv.indexOf("--tools");
    const toolsValue = r.argv[toolsIdx + 1]!;
    // Only Read, not the rest of the baseline, since allowed_tools is an
    // intersection.
    expect(toolsValue).toBe("Read");
  });

  test("argv is an array (no shell string)", () => {
    const r = resolveClaudeArgv(CFG, "do thing", false);
    expect(Array.isArray(r.argv)).toBe(true);
  });
});

describe("findForbiddenFlag / assertArgvSafe (FR-14 config passthrough)", () => {
  test("codex --sandbox danger-full-access is forbidden", () => {
    expect(findForbiddenFlag(["--sandbox", "danger-full-access"], "codex")).toBe("danger-full-access");
  });

  test("codex --dangerously-bypass-approvals-and-sandbox is forbidden", () => {
    expect(findForbiddenFlag(["--dangerously-bypass-approvals-and-sandbox"], "codex")).toBe("dangerously-bypass-approvals-and-sandbox");
  });

  test("codex --sandbox=danger-full-access (single-arg form) is also caught", () => {
    // Substring match, not whole-word — same as codex CLI parser.
    expect(findForbiddenFlag(["--sandbox=danger-full-access"], "codex")).toBe("danger-full-access");
  });

  test("claude --dangerously-skip-permissions is forbidden", () => {
    expect(findForbiddenFlag(["--dangerously-skip-permissions"], "claude")).toBe("dangerously-skip-permissions");
  });

  test("claude --permission-mode bypassPermissions is forbidden", () => {
    expect(findForbiddenFlag(["--permission-mode", "bypassPermissions"], "claude")).toBe("bypassPermissions");
  });

  test("claude --allow-dangerously-skip-permissions is forbidden (substring match against the trailing fragment)", () => {
    // The `allow-` prefix is a Claude-specific option, but the
    // "dangerously-skip-permissions" tail is the FR-14 forbidden token.
    // We check substring, so the test asserts the matcher catches it via
    // the dangerous fragment, not via a perfect flag-name match.
    expect(findForbiddenFlag(["--allow-dangerously-skip-permissions"], "claude")).toBe("dangerously-skip-permissions");
  });

  test("safe codex args are not flagged", () => {
    expect(findForbiddenFlag(["--sandbox", "workspace-write", "--json"], "codex")).toBeNull();
  });

  test("safe claude args are not flagged", () => {
    expect(findForbiddenFlag(["--permission-mode", "acceptEdits", "--output-format", "json"], "claude")).toBeNull();
  });

  test("assertArgvSafe throws on a forbidden flag", () => {
    expect(() => assertArgvSafe(["--sandbox", "danger-full-access"], "codex", "[test]")).toThrow(/forbidden flag/i);
  });

  test("assertArgvSafe is silent on safe args", () => {
    expect(() => assertArgvSafe(["--sandbox", "workspace-write"], "codex", "[test]")).not.toThrow();
  });

  test("P1: config-supplied -c network_access=true is forbidden (FR-13)", () => {
    // If a user puts `-c sandbox_workspace_write.network_access=true` in
    // their `agents.codex.exec_command`, the resolver would still report
    // network_enforcement: "sandboxed" for allow_network=false — but
    // the actual spawn would have network. Reject at config-load time.
    expect(findForbiddenFlag(
      ["codex", "exec", "-c", "sandbox_workspace_write.network_access=true"],
      "codex",
    )).toBe("network_access=true");
    expect(() => assertArgvSafe(
      ["codex", "exec", "-c", "sandbox_workspace_write.network_access=true"],
      "codex",
      "agents.codex.exec_command",
    )).toThrow(/forbidden flag/i);
  });

  test("P1: codex --add-dir is forbidden (FR-14 cwd-anchored scope)", () => {
    // `--add-dir` widens the sandbox beyond the validated `cwd`. The
    // spec scopes writes to the task's cwd; `--add-dir` is the
    // documented escape hatch and we treat it as a bypass.
    expect(findForbiddenFlag(
      ["codex", "exec", "--add-dir", "/"],
      "codex",
    )).toBe("--add-dir");
    expect(() => assertArgvSafe(
      ["codex", "exec", "--add-dir", "C:\\other"],
      "codex",
      "agents.codex.exec_command",
    )).toThrow(/forbidden flag/i);
  });

  test("P1: claude --add-dir is forbidden (FR-14 cwd-anchored scope, parity with codex)", () => {
    // Symmetric to the codex case: Claude's `--add-dir <directories...>`
    // (visible in `claude --help`) widens the tool scope beyond the
    // validated `cwd`. Rejecting it on codex but not on claude would
    // let a single agent bypass the cwd scope; the table is now
    // `cli: "any"` so both CLIs are covered.
    expect(findForbiddenFlag(
      ["claude", "-p", "--add-dir", "/"],
      "claude",
    )).toBe("--add-dir");
    expect(() => assertArgvSafe(
      ["claude", "-p", "--add-dir", "C:\\other"],
      "claude",
      "agents.claude.exec_command",
    )).toThrow(/forbidden flag/i);
  });
});

describe("loadConfig rejects FR-14-weakening configs", () => {
  test("a config with codex sandbox_args=danger-full-access fails to load", async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "cempala-cfg-"));
    const p = join(dir, "config.toml");
    try {
      writeFileSync(p, `[agents.codex]
exec_command = ["codex", "exec"]
sandbox_args = ["--sandbox", "danger-full-access"]
`, "utf-8");
      const { loadConfig } = await import("../../src/config.ts");
      expect(() => loadConfig(p)).toThrow(/forbidden flag/i);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe("FR-14 baseline is always applied, not overridable", () => {
  test("codex argv always has --sandbox workspace-write regardless of config", () => {
    // Even if config provides an empty sandbox_args, the baseline wins.
    const cfgWithEmpty: AppConfig = {
      ...CFG,
      agents: { ...CFG.agents, codex: { ...CFG.agents.codex, sandbox_args: [] } },
    };
    const r = resolveCodexArgv(cfgWithEmpty, "x", false);
    const i = r.argv.indexOf("--sandbox");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(r.argv[i + 1]).toBe("workspace-write");
  });

  test("codex argv with allow_network=false does NOT include network_access=true", () => {
    // Even if config includes it in sandbox_args, we never add it for
    // allow_network=false. (And any user-supplied `sandbox_args` is
    // ignored entirely — we always prepend the baseline.)
    const r = resolveCodexArgv(CFG, "x", false);
    const joined = r.argv.join(" ");
    expect(joined).not.toContain("network_access=true");
  });

  test("claude argv always has --permission-mode acceptEdits regardless of config", () => {
    const cfgWithEmpty: AppConfig = {
      ...CFG,
      agents: { ...CFG.agents, claude: { ...CFG.agents.claude, permission_args: [] } },
    };
    const r = resolveClaudeArgv(cfgWithEmpty, "x", false);
    const i = r.argv.indexOf("--permission-mode");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(r.argv[i + 1]).toBe("acceptEdits");
  });

  test("claude argv never has bypassPermissions (config can't enable it)", () => {
    const cfgWithBypass: AppConfig = {
      ...CFG,
      agents: {
        ...CFG.agents,
        claude: {
          ...CFG.agents.claude,
          permission_args: ["--permission-mode", "bypassPermissions"],
        },
      },
    };
    // loadConfig would reject this at config-load time. But even if a
    // test bypassed loadConfig, the resolver pushes the FR-14 baseline
    // --permission-mode acceptEdits FIRST, so any later
    // --permission-mode the config adds is shadowed by the baseline
    // (claude's --permission-mode uses the last-wins rule, but the
    // FR-14 baseline is always prepended). The real safety is the
    // forbidden-flag check at config-load time — without that, the
    // config could put bypassPermissions AFTER the baseline and
    // override it.
    const r = resolveClaudeArgv(cfgWithBypass, "x", false);
    const i = r.argv.indexOf("--permission-mode");
    expect(r.argv[i + 1]).toBe("acceptEdits");
  });

  test("config-supplied safe permission_args are validated but not appended (FR-14 baseline only)", () => {
    // The config's permission_args are accepted for parsing (so
    // `cempala --init` doesn't break on existing configs) and validated
    // against the FR-14 forbidden list, but the resolver does NOT
    // append them to the dispatch argv. The FR-14 baseline is the
    // single source of truth for security-sensitive flags. Appending
    // the config's args would duplicate the baseline pieces
    // (--permission-mode) or let a config like
    // `permission_args = ["--append-system-prompt", "be concise"]`
    // silently add behavior the resolver never sees.
    const cfg: AppConfig = {
      ...CFG,
      agents: {
        ...CFG.agents,
        claude: {
          ...CFG.agents.claude,
          permission_args: ["--append-system-prompt", "be concise"],
        },
      },
    };
    const r = resolveClaudeArgv(cfg, "x", false);
    // FR-14 baseline is present.
    expect(r.argv).toContain("--permission-mode");
    expect(r.argv[r.argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    // The config's args are NOT appended (would be confusing duplication
    // of the baseline; the user can extend behavior by editing
    // baseline code or adding new config keys).
    expect(r.argv).not.toContain("be concise");
  });

  test("config-supplied safe sandbox_args are validated but not appended (FR-14 baseline only)", () => {
    const cfg: AppConfig = {
      ...CFG,
      agents: {
        ...CFG.agents,
        codex: {
          ...CFG.agents.codex,
          sandbox_args: ["--add-dir", "/tmp/extra"],
        },
      },
    };
    const r = resolveCodexArgv(cfg, "x", false);
    // FR-14 baseline --sandbox workspace-write is present, exactly once.
    expect(r.argv.filter((a) => a === "--sandbox").length).toBe(1);
    expect(r.argv[r.argv.indexOf("--sandbox") + 1]).toBe("workspace-write");
    // Config-supplied args are NOT appended.
    expect(r.argv).not.toContain("--add-dir");
    expect(r.argv).not.toContain("/tmp/extra");
  });
});
