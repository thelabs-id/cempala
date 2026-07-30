// test/unit/db-migration.test.ts
//
// The schema is all `CREATE TABLE IF NOT EXISTS`, which does nothing to a
// table that already exists. So adding a column needs an explicit migration,
// or an upgraded cempala opening a database written by an earlier build fails
// on every query naming the new column — i.e. every dispatch and check_task.
//
// This test builds a genuinely old-shaped database (tasks WITHOUT
// pid_is_agent) and then opens it the way the server does.

import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/client.ts";

const dir = mkdtempSync(join(tmpdir(), "cempala-migration-"));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can still hold the SQLite WAL/SHM sidecars briefly after
    // close(); a leftover temp dir is not worth failing the suite over.
  }
});

function columnsOf(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

describe("additive column migrations", () => {
  test("an older database gains pid_is_agent when opened", () => {
    const dbPath = join(dir, "old.db");

    // A tasks table in the pre-pid_is_agent shape.
    const old = new Database(dbPath, { create: true });
    old.exec(`
      CREATE TABLE tasks (
        id            TEXT NOT NULL PRIMARY KEY,
        description   TEXT NOT NULL,
        created_by    TEXT,
        assigned_to   TEXT,
        cwd           TEXT NOT NULL,
        status        TEXT NOT NULL,
        result        TEXT,
        exit_code     INTEGER,
        via           TEXT NOT NULL,
        pid           INTEGER,
        output_file   TEXT,
        created_at    INTEGER NOT NULL,
        claimed_at    INTEGER,
        started_at    INTEGER,
        completed_at  INTEGER
      );
    `);
    old.run(
      `INSERT INTO tasks(id, description, cwd, status, via, created_at, pid)
       VALUES ('legacy', 'from an older build', '.', 'running', 'dispatch', 1, 4242)`,
    );
    expect(columnsOf(old, "tasks")).not.toContain("pid_is_agent");
    old.close();

    // Open it the way the server does.
    const db = openDatabase(dbPath);
    try {
      expect(columnsOf(db.raw, "tasks")).toContain("pid_is_agent");

      // The pre-existing row survives, and reads as the conservative NULL —
      // not as "the pid was the agent", which would change how its liveness
      // is judged.
      const row = db.get<{ id: string; pid: number; pid_is_agent: number | null }>(
        `SELECT id, pid, pid_is_agent FROM tasks WHERE id = 'legacy'`,
      );
      expect(row?.pid).toBe(4242);
      expect(row?.pid_is_agent).toBeNull();
    } finally {
      db.raw.close();
    }
  });

  test("opening twice is a no-op the second time", () => {
    const dbPath = join(dir, "twice.db");
    const a = openDatabase(dbPath);
    a.raw.close();
    const b = openDatabase(dbPath);
    try {
      const cols = columnsOf(b.raw, "tasks");
      expect(cols.filter((c) => c === "pid_is_agent")).toHaveLength(1);
    } finally {
      b.raw.close();
    }
  });
});
