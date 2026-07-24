// src/tools/claim-task.ts
//
// FR-4: claim a task. Sets status=claimed, assigned_to=agent_id, claimed_at=now
// — only when the task's current status is `pending`. Fails with a
// structured error if it's already claimed, or if it's in any terminal
// state. (Those are outcomes, not something a second call should overwrite.)

import type { DB } from "../db/client.ts";
import type { Result } from "./send-message.ts";
import { ensureAgent } from "./send-message.ts";

export interface ClaimTaskInput {
  task_id: string;
  agent_id: string;
}

export interface ClaimTaskOutput {
  task_id: string;
  status: "claimed";
  assigned_to: string;
  claimed_at: number;
}

export function claimTask(db: DB, input: ClaimTaskInput): Result<ClaimTaskOutput> {
  if (!input.task_id || !input.agent_id) {
    return { ok: false, error: "task_id and agent_id are required", code: "invalid_input" };
  }
  const row = db.get<{ id: string; status: string }>(`SELECT id, status FROM tasks WHERE id = ?`, [input.task_id]);
  if (!row) {
    return { ok: false, error: `task ${input.task_id} not found`, code: "not_found" };
  }
  if (row.status !== "pending") {
    return {
      ok: false,
      error: `task ${input.task_id} is in status '${row.status}' and cannot be claimed`,
      code: "invalid_state",
    };
  }
  const now = Date.now();
  // Pre-seed the agent so the FK is always valid.
  ensureAgent(db, input.agent_id);
  const r = db.run(
    `UPDATE tasks SET status = 'claimed', assigned_to = ?, claimed_at = ?
      WHERE id = ? AND status = 'pending'`,
    [input.agent_id, now, input.task_id],
  );
  if (r.changes === 0) {
    // Lost a race with another claimer.
    const fresh = db.get<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [input.task_id]);
    return {
      ok: false,
      error: `task ${input.task_id} is in status '${fresh?.status ?? "unknown"}' and cannot be claimed`,
      code: "invalid_state",
    };
  }
  return { ok: true, data: { task_id: input.task_id, status: "claimed", assigned_to: input.agent_id, claimed_at: now } };
}

// ensureAgent is imported from send-message.ts.
