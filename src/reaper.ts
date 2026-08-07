// src/reaper.ts
//
// FR-17: a background reaper that checks any `running` task older than
// 30 minutes with a dead PID and marks it `failed` with
// result = "process exited without a recorded result — check output_file".
//
// Implementation note: the reaper is piggybacked on
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
import { assessTask, ACTIVITY_GRACE_MS } from "./tools/task-liveness.ts";

// FR-17's 30-minute window. Derived from the liveness module's activity grace
// rather than restated, so the age cutoff here and the "has it gone quiet"
// judgement there cannot drift apart into disagreeing about the same task.
const STALE_AFTER_MS = ACTIVITY_GRACE_MS;
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
    pid_is_agent: number | null;
    started_at: number | null;
    output_file: string | null;
  }>(
    `SELECT id, status, pid, pid_is_agent, started_at, output_file
       FROM tasks
      WHERE status = 'running'
        AND (started_at IS NULL OR started_at <= ?)`,
    [cutoff],
  );

  const details: SweepResult["details"] = [];
  for (const r of rows) {
    // Same liveness policy as check_task (tools/task-liveness.ts): a dead
    // recorded pid is not on its own evidence that the task failed, because
    // on Windows that pid is a shim the real agent outlives.
    const liveness = assessTask({
      pid: r.pid,
      pidIsAgent: r.pid_is_agent === 1,
      outputFile: r.output_file,
      now,
    });
    if (liveness.state === "running") continue;

    // A finished run keeps its real outcome. The sweep exists to stop rows
    // sitting at `running` forever — not to overwrite a success with a
    // failure, which is what blanket-failing every swept row used to do.
    const status = liveness.state === "finished" && liveness.exitCode === 0 ? "completed" : "failed";
    const result =
      liveness.state === "finished" && liveness.resultText ? liveness.resultText : STALE_RESULT;
    // Persist the exit code too, so a swept row is indistinguishable from one
    // reconciled by dispatch or check_task. Leaving it NULL made swept rows a
    // second-class shape for the G2 audit trail. -1 is the same "died without
    // a verdict" sentinel those two paths use.
    const exitCode = liveness.state === "finished" ? liveness.exitCode : -1;

    db.run(
      `UPDATE tasks
          SET status = ?,
              result = ?,
              exit_code = ?,
              completed_at = ?
        WHERE id = ? AND status = 'running'`,
      [status, result, exitCode, now, r.id],
    );
    details.push({ task_id: r.id, old_status: r.status });
  }
  return { swept: details.length, details };
}
