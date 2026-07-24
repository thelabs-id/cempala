// src/tools/complete-task.ts
//
// FR-5: complete a task. `status` ∈ {completed, failed}. Sets result,
// completed_at.
//
// `result` is REQUIRED per the spec (REQUIREMENTS.md §6 FR-5: "Sets result,
// completed_at"). A null/empty result is a real audit-trail gap — the
// caller knows what happened, and "I don't know" is itself information
// the row must record. We reject missing/empty results at the boundary
// rather than silently storing null.

import type { DB } from "../db/client.ts";
import type { Result } from "./send-message.ts";

export interface CompleteTaskInput {
  task_id: string;
  result: string;
  status: "completed" | "failed";
}

export interface CompleteTaskOutput {
  task_id: string;
  status: "completed" | "failed";
  completed_at: number;
}

export function completeTask(db: DB, input: CompleteTaskInput): Result<CompleteTaskOutput> {
  if (!input.task_id) {
    return { ok: false, error: "task_id is required", code: "invalid_input" };
  }
  if (input.status !== "completed" && input.status !== "failed") {
    return { ok: false, error: "status must be 'completed' or 'failed'", code: "invalid_input" };
  }
  if (typeof input.result !== "string" || input.result.length === 0) {
    // FR-5: result is required, not optional. Callers that don't have
    // anything to say should pass a description of the empty state
    // ("no output", "agent returned no message", etc.).
    return {
      ok: false,
      error: "result is required (use a non-empty string; 'no output' or similar is fine)",
      code: "invalid_input",
    };
  }
  const row = db.get<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [input.task_id]);
  if (!row) {
    return { ok: false, error: `task ${input.task_id} not found`, code: "not_found" };
  }
  // Only claimed/running tasks are completable. needs_approval, rejected, etc.
  // are terminal already; the call should fail rather than rewrite history.
  if (row.status !== "claimed" && row.status !== "running") {
    return {
      ok: false,
      error: `task ${input.task_id} is in status '${row.status}' and cannot be completed`,
      code: "invalid_state",
    };
  }
  const now = Date.now();
  // Only update when the row is still claimed OR running — this prevents
  // a second concurrent complete_task (or a reaper sweep, or a background
  // reconcile) from overwriting a task that already has a terminal
  // status. The state guard makes the update atomic with respect to
  // SQLite's single-writer-per-connection model; without it two
  // callers that both read "claimed" and then write "completed" would
  // clobber each other's result.
  const r = db.run(
    `UPDATE tasks SET status = ?, result = ?, completed_at = ?
       WHERE id = ? AND status IN ('claimed', 'running')`,
    [input.status, input.result, now, input.task_id],
  );
  if (r.changes === 0) {
    return {
      ok: false,
      error: `task ${input.task_id} is in status '${row.status}' and cannot be completed`,
      code: "invalid_state",
    };
  }
  return { ok: true, data: { task_id: input.task_id, status: input.status, completed_at: now } };
}
