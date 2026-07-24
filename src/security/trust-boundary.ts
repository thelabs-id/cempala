// src/security/trust-boundary.ts
//
// The ONLY place that decides `allowed` vs `needs_approval` vs `denied` for
// a `cwd`. Tool handlers consume its verdict; they never re-derive it.
// (AGENTS.md §5, FR-10–FR-11c.)
//
// Order of evaluation (REQUIREMENTS.md §5):
//   1. Denylist hit → denied (wins over everything, including an approved root).
//      Resolving symlinks before matching is what stops a symlink inside an
//      approved directory from pointing at ~/.ssh and escaping the check.
//   2. Inside an approved_paths root → allowed.
//   3. Inside home_root → allowed.
//   4. Otherwise → needs_approval.

import { homedir } from "node:os";
import { canonicalize, isInside } from "./paths.ts";
import { effectivePathDenylist, matchPathDenylist } from "./denylist.ts";

export type TrustVerdict =
  | { kind: "allowed"; reason: "home" | "approved"; root: string }
  | { kind: "needs_approval"; path: string }
  | { kind: "denied"; reason: "denylist"; root: string };

export interface TrustBoundaryInput {
  /** The cwd to evaluate. Will be canonicalized. */
  cwd: string;
  /** Effective denylist = baseline ∪ config entries. */
  pathDenylist: string[];
  /** Approved roots from the `approved_paths` table. */
  approvedRoots: string[];
  /** Home root. Resolved at call time, not from config directly. */
  homeRoot?: string;
}

/**
 * Decide what to do with a cwd. Pure function — no I/O.
 */
export function evaluateTrustBoundary(input: TrustBoundaryInput): TrustVerdict {
  const home = canonicalize(input.homeRoot ?? homedir());
  const cwdCanonical = canonicalize(input.cwd);

  // 1. Denylist first (resolving symlinks before matching).
  const denylistHit = matchPathDenylist(cwdCanonical, input.pathDenylist);
  if (denylistHit) {
    return { kind: "denied", reason: "denylist", root: denylistHit };
  }

  // 2. Approved roots.
  for (const root of input.approvedRoots) {
    const cRoot = canonicalize(root);
    if (isInside(cwdCanonical, cRoot)) {
      return { kind: "allowed", reason: "approved", root: cRoot };
    }
  }

  // 3. Home root.
  if (isInside(cwdCanonical, home)) {
    return { kind: "allowed", reason: "home", root: home };
  }

  // 4. Anything else.
  return { kind: "needs_approval", path: cwdCanonical };
}

/**
 * FR-7a: validate that a path can be approved. Even with explicit user
 * consent, a denylisted path is never persisted.
 */
export function canApprove(path: string, pathDenylist: string[]): { ok: true; canonical: string } | { ok: false; reason: "denylist"; root: string } {
  const canonical = canonicalize(path);
  const denylistHit = matchPathDenylist(canonical, pathDenylist);
  if (denylistHit) {
    return { ok: false, reason: "denylist", root: denylistHit };
  }
  return { ok: true, canonical };
}
