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

import { readFileSync } from "node:fs";
import type { DB } from "./db/client.ts";
import { assessTask, ACTIVITY_GRACE_MS } from "./tools/task-liveness.ts";
import { reconcileOutcome } from "./tools/agent-output.ts";

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
    // Settle on exactly the terms dispatch and check_task use: read stderr
    // on failure AND whenever the run came back with nothing to say, and
    // let an agent's own "I produced no output" statement overturn a zero
    // exit. Without this the sweep was the odd one out — a run whose only
    // explanation went to stderr (an auth error, or agy's headless
    // permission auto-denial, which exits 0 with an empty answer) was
    // swept to the canned STALE_RESULT while the other paths surfaced the
    // real reason. That contradicted the very parity the exit code below
    // is written to preserve.
    //
    // -1 for a run with no verdict is the same "died without saying so"
    // sentinel the other paths use.
    const reconciled = reconcileOutcome({
      resultText: liveness.state === "finished" ? liveness.resultText : "",
      exitCode: liveness.state === "finished" ? liveness.exitCode : -1,
      readStderr: () => readStderrSibling(r.output_file),
    });
    const status = reconciled.ok ? "completed" : "failed";
    // STALE_RESULT is the last resort, for a row where neither stream ever
    // said anything at all.
    const result = reconciled.resultText.trim() ? reconciled.resultText : STALE_RESULT;
    const exitCode = reconciled.exitCode;

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

/**
 * The stderr capture that sits beside a task's stdout, named
 * `<output_file>.err` by `spawnDetached`. The convention is reproduced here
 * rather than plumbed through, exactly as task-liveness.ts does it.
 */
function readStderrSibling(outputFile: string | null): string {
  if (!outputFile) return "";
  try {
    return readFileSync(`${outputFile}.err`, "utf-8");
  } catch {
    return ""; // No stderr file; stdout is the source of truth.
  }
}
