// src/security/denylist.ts
//
// Two distinct denylists, both extending compile-time baselines that cannot
// be weakened by config edits (REQUIREMENTS.md §7 "Config denylists are
// additive, never authoritative"; AGENTS.md §10 "Don't shrink the baseline
// denylist").
//
//   1. Path denylist (FR-11a): roots that are *always* blocked, even
//      though they sit under the home directory. Matching is by containment
//      (see security/paths.ts). Baseline is per-OS.
//
//   2. Prompt denylist (FR-12): high-risk patterns scanned in the prompt
//      text. Baseline is a fixed set of patterns. A "best-effort pre-filter"
//      that does not promise to catch every way of expressing a malicious
//      prompt — the structural sandbox is what enforces scope; this just
//      rejects obviously malicious prompts cheaply.

import { homedir } from "node:os";
import { platform } from "node:process";
import { join, normalize, isAbsolute } from "node:path";
import { isInside, canonicalize } from "./paths.ts";

/** Per-OS path baseline, relative to homedir() unless noted. */
const PATH_BASELINE_RELATIVE: Record<string, string[]> = {
  darwin: [
    ".ssh",
    ".aws",
    ".gnupg",
    ".docker",
    ".config/gh",
    ".kube",
    ".npmrc",
    ".netrc",
    "Library/Keychains",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Firefox/Profiles",
    "Library/Application Support/BraveSoftware",
    "Library/Application Support/Microsoft Edge",
  ],
  linux: [
    ".ssh",
    ".aws",
    ".gnupg",
    ".docker",
    ".config/gh",
    ".kube",
    ".npmrc",
    ".netrc",
    ".config/google-chrome",
    ".config/chromium",
    ".config/BraveSoftware",
    ".config/microsoft-edge",
    ".mozilla/firefox",
    ".local/share/keyrings",
  ],
  win32: [
    ".ssh",
    ".aws",
    ".gnupg",
    ".docker",
    ".config/gh",
    ".kube",
    ".npmrc",
    ".netrc",
    "AppData/Local/Google/Chrome/User Data",
    "AppData/Local/Microsoft/Edge/User Data",
    "AppData/Local/BraveSoftware",
    "AppData/Roaming/Mozilla/Firefox/Profiles",
    "AppData/Local/Microsoft/Credentials",
    "AppData/Roaming/Microsoft/Credentials",
  ],
};

/**
 * Build the absolute path baseline for the current OS, anchored at
 * homedir() per the spec ("all relative to os.homedir() unless noted").
 */
export function pathBaseline(): string[] {
  const rels = PATH_BASELINE_RELATIVE[platform] ?? PATH_BASELINE_RELATIVE.linux!;
  return rels.map((r) => normalize(join(homedir(), r)));
}

/**
 * Merge the compiled baseline with the user's config-supplied list. Config
 * can only *add* entries; it can never weaken the baseline.
 */
export function effectivePathDenylist(configEntries: string[]): string[] {
  return [...pathBaseline(), ...configEntries.map((e) => normalizeConfigPath(e))];
}

/** Prompt pattern baseline (FR-12). */
export const PROMPT_PATTERN_BASELINE: RegExp[] = [
  /\brm\s+-rf\b/,
  /\bsudo\s+/,
  /\bcurl\b[^\n]*\|\s*(sh|bash)\b/,
  /\bgit\s+push\s+--force\b/,
  /\bchmod\s+-R\s+777\b/,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
  // Writes to denylisted roots — text-level match. The structural check
  // is in the trust boundary; this is a prompt-text sniff. We cover
  // both POSIX (`/`) and Windows (`\`) path separators because the
  // project explicitly supports Windows (FR-12 covers writes to
  // `~/.ssh`, `~/.aws`, `.env*` outside the target cwd).
  //
  // Both `~/` (home-relative) and absolute paths are matched. Without
  // the absolute-path variants, a prompt that names the sensitive root
  // by its full path (e.g. `C:\Users\me\.ssh\authorized_keys` or
  // `/home/me/.ssh/authorized_keys`) bypasses the denylist even though
  // `cwd` is an allowed parent — the agent could still write to the
  // sensitive path via shell. The absolute patterns require the
  // separator before `.ssh`/`.aws` so a name like `/home/me.foo`
  // doesn't match (the dot in `me.foo` doesn't anchor a path component).
  //
  // Spaces in path components are allowed (P2 fix): home/profile
  // directories can contain spaces (`/Users/Jane Doe/.ssh/...`), and
  // the pattern must still match. We permit single spaces inside
  // path components.
  /~[\/\\]\.ssh\b/,
  /~[\/\\]\.aws\b/,
  // Absolute POSIX: at least one segment, separator, then .ssh/.aws.
  // Each segment allows word chars and a single space (for "Jane Doe").
  /(?:\/(?:[\w.-]|\ [\w.-])+){2,}\/\.ssh\b/,
  /[A-Za-z]:(?:[\\\/](?:[\w.-]|\ [\w.-])+){2,}[\\\/]\.ssh\b/,
  /(?:\/(?:[\w.-]|\ [\w.-])+){2,}\/\.aws\b/,
  /[A-Za-z]:(?:[\\\/](?:[\w.-]|\ [\w.-])+){2,}[\\\/]\.aws\b/,
  // Writes to .env* outside the task's own cwd. FR-12's explicit list
  // includes "writes to ... .env* outside the target cwd"; the structural
  // path check in trust-boundary only fires for absolute paths the
  // user typed, so a prompt that says "append TOKEN to ../.env" needs
  // this text-level match to be caught cheaply. Both separators.
  //
  // The `[-\w.]*` allows trailing characters that are still part of
  // the filename (`.env.production`, `.envrc`, `.envproduction`) so
  // the pattern matches the documented `.env*` (any file starting
  // with `.env`), not just the literal `.env`.
  //
  // These patterns only catch `..` and `~` forms — both unambiguous
  // "outside cwd" indicators. Absolute-path `.env*` is handled
  // separately in `matchAbsolutePathDenylist` (P2 fix): we have
  // the cwd in hand there, so we can compare absolute paths in the
  // prompt against the cwd and reject only the out-of-cwd ones,
  // avoiding false positives on legitimate in-cwd references like
  // `/home/me/app/.env.example`.
  /(?:^|[\s"'`])\.\.[\/\\][^\s"'`]*\.env[-\w.]*/,
  /(?:^|[\s"'`])~[\/\\][^\s"'`]*\.env[-\w.]*/,
];

/** Convert a config-time `~/`-style path to absolute. */
function normalizeConfigPath(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return normalize(join(homedir(), p.replace(/^~/, "")));
  }
  if (isAbsolute(p)) return normalize(p);
  return normalize(join(homedir(), p));
}

/**
 * Test whether a cwd is covered by the effective path denylist. Returns
 * the matching denylisted root if so, or null if the path is allowed.
 */
export function matchPathDenylist(
  cwd: string,
  effective: string[],
): string | null {
  for (const root of effective) {
    if (isInside(cwd, root)) return root;
  }
  return null;
}

/**
 * Test whether a prompt text matches any baseline-or-config prompt
 * denylist pattern. Returns the first matching pattern (as a string) or null.
 *
 * Baseline patterns are real RegExps. Config-supplied patterns are
 * treated as plain substrings — not regex. Otherwise the documented
 * default `curl | sh` would be parsed as the alternation `curl OR sh`
 * and match any prompt containing "sh" ("please show me files", "run
 * shell command", etc.), which breaks the zero-config path for benign
 * prompts. Users who genuinely want regex can write it in the baseline
 * by editing src/security/denylist.ts; the config file is for adding
 * plain substring extensions.
 */
export function matchPromptDenylist(
  prompt: string,
  configPatterns: string[],
): string | null {
  for (const re of PROMPT_PATTERN_BASELINE) {
    if (re.test(prompt)) return re.source;
  }
  for (const pat of configPatterns) {
    if (typeof pat !== "string" || pat.length === 0) continue;
    if (prompt.includes(pat)) return pat;
  }
  return null;
}

/**
 * Regex that pulls a POSIX absolute path out of a prompt. Used on
 * POSIX only. Stops at the first whitespace or shell delimiter
 * AFTER the path's start. We do NOT try to handle paths with
 * spaces (e.g. `/Users/Jane Doe/...`) — the regex would either
 * truncate at the space (missing the .env*) or include trailing
 * prose. The structural trust-boundary check covers that case at
 * a different layer; this text-level check catches the common
 * no-space form which is by far the most frequent.
 */
const POSIX_ABS_PATH_RE = /(?:^|[\s"'`(,;])(\/[^\s"'`<>|*?,;]+)+/g;
/**
 * Regex that pulls a Windows absolute path out of a prompt. Used on
 * Windows only. Same rationale.
 */
const WIN_ABS_PATH_RE = /(?:^|[\s"'`(,;])([A-Za-z]:[\\\/][^\s"'`<>|*?,;]+(?:[\\\/][^\s"'`<>|*?,;]+)*)/g;

/**
 * Cwd-aware prompt denylist check for absolute paths.
 *
 * `matchPromptDenylist` only catches `~`-relative and `..` forms for
 * `.env*` writes — both unambiguous "outside cwd" indicators. An
 * absolute path like `/home/me/other/.env.production` could be either
 * inside or outside the task cwd, and the substring check can't tell.
 * With the cwd in hand, we extract absolute paths from the prompt
 * and reject any that (a) end in `.env*` AND (b) are not under cwd.
 *
 * Platform-aware: we only look for absolute paths in the OS's
 * syntax. On Windows, a `/home/me/...` token is not a real path —
 * trying to canonicalize it would re-root it under homedir and
 * accidentally classify an out-of-cwd attack as in-cwd. The
 * platform-scoping keeps the check honest.
 *
 * The .ssh/.aws absolute-path patterns live in PROMPT_PATTERN_BASELINE
 * because those roots are *always* outside any allowed cwd (the trust
 * boundary already denies them at the cwd level; the prompt check is
 * a cheap pre-filter). Only `.env*` is sensitive to in-cwd vs
 * out-of-cwd, because `.env.example` is a legitimate file to read
 * from inside the task's project.
 */
export function matchAbsolutePathDenylist(prompt: string, cwd: string): string | null {
  const cwdCanon = canonicalize(cwd);
  const re = process.platform === "win32" ? WIN_ABS_PATH_RE : POSIX_ABS_PATH_RE;
  for (const m of prompt.matchAll(re)) {
    const raw = m[1]!;
    let candidate: string;
    try {
      candidate = canonicalize(raw);
    } catch {
      continue;
    }
    // Only consider .env* targets.
    if (!/\.env[-\w.]*$/i.test(candidate)) continue;
    // In-cwd: legitimate (e.g. `/home/me/app/.env.example`).
    if (isInside(candidate, cwdCanon)) continue;
    // Out-of-cwd .env*: rejected.
    return raw;
  }
  return null;
}
