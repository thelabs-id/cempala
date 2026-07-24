// src/audit.ts
//
// Append-only audit logging (FR-8). Every tool call records one row
// with the START timestamp (NOT the completion time — a 600-second
// `dispatch` would otherwise be misordered relative to the calls
// that ran during its wait, breaking any time-based audit query).
// The duration_ms is computed at completion; the timestamp is the
// call start. The audit table is never pruned automatically
// (REQUIREMENTS.md §6 / FR-8).

import type { DB } from "./db/client.ts";

export interface AuditEntry {
  tool: string;
  args: unknown;
  agent_id: string | null;
  result_summary: string;
  duration_ms: number;
  /** Unix ms at which the tool call started. Defaults to now() if omitted. */
  timestamp?: number;
}

export function appendAudit(db: DB, entry: AuditEntry): void {
  db.run(
    `INSERT INTO audit_log(timestamp, tool, args_json, agent_id, result_summary, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.timestamp ?? Date.now(),
      entry.tool,
      safeStringify(entry.args),
      entry.agent_id,
      entry.result_summary,
      entry.duration_ms,
    ],
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "<unserializable>";
  }
}
