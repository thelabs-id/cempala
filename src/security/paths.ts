// src/security/paths.ts
//
// The ONLY path comparator. Every path comparison in the codebase — trust
// boundary, denylist, approved-root lookup — goes through this file.
// One canonicalization routine, in security/paths.ts, used by everything.
//
// Two things go wrong the moment someone hand-rolls a second comparison:
//   1. A bare startsWith matches `D:\clients\acme2` against `D:\clients\acme`.
//   2. Skipping realpath lets a symlink inside an approved directory point
//      at `~/.ssh` and escape the check. AC-12 covers this exact case.

import { realpathSync, existsSync, statSync } from "node:fs";
import { isAbsolute, sep, normalize, dirname } from "node:path";
import { platform } from "node:process";
import { ensureAbsolute, expandHome } from "../platform/paths.ts";

/**
 * Canonical form of a path:
 *   1. expand leading `~` against os.homedir() (so `~/.ssh` and
 *      `$HOME/.ssh` compare equal — without this, a caller passing the
 *      documented AC-3 example `cwd: "~/.ssh"` ends up at
 *      `<cwd>/~/.ssh` after ensureAbsolute, which the trust boundary
 *      then fails to match against the `.ssh` denylist root.)
 *   2. absolute (no leading `~`)
 *   3. symlink-resolved (realpath)
 *   4. `.`/`..` collapsed (normalize)
 *   5. separators normalized to platform's
 *   6. on Windows only: case-folded and drive-letter uppercased
 *
 * For paths that do not exist yet, canonicalize against the nearest existing
 * ancestor and append the unresolved tail. This is the documented fallback
 * for "not-yet-created" paths; the spec says an approved root can be a path
 * that does not exist yet.
 */
export function canonicalize(p: string): string {
  if (!p) return p;
  let abs = expandHome(p);
  abs = ensureAbsolute(abs);
  abs = normalize(abs);

  // Walk up until we find a real path; canonicalize the prefix and tack
  // the unresolved tail back on. Avoids realpathSync throwing for not-yet-
  // existing files.
  let head = abs;
  let tail: string[] = [];
  while (head !== "/" && head !== "." && !exists(head)) {
    const parent = dirname(head);
    if (parent === head) break; // reached root
    tail.unshift(basenamePrivate(head));
    head = parent;
  }

  let resolved: string;
  if (exists(head)) {
    try {
      resolved = realpathSync(head);
    } catch {
      resolved = normalize(head);
    }
  } else {
    resolved = normalize(head);
  }
  if (tail.length > 0) resolved = joinPrivate(resolved, ...tail);
  resolved = normalize(resolved);

  if (platform === "win32") {
    // Windows-only: case-fold, drive-letter uppercase. Posix stays
    // case-sensitive (AC-12 is the unix-friendly path comparison test).
    resolved = resolved.toLowerCase();
    // Drive letter: "c:\foo" -> "c:" uppercase
    if (/^[a-z]:[\\\/]/.test(resolved)) {
      resolved = resolved[0]!.toUpperCase() + resolved.slice(1);
    }
  }
  return resolved;
}

/**
 * Containment: `X` is inside root `Y` iff `X === Y` or `X` starts with
 * `Y + sep` (or `Y` itself, when `Y` already ends with a separator
 * like a filesystem root such as `D:\` or `/`). The trailing separator
 * is what makes this correct: without it, `D:\clients\acme2` would
 * match the root `D:\clients\acme`. AC-11 is the test that proves this.
 *
 * CRITICAL: only the platform's actual separator counts. On POSIX
 * `\` is a legal filename character (not a separator), so a path like
 * `/tmp/acme\evil` is a sibling of `/tmp/acme`, not a descendant.
 * Similarly on Windows, `/` is not a separator (we always normalize to
 * `\` on Windows in `canonicalize`). If we accepted both `\` and `/` on
 * POSIX, the cross-platform containment check would silently cover paths
 * that are not actually descendants on macOS/Linux.
 *
 * CRITICAL: when `Y` is already a filesystem root (ends with a
 * separator), the comparison is `cx === cy || cx.startsWith(cy)` —
 * appending another separator would yield `D:\\` or `//`, which no
 * path starts with, and the whole approval would silently fail.
 */
export function isInside(X: string, Y: string): boolean {
  const cx = canonicalize(X);
  const cy = canonicalize(Y);
  if (cx === cy) return true;
  if (cy.endsWith("/") || cy.endsWith("\\")) {
    return cx.startsWith(cy);
  }
  return cx.startsWith(cy + sep);
}

/**
 * Reverse containment: are X and Y the same canonical location, or are they
 * nested under each other? Used when we need to know "is X covered by Y?"
 * regardless of which is the parent. (Not currently used; included for
 * symmetry / future callers.)
 */
export function isSameOrUnder(X: string, Y: string): boolean {
  return isInside(X, Y) || isInside(Y, X);
}

/**
 * Strict ancestor: `Y` is a strict descendant of `X` — i.e. `Y` is inside
 * `X`, but `X ≠ Y`. Used to detect "X is a broad scope that contains a
 * sensitive subpath". The strictness matters: a cwd that IS a denylist
 * root is caught by the containment check (returns `denied`); this helper
 * is for cwds that CONTAIN a denylist root as a subpath, which containment
 * alone misses (a bare `isInside(denylist, cwd)` would return true, but
 * `isInside(denylist, denylist)` would also return true — collapsing two
 * different cases into one).
 */
export function isStrictAncestorOf(X: string, Y: string): boolean {
  const cx = canonicalize(X);
  const cy = canonicalize(Y);
  if (cx === cy) return false; // not strict
  return isInside(cy, cx);
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return existsSync(p);
  }
}

// Local re-exports of node:path helpers so callers don't have to import both.
import { basename as basenamePrivate, join as joinPrivate } from "node:path";
