// src/reaper.ts
//
// FR-17: a background reaper that checks any `running` task older than
// 30 minutes with a dead PID and marks it `failed` with
// result = "process exited without a recorded result — check output_file".
//
// Implementation note (REQUIREMENTS.md §8): the reaper is piggybacked on
// tool calls rather than timer-driven. Each tool call invokes `maybeSweep()`
// before returning. That bounds the guarantee: a stale row is cleared on
// the next tool call after it goes stale, not at the 30-minute mark itself.
// If the server sits idle for a week, a stale row stays `running` for that
// week. Acceptable — with no tool calls happening, nobody is reading the row.
//
// AC-6 verifies the reaper by issuing an *unrelated* tool call (e.g.
// send_message) and then reading the row directly from SQLite. If the
// sweep only ran inside check_task, AC-6 would pass even with no reaper
// at all (FR-7 reconciles that one task on its own).

import type { DB } from "./db/client.ts";
import { isAlive } from "./platform/spawn.ts";

const STALE_AFTER_MS = 30 * 60 * 1000; // 30 minutes
const STALE_RESULT =
  "process exited without a recorded result — check output_file";

export interface SweepResult {
  swept: number;
  details: Array<{ task_id: string; old_status: string }>;
}

/**
 * Sweep stale running tasks. Returns the number of tasks reconciled.
 * Exported for the unit test in test/unit/reaper.test.ts.
 */
export function sweepStaleTasks(db: DB, now: number = Date.now()): SweepResult {
  const cutoff = now - STALE_AFTER_MS;
  const rows = db.all<{
    id: string;
    status: string;
    pid: number | null;
    started_at: number | null;
  }>(
    `SELECT id, status, pid, started_at
       FROM tasks
      WHERE status = 'running'
        AND (started_at IS NULL OR started_at <= ?)`,
    [cutoff],
  );

  const details: SweepResult["details"] = [];
  for (const r of rows) {
    // If pid is null we cannot test liveness; treat as dead too (a row
    // that has been running > 30 min without a pid is definitely orphaned).
    const alive = r.pid !== null && isAlive(r.pid);
    if (alive) continue;
    db.run(
      `UPDATE tasks
          SET status = 'failed',
              result = ?,
              completed_at = ?
        WHERE id = ? AND status = 'running'`,
      [STALE_RESULT, now, r.id],
    );
    details.push({ task_id: r.id, old_status: r.status });
  }
  return { swept: details.length, details };
}
