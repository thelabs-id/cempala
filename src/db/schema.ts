// src/db/schema.ts
//
// Raw SQL schema + migrations (no ORM). Five tables, documented column by
// column inline below. Idempotent: every CREATE uses IF NOT EXISTS so
// migrations can be re-run.

export const SCHEMA_SQL = `
-- Five tables: agents, messages, tasks, approved_paths, audit_log.
-- (schema_version was a 6th metadata table in a previous iteration; it was
-- unused and has been removed to keep the table count honest with the spec.)
--
-- The DROP TABLE below is a no-op on fresh databases and a one-time
-- cleanup on databases created by older builds that had the metadata
-- table. Without it, those DBs would keep the orphan table forever
-- even though the constant that used to populate it
-- (SCHEMA_VERSION) is gone.

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
  -- Whether pid is the agent itself rather than a launcher in front of it
  -- (1/0/NULL). False only for a Windows .cmd shim — see platform/spawn.ts.
  -- This has to be PERSISTED, not re-derived: after a server restart it is
  -- what tells liveness whether a dead pid is conclusive proof the run ended
  -- (the pid was the agent) or says nothing at all (it was only the shim).
  -- NULL, from rows written by earlier builds, is read as the conservative
  -- "not necessarily the agent".
  pid_is_agent  INTEGER,
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

-- Drop the now-unused metadata table from older builds. Idempotent:
-- no-op on DBs that never had it.
DROP TABLE IF EXISTS schema_version;

-- Idempotent seed for the agents we ship wired up. This is the only
-- seeding the system does — any other agent id is added at runtime when
-- it is first referenced.
--
-- INSERT OR IGNORE means this also seeds antigravity into databases
-- created by an earlier build, on the next open, without a migration:
-- the two existing rows are ignored and the new one lands. It matters
-- because messages.from_agent / tasks.assigned_to are foreign keys, so
-- an unseeded id would fail at the first mailbox hand-off rather than
-- at anything that reads this table.
INSERT OR IGNORE INTO agents(id, display_name, created_at) VALUES
  ('claude',      'Claude Code',     0),
  ('codex',       'Codex CLI',       0),
  ('antigravity', 'Antigravity CLI', 0);
`;

/**
 * Additive column migrations for databases created by earlier builds.
 *
 * The schema above is all `CREATE TABLE IF NOT EXISTS`, which does nothing to
 * a table that already exists — so a new column has to be added explicitly or
 * an upgraded cempala would fail every query mentioning it. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, hence the table_info check at the call site.
 *
 * Keep these additive and nullable: an older cempala should still be able to
 * open a newer database, and two versions may well be running side by side
 * (one registered with Claude, one with Codex).
 */
export const COLUMN_MIGRATIONS: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
  { table: "tasks", column: "pid_is_agent", ddl: "ALTER TABLE tasks ADD COLUMN pid_is_agent INTEGER" },
];
