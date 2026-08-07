// src/security/trust-boundary.ts
//
// The ONLY place that decides `allowed` vs `needs_approval` vs `denied` for
// a `cwd`. Tool handlers consume its verdict; they never re-derive it.
// (FR-10–FR-11c.)
//
// Order of evaluation:
//   1. Denylist hit → denied (wins over everything, including an approved root).
//      Resolving symlinks before matching is what stops a symlink inside an
//      approved directory from pointing at ~/.ssh and escaping the check.
//   2. cwd is a strict ancestor of a denylist root → needs_approval.
//      This catches `cwd=~` (or any broader scope) — the home check alone
//      would let it through, but the child would have scope to access
//      `~/.ssh` as a subpath. Forcing a `needs_approval` here means the
//      human gets to confirm the broad scope rather than silently
//      undermining the denylist. Symmetric check in `canApprove` so a
//      `approve_path("~")` is also rejected — there's no escalation path
//      that lets a denylist root become reachable.
//   3. Inside an approved_paths root → allowed.
//   4. Inside home_root → allowed.
//   5. Otherwise → needs_approval.

import { homedir } from "node:os";
import { canonicalize, isInside, isStrictAncestorOf } from "./paths.ts";
import { effectivePathDenylist, matchPathDenylist } from "./denylist.ts";

export type TrustVerdict =
  | { kind: "allowed"; reason: "home" | "approved"; root: string }
  | { kind: "needs_approval"; path: string; reason: "outside_home" | "ancestor_of_denylist" }
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

  // 2. cwd is a strict ancestor of a denylist root. The denylist is a
  //    floor — a cwd broad enough to contain a denylist subpath has
  //    implicit scope to access it via the child CLI's filesystem tools.
  //    We don't deny (the user might legitimately want to opt in to a
  //    broad scope) but we don't allow either: needs_approval is the
  //    documented pattern for "human, please confirm". The reason
  //    distinguishes this case from "outside home" so the calling
  //    agent can show a useful message ("this cwd contains ~/.ssh as
  //    a subpath; please narrow it" vs. "this cwd is outside your home
  //    directory").
  for (const root of input.pathDenylist) {
    if (isStrictAncestorOf(cwdCanonical, root)) {
      return { kind: "needs_approval", path: cwdCanonical, reason: "ancestor_of_denylist" };
    }
  }

  // 3. Approved roots.
  for (const root of input.approvedRoots) {
    const cRoot = canonicalize(root);
    if (isInside(cwdCanonical, cRoot)) {
      return { kind: "allowed", reason: "approved", root: cRoot };
    }
  }

  // 4. Home root.
  if (isInside(cwdCanonical, home)) {
    return { kind: "allowed", reason: "home", root: home };
  }

  // 5. Anything else.
  return { kind: "needs_approval", path: cwdCanonical, reason: "outside_home" };
}

/**
 * FR-7a: validate that a path can be approved. Even with explicit user
 * consent, a denylisted path is never persisted. The "ancestor of a
 * denylist root" check is the symmetric case: approving a broad scope
 * (e.g. `approve_path("~")`) would let dispatch later pick a cwd that
 * covers a denylist subpath, defeating the denylist's purpose. We
 * refuse such paths so the only escalation path is to approve a
 * specific narrow subdirectory.
 */
export function canApprove(
  path: string,
  pathDenylist: string[],
):
  | { ok: true; canonical: string }
  | { ok: false; reason: "denylist" | "contains_denylist"; root: string } {
  const canonical = canonicalize(path);
  const denylistHit = matchPathDenylist(canonical, pathDenylist);
  if (denylistHit) {
    return { ok: false, reason: "denylist", root: denylistHit };
  }
  for (const root of pathDenylist) {
    if (isStrictAncestorOf(canonical, root)) {
      return { ok: false, reason: "contains_denylist", root };
    }
  }
  return { ok: true, canonical };
}
