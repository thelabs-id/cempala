// test/unit/reaper.test.ts
//
// FR-17: the reaper must clear `running` tasks older than 30 minutes with
// a dead PID. We can't reliably kill a real child within the test, so we
// use a synthetic "running" row whose `pid` is set to a definitely-dead
// number (large value, or 0, or our own short-lived child).

import { describe, test, expect } from "bun:test";
import { writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
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
      const row = env.db.get<{ status: string; result: string; exit_code: number | null }>(
        `SELECT status, result, exit_code FROM tasks WHERE id='t-stale'`,
      );
      expect(row?.status).toBe("failed");
      expect(row?.result).toContain("process exited without a recorded result");
      // A swept row must carry an exit code like every other terminal row —
      // leaving it NULL made swept tasks a second-class shape for the audit
      // trail.
      expect(row?.exit_code).toBe(-1);
    } finally { env.cleanup(); }
  });

  test("a stale task whose output shows success is swept as completed, not failed", async () => {
    // The sweep exists to stop rows sitting at `running` forever — not to
    // overwrite a success with a failure. Blanket-failing every swept row
    // reported agents as having failed work they had actually finished.
    const env = makeEnv();
    try {
      const proc = spawn({
        cmd: [process.execPath, "-e", "process.exit(0)"],
        stdio: ["ignore", "ignore", "ignore"],
      });
      const childPid = proc.pid;
      await proc.exited;

      const outFile = join(env.dir, "swept-output.log");
      writeFileSync(
        outFile,
        [
          `{"type":"turn.started"}`,
          `{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"all done"}}`,
          `{"type":"turn.completed","usage":{"input_tokens":10}}`,
        ].join("\n"),
      );
      const old = new Date(Date.now() - 31 * 60 * 1000);
      utimesSync(outFile, old, old);

      const past = Date.now() - 31 * 60 * 1000;
      env.db.run(
        `INSERT INTO tasks(id, description, created_by, cwd, status, via, created_at, started_at, pid, output_file)
         VALUES ('t-done', 'finished', 'claude', '.', 'running', 'dispatch', ?, ?, ?, ?)`,
        [past, past, childPid, outFile],
      );

      const r = sweepStaleTasks(env.db, Date.now());
      expect(r.swept).toBe(1);
      const row = env.db.get<{ status: string; result: string; exit_code: number | null }>(
        `SELECT status, result, exit_code FROM tasks WHERE id='t-done'`,
      );
      expect(row?.status).toBe("completed");
      expect(row?.result).toBe("all done");
      expect(row?.exit_code).toBe(0);
    } finally { env.cleanup(); }
  });

  test("a swept run that said nothing on stdout surfaces its stderr, not the canned message", async () => {
    // Parity with dispatch and check_task. This path used to fall straight
    // through to STALE_RESULT whenever stdout carried no answer, so a run
    // whose only explanation went to stderr was swept into a generic
    // "check output_file" — while the very same row, read through
    // check_task, would have told the caller what actually happened.
    //
    // agy makes this reachable on a SUCCESSFUL run: a headless permission
    // auto-denial exits 0 with `response: ""` and writes the reason to
    // stderr alone.
    const env = makeEnv();
    try {
      const proc = spawn({ cmd: [process.execPath, "-e", "process.exit(0)"], stdio: ["ignore", "ignore", "ignore"] });
      const childPid = proc.pid;
      await proc.exited;

      const outFile = join(env.dir, "softdeny-output.log");
      writeFileSync(outFile, JSON.stringify({ conversation_id: "c1", status: "SUCCESS", response: "" }));
      writeFileSync(`${outFile}.err`, `jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.`);
      const old = new Date(Date.now() - 31 * 60 * 1000);
      utimesSync(outFile, old, old);
      utimesSync(`${outFile}.err`, old, old);

      const past = Date.now() - 31 * 60 * 1000;
      env.db.run(
        `INSERT INTO tasks(id, description, created_by, cwd, status, via, created_at, started_at, pid, output_file)
         VALUES ('t-soft', 'silent', 'claude', '.', 'running', 'dispatch', ?, ?, ?, ?)`,
        [past, past, childPid, outFile],
      );

      expect(sweepStaleTasks(env.db, Date.now()).swept).toBe(1);
      const row = env.db.get<{ status: string; result: string; exit_code: number | null }>(
        `SELECT status, result, exit_code FROM tasks WHERE id='t-soft'`,
      );
      // The agent's own verdict is preserved — the sweep does not invent one.
      expect(row?.status).toBe("completed");
      expect(row?.exit_code).toBe(0);
      // And the caller gets the reason instead of the canned message.
      expect(row?.result).toContain("auto-denied");
      expect(row?.result).not.toContain("check output_file");
    } finally { env.cleanup(); }
  });

  test("a swept run with nothing on either stream still gets the canned message", async () => {
    // STALE_RESULT remains the last resort. An empty result would leave the
    // caller with nothing at all.
    const env = makeEnv();
    try {
      const proc = spawn({ cmd: [process.execPath, "-e", "process.exit(0)"], stdio: ["ignore", "ignore", "ignore"] });
      const childPid = proc.pid;
      await proc.exited;

      const outFile = join(env.dir, "silent-output.log");
      writeFileSync(outFile, "");
      const old = new Date(Date.now() - 31 * 60 * 1000);
      utimesSync(outFile, old, old);

      const past = Date.now() - 31 * 60 * 1000;
      env.db.run(
        `INSERT INTO tasks(id, description, created_by, cwd, status, via, created_at, started_at, pid, output_file)
         VALUES ('t-silent', 'silent', 'claude', '.', 'running', 'dispatch', ?, ?, ?, ?)`,
        [past, past, childPid, outFile],
      );

      expect(sweepStaleTasks(env.db, Date.now()).swept).toBe(1);
      const row = env.db.get<{ result: string }>(`SELECT result FROM tasks WHERE id='t-silent'`);
      expect(row?.result).toContain("check output_file");
    } finally { env.cleanup(); }
  });
});
