// src/tools/approve-path.ts
//
// FR-7a: called after a human has confirmed, in the same conversation,
// that a path outside the home directory may be used. Validates against
// the denylist (FR-11a) first — a denylisted path can never be approved,
// even by explicit request. On success, upserts a row into approved_paths.
// Idempotent: approving an already-approved path is a no-op success.

import type { DB } from "../db/client.ts";
import type { AppConfig } from "../config.ts";
import { canApprove } from "../security/trust-boundary.ts";
import { effectivePathDenylist } from "../security/denylist.ts";
import type { Result } from "./send-message.ts";
import { ensureAgent } from "./send-message.ts";

export interface ApprovePathInput {
  agent_id: string;
  path: string;
}

export type ApprovePathOutput =
  | { ok: true; path: string; already_approved: boolean }
  | { ok: false; error: string; code: "denylist"; path: string; root: string }
  | { ok: false; error: string; code: "denylist"; path: string; root: string; reason: "contains_denylist" };

/**
 * Result discriminated union: outer ok is the tool call's success/failure,
 * inner `data.ok` is the application's success flag for the approval.
 */
export function approvePath(
  db: DB,
  cfg: AppConfig,
  input: ApprovePathInput,
): Result<ApprovePathOutput> {
  if (!input.agent_id || !input.path) {
    return { ok: false, error: "agent_id and path are required", code: "invalid_input" };
  }
  ensureAgent(db, input.agent_id);

  const pathDenylist = effectivePathDenylist(cfg.trust.denylist);
  const verdict = canApprove(input.path, pathDenylist);
  if (!verdict.ok) {
    // FR-11c: a denylisted path can never be approved, even by explicit request.
    // Two cases: (1) the path itself is on the denylist, (2) the path
    // contains a denylist root as a subpath. The second would let a
    // future dispatch with a broad cwd undermine the denylist, so we
    // refuse it at approval time. Both surface as the same MCP error
    // code ("denylist") — the caller's policy is the same: pick a
    // narrower path. The internal `reason` is for tests / debugging.
    if (verdict.reason === "contains_denylist") {
      return {
        ok: false,
        error: `path contains a denylist root (${verdict.root}); narrow the path to a subdirectory that is not on the denylist`,
        code: "denylist",
      };
    }
    return {
      ok: false,
      error: `path is on the denylist (${verdict.root}); cannot be approved`,
      code: "denylist",
    };
  }

  // Atomic upsert: in the two-writer SQLite setup, two concurrent
  // approve_path calls for the same new path would otherwise both pass
  // the SELECT, then race on the INSERT and one would fail on the
  // primary-key constraint. INSERT OR IGNORE makes the second a no-op;
  // combined with `changes`, we can still tell which call did the
  // actual write. FR-7a/FR-22 require approval to be idempotent.
  const now = Date.now();
  const r = db.run(
    `INSERT OR IGNORE INTO approved_paths(path, approved_by, approved_at) VALUES (?, ?, ?)`,
    [verdict.canonical, input.agent_id, now],
  );
  // r.changes is 1 when this call did the write, 0 when the path was
  // already approved (by us, a previous call, or a sibling server).
  return { ok: true, data: { ok: true, path: verdict.canonical, already_approved: r.changes === 0 } };
}

// ensureAgent is imported from send-message.ts so all tools share one
// atomic implementation.
