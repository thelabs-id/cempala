// src/register-antigravity.ts
//
// Registers cempala in Antigravity's global MCP config.
//
// Claude and Codex each ship an `mcp add` subcommand, so for those the
// installer just shells out and lets the CLI own its own config file.
// Antigravity has no such subcommand — `agy --help` lists agent, changelog,
// help, install, models, plugin and update, and nothing else; the docs say
// to "modify these files directly". So the merge has to happen somewhere,
// and this is it.
//
// It lives in the binary rather than in install.sh/install.ps1 for two
// reasons. A correct JSON merge in bash means depending on jq or python3,
// neither of which is guaranteed present on a machine that just downloaded
// a self-contained binary. And doing it twice — once in bash, once in
// PowerShell — means two implementations of one rule, which is the drift
// this codebase has already paid for elsewhere (see agent-output.ts).
//
// The one rule this file exists to keep: NEVER destroy a config we did not
// write. Anything unparseable, or not shaped the way we expect, is left
// exactly as it was found and reported back for the human to handle.

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { ANTIGRAVITY_MCP_CONFIG_PATH } from "./platform/paths.ts";

/** The key cempala registers itself under, inside `mcpServers`. */
export const SERVER_KEY = "cempala";

export type RegisterOutcome =
  /** The file already held exactly this registration. Nothing was written. */
  | { kind: "unchanged"; path: string }
  /** The config file did not exist; we created it. */
  | { kind: "created"; path: string }
  /** An existing config was updated, preserving every other server. */
  | { kind: "updated"; path: string }
  /**
   * We refused to touch the file. `snippet` is what the user should merge
   * by hand — printing the exact JSON is the difference between a usable
   * message and "something went wrong".
   */
  | { kind: "manual"; path: string; reason: string; snippet: string };

export interface RegisterOptions {
  /** Absolute path to the cempala executable to register. */
  binaryPath: string;
  /** Override the config location. Defaults to Antigravity's global path. */
  configPath?: string;
}

/** The server entry we write. stdio transport: a command, no args. */
function entryFor(binaryPath: string): Record<string, unknown> {
  return { command: binaryPath };
}

/**
 * Is the existing entry already the one we would write?
 *
 * Compared field by field against what we'd produce, rather than by
 * deep-equality against the whole stored object. A user may well have
 * added `disabledTools` or `env` of their own to cempala's entry, and
 * rewriting the file to strip those — reporting "updated" as if it were
 * an improvement — would be us discarding their configuration. We care
 * only that the fields we own say what they should.
 */
function entryMatches(existing: unknown, binaryPath: string): boolean {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return false;
  const e = existing as Record<string, unknown>;
  return e.command === binaryPath;
}

export function registerWithAntigravity(opts: RegisterOptions): RegisterOutcome {
  const path = opts.configPath ?? ANTIGRAVITY_MCP_CONFIG_PATH;
  const entry = entryFor(opts.binaryPath);
  const snippet = JSON.stringify({ mcpServers: { [SERVER_KEY]: entry } }, null, 2);

  // --- No file yet: create the whole thing. ---
  if (!existsSync(path)) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${snippet}\n`, "utf-8");
      return { kind: "created", path };
    } catch (err) {
      return { kind: "manual", path, reason: `could not create the file (${errMsg(err)})`, snippet };
    }
  }

  // --- A file exists. Read it before deciding anything. ---
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    return { kind: "manual", path, reason: `could not read the file (${errMsg(err)})`, snippet };
  }

  // An empty (or whitespace-only) file is not a config anyone wrote; a
  // half-finished download or a `touch` leaves one. Treat it as absent
  // rather than as unparseable, so the common case still registers.
  let parsed: unknown = {};
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      // This is the case the whole "manual" branch exists for. A config
      // we cannot parse is one we cannot safely rewrite: the user may
      // have a comment, a trailing comma, or an edit in progress, and
      // replacing it with our own two lines would destroy however many
      // other servers they had registered.
      return {
        kind: "manual",
        path,
        reason: `the existing file is not valid JSON (${errMsg(err)}); it was left untouched`,
        snippet,
      };
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      kind: "manual",
      path,
      reason: "the existing file is valid JSON but not an object; it was left untouched",
      snippet,
    };
  }

  const root = parsed as Record<string, unknown>;
  const servers = root.mcpServers;
  if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
    return {
      kind: "manual",
      path,
      reason: "the existing file has an `mcpServers` key that is not an object; it was left untouched",
      snippet,
    };
  }

  const existingServers = (servers ?? {}) as Record<string, unknown>;
  if (entryMatches(existingServers[SERVER_KEY], opts.binaryPath)) {
    return { kind: "unchanged", path };
  }

  // Preserve every other key, at both levels: other servers, and any
  // top-level settings Antigravity may keep alongside `mcpServers`.
  const next: Record<string, unknown> = {
    ...root,
    mcpServers: { ...existingServers, [SERVER_KEY]: { ...(asObject(existingServers[SERVER_KEY]) ?? {}), ...entry } },
  };

  try {
    writeBackPreservingLinks(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch (err) {
    return { kind: "manual", path, reason: `could not write the file (${errMsg(err)})`, snippet };
  }
  return { kind: "updated", path };
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Replace a file's contents in place, keeping a backup for the duration of
 * the write.
 *
 * Deliberately NOT the usual write-temp-then-rename. A dotfile like this is
 * very often a symlink into a dotfiles repo, and renaming over it replaces
 * the link with a regular file — quietly detaching it from the repo the
 * user manages it in. Writing through the path preserves the link. This is
 * the same trade install.sh makes for shell rc files, and for the same
 * reason: the lost atomicity costs someone only if they are editing this
 * exact file during a window a few milliseconds wide, while the broken
 * symlink would cost them every upgrade.
 *
 * The backup covers the gap between truncating and finishing, so an
 * interrupted write does not leave a half-written config behind.
 */
function writeBackPreservingLinks(path: string, contents: string): void {
  const backup = join(dirname(path), `.${basenameOf(path)}.cempala-bak`);
  let haveBackup = false;
  try {
    copyFileSync(path, backup);
    haveBackup = true;
  } catch {
    // No backup possible (a read-only directory, say). The write below
    // may still succeed; if it does not, it throws and the caller reports
    // `manual` — the file is no worse off than before either way.
  }
  try {
    writeFileSync(path, contents, "utf-8");
  } catch (err) {
    if (haveBackup) {
      try { copyFileSync(backup, path); } catch { /* nothing further we can do */ }
    }
    throw err;
  } finally {
    if (haveBackup) {
      try { unlinkSync(backup); } catch { /* best effort */ }
    }
  }
}

function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || "mcp_config.json";
}

/**
 * Human-readable lines for the installer to print. Kept here so install.sh
 * and install.ps1 print the same thing without either one restating the
 * outcomes.
 */
export function describeOutcome(o: RegisterOutcome): string[] {
  switch (o.kind) {
    case "created":
      return [`  ✓ registered cempala in ${o.path}`];
    case "updated":
      return [`  ✓ registered cempala in ${o.path} (existing servers preserved)`];
    case "unchanged":
      return [`  ✓ cempala already registered in ${o.path}`];
    case "manual":
      return [
        `  ! could not register cempala automatically: ${o.reason}`,
        `    Add this to ${o.path} yourself:`,
        ...o.snippet.split("\n").map((l) => `      ${l}`),
      ];
  }
}
