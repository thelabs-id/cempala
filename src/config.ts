// src/config.ts
//
// Loads ~/.cempala/config.toml. Per-OS path resolution: config values may
// use `~/` as a portable placeholder; we expand against os.homedir() on
// read, so the running server always has absolute paths in hand (the one
// place a literal `~` is legitimate).
//
// Behavior on missing config: returns defaults, never throws. `cempala --init`
// is what creates the on-disk file the first time; before that, everything
// still works with the compile-time baselines.

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_CONFIG_PATH, DEFAULT_DB_PATH, DEFAULT_OUTPUT_DIR, expandHome, ensureAbsolute } from "./platform/paths.ts";
import { assertArgvSafe, type AgentId } from "./tools/agent-args.ts";

export interface ServerConfig {
  db_path: string;
  output_dir: string;
}

export interface TrustConfig {
  home_root?: string; // omitted → resolved at use time
  denylist: string[];
}

export interface DispatchConfig {
  default_wait_seconds: number;
  max_wait_seconds: number;
  allow_network_default: boolean;
  denylist: { patterns: string[] };
}

export interface AgentConfig {
  exec_command: string[];
  sandbox_args?: string[];
  permission_args?: string[];
}

export interface AppConfig {
  server: ServerConfig;
  trust: TrustConfig;
  dispatch: DispatchConfig;
  agents: {
    codex: AgentConfig;
    claude: AgentConfig;
    antigravity: AgentConfig;
  };
  /** Where the config was actually loaded from (for diagnostics). */
  source: string;
}

const DEFAULTS: AppConfig = {
  // Note: this const is exported at the end of the file as `DEFAULT_CONFIG`
  // for tests that need a known-good config. Keep them in sync if you edit.

  server: {
    db_path: DEFAULT_DB_PATH,
    output_dir: DEFAULT_OUTPUT_DIR,
  },
  trust: {
    denylist: [],
  },
  dispatch: {
    default_wait_seconds: 120,
    max_wait_seconds: 600,
    allow_network_default: false,
    denylist: { patterns: [] },
  },
  agents: {
    codex: {
      exec_command: ["codex", "exec"],
      sandbox_args: ["--sandbox", "workspace-write"],
    },
    claude: {
      exec_command: ["claude", "-p"],
      permission_args: ["--permission-mode", "acceptEdits"],
    },
    antigravity: {
      // `agy` is the Antigravity CLI's binary name; the agent id stays
      // `antigravity` because that is the product users know it by, and
      // an id is much harder to change later than a config value.
      exec_command: ["agy", "-p"],
      sandbox_args: ["--sandbox"],
      permission_args: ["--mode", "accept-edits"],
    },
  },
  source: "<defaults>",
};

/**
 * Load config from disk if present, otherwise return defaults.
 * `~/` in values is expanded against os.homedir() here — the only place
 * raw `~` is ever allowed.
 */
export function loadConfig(path: string = DEFAULT_CONFIG_PATH): AppConfig {
  if (!existsSync(path)) return { ...DEFAULTS, source: "<defaults>" };
  const text = readFileSync(path, "utf-8");
  const parsed = Bun.TOML.parse(text) as Record<string, unknown>;
  const merged = mergeConfig(DEFAULTS, parsed);
  // Expand `~/` in path values.
  merged.server.db_path = ensureAbsolute(expandHome(merged.server.db_path));
  merged.server.output_dir = ensureAbsolute(expandHome(merged.server.output_dir));
  // home_root handling: validate BEFORE the falsy check, so an empty
  // string is treated as a misconfiguration (rejected) rather than as
  // "omitted" (which would let the trust boundary treat `""` as the
  // root, matching every absolute path — a P1 security hole).
  if (merged.trust.home_root !== undefined) {
    if (merged.trust.home_root.trim() === "") {
      throw new Error("cempala config rejected: [trust].home_root is empty; either set a real path or remove the key to use os.homedir()");
    }
    merged.trust.home_root = ensureAbsolute(expandHome(merged.trust.home_root));
  }
  merged.trust.denylist = merged.trust.denylist.map((d) => ensureAbsolute(expandHome(d)));
  merged.source = path;
  return merged;
}

function mergeConfig(base: AppConfig, raw: Record<string, unknown>): AppConfig {
  const out: AppConfig = JSON.parse(JSON.stringify(base));
  if (raw.server && typeof raw.server === "object") {
    Object.assign(out.server, raw.server as Partial<ServerConfig>);
  }
  if (raw.trust && typeof raw.trust === "object") {
    const t = raw.trust as Record<string, unknown>;
    if (typeof t.home_root === "string") out.trust.home_root = t.home_root;
    if (Array.isArray(t.denylist)) out.trust.denylist = t.denylist.filter((x): x is string => typeof x === "string");
  }
  if (raw.dispatch && typeof raw.dispatch === "object") {
    const d = raw.dispatch as Record<string, unknown>;
    if (typeof d.default_wait_seconds === "number") out.dispatch.default_wait_seconds = d.default_wait_seconds;
    if (typeof d.max_wait_seconds === "number") out.dispatch.max_wait_seconds = d.max_wait_seconds;
    if (typeof d.allow_network_default === "boolean") out.dispatch.allow_network_default = d.allow_network_default;
    if (d.denylist && typeof d.denylist === "object") {
      const dl = d.denylist as Record<string, unknown>;
      if (Array.isArray(dl.patterns)) {
        out.dispatch.denylist.patterns = dl.patterns.filter((x): x is string => typeof x === "string");
      }
    }
  }
  if (raw.agents && typeof raw.agents === "object") {
    const a = raw.agents as Record<string, unknown>;
    // One loop over the agent ids rather than a hand-written block each.
    // The blocks used to be per-agent copies, and they had already drifted:
    // codex validated `sandbox_args` but ignored `permission_args`, claude
    // did the reverse, so a forbidden flag parked in the key its agent's
    // block did not read reached the config unchecked. Every agent now gets
    // the same three checks, and adding a fourth agent cannot reintroduce
    // the asymmetry.
    for (const id of AGENT_IDS) {
      const c = a[id];
      if (!c || typeof c !== "object") continue;
      const raw_agent = c as Record<string, unknown>;
      for (const key of ["exec_command", "sandbox_args", "permission_args"] as const) {
        const v = raw_agent[key];
        if (!Array.isArray(v)) continue;
        const list = v.filter((x): x is string => typeof x === "string");
        assertArgvSafe(list, id, `agents.${id}.${key}`);
        out.agents[id][key] = list;
      }
    }
  }
  return out;
}

/**
 * The agents cempala ships wired up. Exported so the tool schema, the DB
 * seed and the dispatch validator all read the same list instead of each
 * keeping its own copy to fall out of date.
 */
export const AGENT_IDS = ["codex", "claude", "antigravity"] as const satisfies readonly AgentId[];

/**
 * The default config.toml that `cempala --init` writes. Deliberately omits
 * `home_root` (per the spec — let the running server call os.homedir() fresh
 * every start) and includes a starting-point denylist that the user can
 * extend, but that cannot weaken the compile-time baseline.
 */
export const DEFAULT_CONFIG_TEMPLATE = `# cempala — default configuration
# Written by \`cempala --init\`. Safe to edit; Cempala unions your additions
# with its compile-time baseline (the real enforcement source) so trimming
# this file cannot weaken the baseline.

[server]
db_path = "~/.cempala/cempala.db"
output_dir = "~/.cempala/outputs"

[trust]
# \`home_root\` is intentionally absent. When this key is missing, the
# running server calls os.homedir() fresh at startup, so the trust
# boundary cannot go stale if your home directory ever changes.
# Uncomment ONLY to use a different boundary:
# home_root = "/custom/path"

# Starting-point path denylist — extend, but the compiled baseline cannot
# be removed by trimming this list.
denylist = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.docker",
  "~/.config/gh",
  "~/.kube",
  "~/.npmrc",
  "~/.netrc",
]

[dispatch]
default_wait_seconds = 120
max_wait_seconds = 600
allow_network_default = false

[dispatch.denylist]
# Starting-point prompt denylist patterns — extend, but the compiled
# baseline cannot be removed by trimming this list.
patterns = [
  "rm -rf",
  "sudo ",
  "curl | sh",
  "curl | bash",
  "git push --force",
  "chmod -R 777",
]

# Commands are argv arrays, never shell strings — passed straight to
# Bun.spawn with no shell in between.
[agents.codex]
exec_command = ["codex", "exec"]
sandbox_args = ["--sandbox", "workspace-write"]

[agents.claude]
exec_command = ["claude", "-p"]
permission_args = ["--permission-mode", "acceptEdits"]

# Antigravity CLI. \`agy\` is the binary; \`antigravity\` is the agent id you
# use in \`dispatch\`. Note that a dispatch to this agent CANNOT enforce
# \`allow_network = false\`: agy has no argv-level network switch, so the
# result reports \`network_enforcement: "not_enforceable"\` rather than
# claiming a guarantee. Restrict its network reach in agy's own settings
# (the \`read_url\` / \`execute_url\` permissions) if that matters to you.
[agents.antigravity]
exec_command = ["agy", "-p"]
sandbox_args = ["--sandbox"]
permission_args = ["--mode", "accept-edits"]
`;

/**
 * Write the default config if absent. Idempotent: never overwrites an
 * existing user config (FR-22). Returns true if a file was written.
 */
export function initConfigIfMissing(path: string = DEFAULT_CONFIG_PATH): boolean {
  if (existsSync(path)) return false;
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(path, DEFAULT_CONFIG_TEMPLATE, "utf-8");
  return true;
}

/** Resolve the effective home root — config override or os.homedir() at call time. */
export function resolveHomeRoot(cfg: AppConfig): string {
  return cfg.trust.home_root ?? homedir();
}

/**
 * Deep-cloned default AppConfig for tests. Exporting a constant that the
 * test helpers can import without having to synthesize one.
 */
export const DEFAULT_CONFIG: AppConfig = JSON.parse(JSON.stringify(DEFAULTS));
