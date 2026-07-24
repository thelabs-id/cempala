// src/db/schema.ts
//
// Raw SQL schema + migrations (no ORM — AGENTS.md §5). Five tables, see
// REQUIREMENTS.md §5 for column-level documentation. Idempotent: every
// CREATE uses IF NOT EXISTS so migrations can be re-run.

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
-- Five tables per REQUIREMENTS.md §5.
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT NOT NULL PRIMARY KEY,
  display_name  TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT NOT NULL PRIMARY KEY,
  from_agent    TEXT NOT NULL REFERENCES agents(id),
  to_agent      TEXT NOT NULL REFERENCES agents(id),
  thread_id     TEXT,
  content       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  read_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_to_unread
  ON messages(to_agent, read_at);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT NOT NULL PRIMARY KEY,
  description   TEXT NOT NULL,
  -- created_by is the caller's identity for the audit row (G2). The
  -- dispatch path is allowed to leave this NULL when the caller
  -- didn't identify itself — see tools/dispatch.ts. FKs to agents(id)
  -- are still enforced when the value is present.
  created_by    TEXT REFERENCES agents(id),
  assigned_to   TEXT REFERENCES agents(id),
  cwd           TEXT NOT NULL,
  status        TEXT NOT NULL
                CHECK (status IN ('pending','needs_approval','claimed','running','completed','failed','rejected')),
  result        TEXT,
  exit_code     INTEGER,
  via           TEXT NOT NULL CHECK (via IN ('mailbox','dispatch')),
  pid           INTEGER,
  output_file   TEXT,
  created_at    INTEGER NOT NULL,
  claimed_at    INTEGER,
  started_at    INTEGER,
  completed_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_status
  ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_status
  ON tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_tasks_running
  ON tasks(status, started_at) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS approved_paths (
  path          TEXT NOT NULL PRIMARY KEY,
  approved_by   TEXT NOT NULL REFERENCES agents(id),
  approved_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  timestamp       INTEGER NOT NULL,
  tool            TEXT NOT NULL,
  args_json       TEXT NOT NULL,
  agent_id        TEXT,
  result_summary  TEXT NOT NULL,
  duration_ms     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp
  ON audit_log(timestamp);

-- Idempotent seed for the two agents we ship wired up (FR/AC mention
-- "claude" and "codex" as the v1 set). NG2 limits v1 to two; this is the
-- only seeding the system does — additional agents are added at runtime
-- when they're referenced.
INSERT OR IGNORE INTO agents(id, display_name, created_at) VALUES
  ('claude', 'Claude Code', 0),
  ('codex',  'Codex CLI',   0);
`;
