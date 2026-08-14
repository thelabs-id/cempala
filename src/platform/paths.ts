// src/platform/paths.ts
//
// Single source of truth for cempala's per-OS filesystem locations.
//
// Three rules:
//   1. Always os.homedir() + path.join — never a literal `~/` in code.
//   2. Config/db/output dirs are resolved here, imported everywhere else —
//      re-deriving `~/.cempala` in more than one place is the bug.
//   3. `~/` is allowed only as a value inside config.toml, and expanded by
//      config.ts against os.homedir() on read. This file is the resolved end.

import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";

/** Canonical Cempala directory under the user's home, e.g. `~/.cempala`. */
export const CEMPALA_HOME_DIR = join(homedir(), ".cempala");

/** Subdirectory holding the SQLite database. */
export const CEMPALA_DB_DIR = CEMPALA_HOME_DIR;

/** Subdirectory holding the MCP config and audit log. */
export const CEMPALA_CONFIG_DIR = CEMPALA_HOME_DIR;

/** Subdirectory holding the raw stdout/stderr captures of dispatched tasks. */
export const CEMPALA_OUTPUT_DIR = join(CEMPALA_HOME_DIR, "outputs");

/** Default SQLite database path. Resolved against home, no `~` left. */
export const DEFAULT_DB_PATH = join(CEMPALA_HOME_DIR, "cempala.db");

/** Default output dir for raw process output captures. */
export const DEFAULT_OUTPUT_DIR = CEMPALA_OUTPUT_DIR;

/** Default config file path. */
export const DEFAULT_CONFIG_PATH = join(CEMPALA_HOME_DIR, "config.toml");

/**
 * Antigravity's global MCP config, shared by the Antigravity IDE and the
 * `agy` CLI (`~/.gemini/config/mcp_config.json`, per
 * https://antigravity.google/docs/mcp).
 *
 * Note the `.gemini` directory: it is Antigravity's, despite the name, and
 * is NOT the separate Gemini CLI's config location. Writing one file
 * registers cempala with both Antigravity surfaces at once, which is why
 * the installer does not also touch the per-workspace
 * `.agents/mcp_config.json`.
 */
export const ANTIGRAVITY_MCP_CONFIG_PATH = join(homedir(), ".gemini", "config", "mcp_config.json");

/**
 * OpenCode's global config directory: `$XDG_CONFIG_HOME/opencode`, falling
 * back to `~/.config/opencode`.
 *
 * `~/.config` on every platform, Windows included — OpenCode reads the XDG
 * location there too rather than `%APPDATA%`, so this is deliberately not
 * branched on `process.platform`.
 */
export function openCodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".config"), "opencode");
}

/**
 * Every global config file OpenCode will READ an MCP entry out of.
 *
 * Used for unregistration, and the list is deliberately wider than the one
 * file `opencode mcp add` would write today. `mcp add` picks an existing
 * `opencode.json` and otherwise creates `opencode.jsonc`; `config.json` is
 * a legacy name it no longer writes but still loads — verified against
 * OpenCode 1.18.15, where a server defined only in `config.json` shows up
 * connected in `opencode mcp list`.
 *
 * Removal has to cover all three, because what matters is where the entry
 * IS, not where we would put it now: a config written by hand or by an
 * older OpenCode is still live, and cleaning only the file we favour today
 * leaves a registration pointing at a binary the uninstaller just deleted.
 */
export function openCodeConfigCandidates(): string[] {
  const dir = openCodeConfigDir();
  return [
    join(dir, "opencode.json"),
    join(dir, "opencode.jsonc"),
    join(dir, "config.json"),
  ];
}

/** Where the Windows installer drops the binary (separate from state). */
export const WINDOWS_BIN_DIR = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "Cempala", "bin")
  : null;

/** Where the macOS/Linux installer drops the binary. */
export const UNIX_BIN_DIR = join(CEMPALA_HOME_DIR, "bin");

/** The directory the installer should drop the binary into, per platform. */
export function installerBinDir(): string {
  return process.platform === "win32"
    ? (WINDOWS_BIN_DIR ?? join(CEMPALA_HOME_DIR, "bin"))
    : UNIX_BIN_DIR;
}

/**
 * Expand a leading `~/` (or `~`) against the home directory, in place.
 * Leaves any other path form untouched. Pure; no filesystem calls.
 */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return homedir() + p.slice(1);
  return p;
}

/**
 * Ensure a path is absolute. Relative paths are resolved against homedir()
 * for portability — Cempala has no working dir it can assume a relative
 * path is intended against.
 */
export function ensureAbsolute(p: string): string {
  if (isAbsolute(p)) return p;
  return join(homedir(), p);
}
