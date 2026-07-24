// src/tools/check-task.ts
//
// FR-7: read current task row. For tasks still `running`, checks whether
// the backing process is alive via platform/spawn.ts; if the process has
// exited but the row wasn't updated (edge case — e.g. server restarted),
// reconcile from `output_file` and update the row.

import { existsSync, readFileSync } from "node:fs";
import type { DB } from "../db/client.ts";
import { isAlive } from "../platform/spawn.ts";
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
  const row = db.get<CheckTaskOutput>(`SELECT id AS task_id, status, result, exit_code, started_at, completed_at, pid, output_file, via FROM tasks WHERE id = ?`, [input.task_id]);
  if (!row) {
    return { ok: false, error: `task ${input.task_id} not found`, code: "not_found" };
  }

  // Only running tasks can be reconciled. Terminal statuses stay terminal.
  if (row.status === "running") {
    const alive = row.pid !== null && isAlive(row.pid);
    if (!alive) {
      // Process is gone. Read the output file and decide completed vs failed.
      const { exitCode, resultText } = reconcileFromOutput(row.output_file);
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
 * Read the captured stdout/stderr file. Strategy (P2 fix: walk forward,
 * preferring `result` over completion events, to match the dispatch
 * path's `tryParseJson` semantics):
 *   1. First parseable JSON object with a `result` field → exit 0 with
 *      the result.
 *   2. First with an `exit_code` field → use that (and any `error` text).
 *   3. First with a Codex `turn.completed` / `thread.completed` /
 *      `item.completed` event with no error → exit 0.
 *   4. Otherwise: process died without a clean exit signal — record as
 *      failed with the raw text.
 *
 * The forward walk matches `tryParseJson` in dispatch.ts. The previous
 * backward walk had a known issue: when the last parseable line was
 * `thread.completed` (no `result`), we'd return that, losing the
 * agent's final answer which sat on an earlier line.
 */
function reconcileFromOutput(outputFile: string | null): { exitCode: number; resultText: string } {
  if (!outputFile || !existsSync(outputFile)) {
    return { exitCode: -1, resultText: "process exited without a recorded result — check output_file" };
  }
  const text = readFileSync(outputFile, "utf-8");
  if (!text) return { exitCode: -1, resultText: "" };
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

  // Pass 1: any line with a `result` field (the canonical final answer).
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && "result" in obj) {
        return { exitCode: 0, resultText: String(obj.result ?? "") };
      }
    } catch { /* try next */ }
  }
  // Pass 2: any line with an `exit_code` (failed runs).
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && "exit_code" in obj && typeof obj.exit_code === "number") {
        return { exitCode: obj.exit_code, resultText: typeof obj.error === "string" ? obj.error : text };
      }
    } catch { /* try next */ }
  }
  // Pass 3: any line with a Codex completion event (no result field).
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object") {
        const t = (obj as { type?: string }).type;
        if (t === "turn.completed" || t === "thread.completed" || t === "item.completed") {
          if (obj.error) {
            return { exitCode: 1, resultText: typeof obj.error === "string" ? obj.error : JSON.stringify(obj.error) };
          }
          return { exitCode: 0, resultText: typeof obj.text === "string" ? obj.text : text };
        }
      }
    } catch { /* try next */ }
  }
  // Pass 4: any line with an `error` field.
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && "error" in obj && obj.error && (typeof obj.error === "string" ? obj.error.length > 0 : true)) {
        return { exitCode: 1, resultText: typeof obj.error === "string" ? obj.error : JSON.stringify(obj.error) };
      }
    } catch { /* try next */ }
  }
  // No structured completion event. Process died without a clean exit
  // signal — record as failed and surface the raw text.
  return { exitCode: -1, resultText: text };
}
