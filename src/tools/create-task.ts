// src/tools/create-task.ts
//
// FR-3: create a task row immediately, then validate `cwd` against the
// trust boundary (FR-10–FR-11c).
//
// Outcomes (REQUIREMENTS.md §6):
//   - denylist hit    → status = rejected, ok: false, code "denied"
//   - outside home and not approved → status = needs_approval, ok: true
//   - inside home or inside approved root → status = pending, ok: true
//
// Every outcome is a recorded row, not just the successful ones — that's
// what makes G2's audit trail cover denials and escalations, not only
// completed work.

import type { DB } from "../db/client.ts";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.ts";
import { evaluateTrustBoundary } from "../security/trust-boundary.ts";
import { effectivePathDenylist } from "../security/denylist.ts";
import { canonicalize } from "../security/paths.ts";
import type { Result } from "./send-message.ts";
import { ensureAgent } from "./send-message.ts";

export interface CreateTaskInput {
  description: string;
  created_by: string;
  assigned_to?: string | null;
  cwd: string;
}

export type CreateTaskOutput =
  | { status: "pending"; task_id: string; cwd: string }
  // `reason` distinguishes "approve this path" from "narrow the cwd"
  // — see the matching comment on DispatchOutput.
  | { status: "needs_approval"; path: string; task_id: string; reason: "outside_home" | "ancestor_of_denylist" };

export function createTask(
  db: DB,
  cfg: AppConfig,
  input: CreateTaskInput,
): Result<CreateTaskOutput> {
  if (!input.description || !input.created_by || !input.cwd) {
    return { ok: false, error: "description, created_by, and cwd are required", code: "invalid_input" };
  }
  // Runtime type checks (P1 fix). The schema advertises
  // `["string", "null"]` for `assigned_to` but the MCP wire format
  // doesn't enforce it. A wrong type passed to `ensureAgent` would
  // either be a no-op (number `0`, boolean `false`) or get coerced
  // into a string in a misleading way (`[object Object]`).
  //
  // Empty string is also rejected (P1 fix): the truthy check on
  // `if (input.assigned_to)` would skip `ensureAgent("")` and the FK
  // insert would then fail with FOREIGN KEY constraint. The user
  // gets a clearer error here than a raw SQL exception.
  if (input.assigned_to !== undefined && input.assigned_to !== null) {
    if (typeof input.assigned_to !== "string" || input.assigned_to.length === 0) {
      return {
        ok: false,
        error: `assigned_to must be a non-empty string or null (got ${JSON.stringify(input.assigned_to)})`,
        code: "invalid_input",
      };
    }
  }
  if (typeof input.description !== "string" || typeof input.created_by !== "string" || typeof input.cwd !== "string") {
    return {
      ok: false,
      error: `description, created_by, and cwd must all be strings`,
      code: "invalid_input",
    };
  }
  if (input.created_by.length === 0) {
    return { ok: false, error: "created_by must be a non-empty string", code: "invalid_input" };
  }
  // Pre-seed agents so created_by / assigned_to are always FK-valid.
  ensureAgent(db, input.created_by);
  if (input.assigned_to) ensureAgent(db, input.assigned_to);

  const id = randomUUID();
  const createdAt = Date.now();

  // Insert the row first, in 'pending' status, then re-classify based on
  // the trust boundary verdict. This way every outcome — including denials
  // and escalations — is in the table for the audit trail. We persist
  // the CANONICAL cwd (post-tilde-expansion, post-symlink-resolution)
  // so audit queries that read tasks.cwd see the validated location —
  // not whatever relative path the caller happened to type.
  const validatedCwd = canonicalize(input.cwd);
  db.run(
    `INSERT INTO tasks(id, description, created_by, assigned_to, cwd, status, via, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 'mailbox', ?)`,
    [id, input.description, input.created_by, input.assigned_to ?? null, validatedCwd, createdAt],
  );

  const pathDenylist = effectivePathDenylist(cfg.trust.denylist);
  const approvedRoots = db.all<{ path: string }>(`SELECT path FROM approved_paths`).map((r) => r.path);
  const verdict = evaluateTrustBoundary({
    cwd: input.cwd,
    pathDenylist,
    approvedRoots,
    homeRoot: cfg.trust.home_root,
  });

  if (verdict.kind === "denied") {
    db.run(
      `UPDATE tasks SET status = 'rejected', result = ? WHERE id = ?`,
      [`denied by denylist: ${verdict.root}`, id],
    );
    // FR-9: denylist hits are real rejections, not successes. Task row
    // is recorded for the audit trail (G2), but the outer result is
    // ok: false so the calling agent treats it as an error.
    return {
      ok: false,
      error: `cwd is on the denylist (${verdict.root}); task rejected`,
      code: "denylist",
    };
  }
  if (verdict.kind === "needs_approval") {
    db.run(
      `UPDATE tasks SET status = 'needs_approval' WHERE id = ?`,
      [id],
    );
    return {
      ok: true,
      // Pass through the verdict's reason so the caller can tell
      // "approve this path" from "narrow the cwd".
      data: { status: "needs_approval", path: validatedCwd, task_id: id, reason: verdict.reason },
    };
  }
  // verdict.kind === "allowed" — stays pending, possibly auto-assigned.
  return { ok: true, data: { status: "pending", task_id: id, cwd: canonicalize(input.cwd) } };
}

// ensureAgent is imported from send-message.ts.
