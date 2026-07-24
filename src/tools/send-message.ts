// src/tools/send-message.ts
//
// FR-1: write a row to `messages`. No side effects beyond storage.
// (MCP tool registration lives in index.ts; this file is the handler body.)

import type { DB } from "../db/client.ts";
import { randomUUID } from "node:crypto";

export interface SendMessageInput {
  from_agent: string;
  to_agent: string;
  content: string;
  thread_id?: string | null;
}

export interface SendMessageOutput {
  message_id: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; code: string };

export function sendMessage(db: DB, input: SendMessageInput): Result<SendMessageOutput> {
  if (!input.from_agent || !input.to_agent) {
    return { ok: false, error: "from_agent and to_agent are required", code: "invalid_input" };
  }
  if (typeof input.content !== "string") {
    return { ok: false, error: "content must be a string", code: "invalid_input" };
  }
  // Ensure both agents exist (auto-create on first reference; this is what
  // makes "add a new agent" as simple as sending a message to/from it).
  ensureAgent(db, input.from_agent);
  ensureAgent(db, input.to_agent);

  const id = randomUUID();
  const createdAt = Date.now();
  db.run(
    `INSERT INTO messages(id, from_agent, to_agent, thread_id, content, created_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    [id, input.from_agent, input.to_agent, input.thread_id ?? null, input.content, createdAt],
  );
  return { ok: true, data: { message_id: id } };
}

/**
 * Atomic agent upsert (P2 fix). Two MCP server processes (Claude's +
 * Codex's) share the DB; a SELECT-then-INSERT race on first reference
 * would throw a UNIQUE constraint error in one of them, surfacing as
 * an unhandled exception instead of the structured tool result the
 * caller expects. INSERT OR IGNORE makes the second a no-op.
 *
 * Shared by every tool that auto-creates agents on first reference
 * (send-message, claim-task, dispatch, create-task, complete-task,
 * approve-path). All of these are documented in §6 as needing to
 * accept unknown agent ids and seed them on the fly.
 */
export function ensureAgent(db: DB, id: string): void {
  db.run(
    `INSERT OR IGNORE INTO agents(id, display_name, created_at) VALUES (?, ?, ?)`,
    [id, id, Date.now()],
  );
}
