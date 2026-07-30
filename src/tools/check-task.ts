// src/tools/check-task.ts
//
// FR-7: read current task row. For tasks still `running`, checks whether
// the backing process is alive via platform/spawn.ts; if the process has
// exited but the row wasn't updated (edge case — e.g. server restarted),
// reconcile from `output_file` and update the row.

import { existsSync, readFileSync } from "node:fs";
import type { DB } from "../db/client.ts";
import { parseAgentOutput } from "./agent-output.ts";
import { assessTask } from "./task-liveness.ts";
import type { Result } from "./send-message.ts";

export interface CheckTaskInput {
  task_id: string;
}

export interface CheckTaskOutput {
  task_id: string;
  status: string;
  result: string | null;
  exit_code: number | null;
  started_at: number | null;
  completed_at: number | null;
  pid: number | null;
  output_file: string | null;
  via: string;
}

export function checkTask(db: DB, input: CheckTaskInput): Result<CheckTaskOutput> {
  if (!input.task_id) {
    return { ok: false, error: "task_id is required", code: "invalid_input" };
  }
  const row = db.get<CheckTaskOutput & { pid_is_agent: number | null }>(`SELECT id AS task_id, status, result, exit_code, started_at, completed_at, pid, pid_is_agent, output_file, via FROM tasks WHERE id = ?`, [input.task_id]);
  if (!row) {
    return { ok: false, error: `task ${input.task_id} not found`, code: "not_found" };
  }

  // Only running tasks can be reconciled. Terminal statuses stay terminal.
  if (row.status === "running") {
    // Liveness is NOT just `isAlive(pid)` — see tools/task-liveness.ts for
    // why a dead pid does not imply a failed task on Windows.
    const liveness = assessTask({
      pid: row.pid,
      pidIsAgent: row.pid_is_agent === 1,
      outputFile: row.output_file,
    });
    if (liveness.state !== "running") {
      const { exitCode, resultText } =
        liveness.state === "finished"
          ? { exitCode: liveness.exitCode, resultText: liveness.resultText }
          : reconcileFromOutput(row.output_file);
      const finalStatus = exitCode === 0 ? "completed" : "failed";
      // For failed runs, also read the stderr sibling if present
      // (P2 fix). Many CLIs print auth/usage errors to stderr only —
      // without this, the reconciled task is "failed" with an empty
      // result and the caller has no actionable error. We detect
      // the stderr sibling by convention: `<output_file>.err`.
      let finalResult = resultText;
      if (finalStatus === "failed" && row.output_file) {
        const errFile = `${row.output_file}.err`;
        let errText = "";
        try {
          errText = readFileSync(errFile, "utf-8").trim();
        } catch {
          // No stderr file; that's fine, stdout is the source of truth.
        }
        if (errText && !resultText) {
          finalResult = errText;
        } else if (errText) {
          finalResult = `${resultText}\n\nstderr:\n${errText}`;
        }
      }
      const now = Date.now();
      db.run(
        `UPDATE tasks SET status = ?, exit_code = ?, result = ?, completed_at = ? WHERE id = ? AND status = 'running'`,
        [finalStatus, exitCode, finalResult, now, input.task_id],
      );
      return {
        ok: true,
        data: { ...row, status: finalStatus, exit_code: exitCode, result: finalResult, completed_at: now },
      };
    }
  }
  return { ok: true, data: row };
}

/**
 * Reconcile a task whose backing process is gone, using only the captured
 * output — by this point the child was spawned by a previous server process
 * and its OS exit status is unavailable to us.
 *
 * Parsing lives in `tools/agent-output.ts`, shared with dispatch and the
 * reaper, so the three paths cannot drift apart again. Output that carries
 * no verdict at all means the process died without ever finishing a turn,
 * which is a genuine failure (`-1`).
 */
function reconcileFromOutput(outputFile: string | null): { exitCode: number; resultText: string } {
  const NO_RESULT = "process exited without a recorded result — check output_file";
  if (!outputFile || !existsSync(outputFile)) {
    return { exitCode: -1, resultText: NO_RESULT };
  }
  let text = "";
  try {
    text = readFileSync(outputFile, "utf-8");
  } catch {
    return { exitCode: -1, resultText: NO_RESULT };
  }
  if (!text.trim()) return { exitCode: -1, resultText: "" };

  const { resultText, inferredExitCode } = parseAgentOutput(text);
  return {
    exitCode: inferredExitCode ?? -1,
    resultText: resultText || NO_RESULT,
  };
}
