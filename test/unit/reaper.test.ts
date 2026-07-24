// test/unit/reaper.test.ts
//
// FR-17: the reaper must clear `running` tasks older than 30 minutes with
// a dead PID. We can't reliably kill a real child within the test, so we
// use a synthetic "running" row whose `pid` is set to a definitely-dead
// number (large value, or 0, or our own short-lived child).

import { describe, test, expect } from "bun:test";
import { makeEnv } from "./_helpers.ts";
import { sweepStaleTasks } from "../../src/reaper.ts";
import { spawn } from "bun";

describe("sweepStaleTasks (FR-17 / AC-6 sweep path)", () => {
  test("a recent running task with a live pid is NOT swept", () => {
    const env = makeEnv();
    try {
      // Spawn a long-lived child and record its pid in a running task row.
      const proc = spawn({
        cmd: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
        stdio: ["ignore", "ignore", "ignore"],
      });
      env.db.run(
        `INSERT INTO tasks(id, description, created_by, cwd, status, via, created_at, started_at, pid)
         VALUES ('t1', 'live', 'claude', '.', 'running', 'dispatch', ?, ?, ?)`,
        [Date.now(), Date.now(), proc.pid],
      );
      const r = sweepStaleTasks(env.db, Date.now() + 10_000);
      expect(r.swept).toBe(0);
      const row = env.db.get<{ status: string }>(`SELECT status FROM tasks WHERE id='t1'`);
      expect(row?.status).toBe("running");
      // Clean up the child.
      try { process.kill(proc.pid, 9); } catch { /* ignore */ }
    } finally { env.cleanup(); }
  });

  test("a stale running task with a dead pid is marked failed", async () => {
    const env = makeEnv();
    try {
      // Create a stale running row with a pid that cannot possibly exist.
      // We use a real spawn and immediately kill it, so the pid IS valid in
      // the OS sense for a brief moment but the process is gone.
      const proc = spawn({
        cmd: [process.execPath, "-e", "process.exit(0)"],
        stdio: ["ignore", "ignore", "ignore"],
      });
      const childPid = proc.pid;
      // Wait for the child to exit.
      await proc.exited;
      // 31 minutes ago, with the now-dead pid.
      const past = Date.now() - 31 * 60 * 1000;
      env.db.run(
        `INSERT INTO tasks(id, description, created_by, cwd, status, via, created_at, started_at, pid)
         VALUES ('t-stale', 'stale', 'claude', '.', 'running', 'dispatch', ?, ?, ?)`,
        [past, past, childPid],
      );
      const r = sweepStaleTasks(env.db, Date.now());
      expect(r.swept).toBe(1);
      const row = env.db.get<{ status: string; result: string }>(`SELECT status, result FROM tasks WHERE id='t-stale'`);
      expect(row?.status).toBe("failed");
      expect(row?.result).toContain("process exited without a recorded result");
    } finally { env.cleanup(); }
  });
});
