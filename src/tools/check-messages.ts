// src/tools/check-messages.ts
//
// FR-2: return unread (or all, if `since` given) messages addressed to
// `agent_id`, marks them read.
//
// Concurrency note: in the documented two-writer SQLite setup, two
// MCP servers (Claude's + Codex's) share the DB. A naive
// "SELECT then UPDATE WHERE read_at IS NULL" can return the same
// unread messages to both callers, because the SELECT happens before
// either UPDATE commits. The fix: do the read-marking as part of the
// same SQLite statement that does the SELECT — `UPDATE ... RETURNING`
// in PostgreSQL, but SQLite supports this via a single-statement
// `UPDATE` that filters and the matching rows are returned via a
// subsequent SELECT under the same transaction, OR via a CTE. We use
// the simpler approach: in the `since = null` (unread) branch, claim
// rows by setting read_at = now INSIDE the transaction, then SELECT
// the rows we just claimed (whose read_at is now non-null). The
// transaction's read lock prevents a concurrent caller from claiming
// the same rows.

import type { DB } from "../db/client.ts";
import type { Result } from "./send-message.ts";

export interface CheckMessagesInput {
  agent_id: string;
  since?: number | null;
  thread_id?: string | null;
}

export interface MessageRow {
  id: string;
  from_agent: string;
  to_agent: string;
  thread_id: string | null;
  content: string;
  created_at: number;
  read_at: number | null;
}

export function checkMessages(db: DB, input: CheckMessagesInput): Result<MessageRow[]> {
  if (!input.agent_id) {
    return { ok: false, error: "agent_id is required", code: "invalid_input" };
  }
  const since = input.since ?? null;
  const thread = input.thread_id ?? null;

  // Build the query. `since` semantics: when provided, return all messages
  // for the agent newer than that timestamp (read or unread); when absent,
  // return only unread.
  const where: string[] = ["to_agent = ?"];
  const params: (string | number | null)[] = [input.agent_id];
  if (since === null) {
    where.push("read_at IS NULL");
  } else {
    where.push("created_at >= ?");
    params.push(since);
  }
  if (thread !== null) {
    where.push("thread_id = ?");
    params.push(thread);
  }

  // For the `since = null` (default unread) branch, we mark the rows
  // read INSIDE the same transaction that selects them. SQLite's
  // default-journal-mode (we use WAL) means readers don't block writers,
  // but two writers on the same row would: the UPDATE acquires a
  // write lock that conflicts with the second transaction's UPDATE.
  // Combined with the `read_at IS NULL` filter, this means exactly one
  // concurrent caller can claim a given unread row.
  //
  // We use an IMMEDIATE transaction (not the default DEFERRED) so the
  // write lock is acquired at BEGIN, not at the first write statement.
  // With DEFERRED, two callers can both pass the SELECT-before-UPDATE
  // race window; IMMEDIATE forces the second caller to wait for the
  // first to commit.
  if (since === null) {
    // Atomic claim via UPDATE...RETURNING (SQLite 3.35+; bun:sqlite
    // supports it). The claim and the read-back happen in the same
    // statement, so two concurrent callers cannot both see the same
    // row: SQLite's write lock guarantees that exactly one transaction
    // updates each row, and the row is returned only to that
    // transaction. (Earlier design tried UPDATE then SELECT inside
    // an IMMEDIATE transaction; that broke when two transactions set
    // read_at to the same millisecond value, making the second's
    // SELECT WHERE read_at = ? match rows the first had already
    // claimed. RETURNING is the atomic primitive.)
    //
    // We also use an IMMEDIATE transaction (not DEFERRED) so the
    // write lock is acquired at BEGIN, not at the first write. With
    // DEFERRED, two callers can both pass the SELECT-before-UPDATE
    // race window; IMMEDIATE forces the second caller to wait for the
    // first to commit.
    const rows = db.txImmediate((): MessageRow[] => {
      const now = Date.now();
      const sql = `UPDATE messages
                      SET read_at = ?
                    WHERE ${where.join(" AND ")}
                    RETURNING id, from_agent, to_agent, thread_id, content, created_at, read_at`;
      return db.all<MessageRow>(sql, [now, ...params]);
    });
    return { ok: true, data: rows };
  }

  // `since` branch: include all messages newer than the timestamp,
  // read or unread. Mark them read too (FR-2) but with a softer
  // marker: this is a polling-style fetch, not a strict unread
  // claim. The UPDATE only marks rows that are still unread.
  const sql = `SELECT id, from_agent, to_agent, thread_id, content, created_at, read_at
                 FROM messages
                WHERE ${where.join(" AND ")}
                ORDER BY created_at ASC`;
  const rows = db.all<MessageRow>(sql, params);
  if (rows.length > 0) {
    db.tx(() => {
      const now = Date.now();
      const stmt = db.raw.prepare(`UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL`);
      for (const r of rows) stmt.run(now, r.id);
    });
  }
  return { ok: true, data: rows };
}
