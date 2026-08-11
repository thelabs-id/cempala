// test/integration/dispatch-real.test.ts
//
// AC-1, AC-2: actually spawn codex, claude and agy and have them do work.
// AC-5: a long-running child returns 'running' at the timeout boundary.
// AC-6 (direct reconcile): check_task on a killed running task reconciles it.
// AC-9: needs_approval → approve_path → success on a real outside-home cwd.
//
// Gated behind CEMPALA_INTEGRATION=1. Skipped otherwise.

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { INTEGRATION_ENABLED, makeIntEnv } from "./_helpers.ts";
import { dispatch } from "../../src/tools/dispatch.ts";
import { approvePath } from "../../src/tools/approve-path.ts";
import { checkTask } from "../../src/tools/check-task.ts";
import { spawn } from "bun";
import { sweepStaleTasks } from "../../src/reaper.ts";

const SKIP_REASON = "set CEMPALA_INTEGRATION=1 to run integration tests (require codex + claude + agy on PATH)";

/**
 * Kill a process AND its descendants.
 *
 * `process.kill(pid)` alone is not enough for these tests: on Windows the
 * recorded pid is an npm .cmd shim, and killing only the shim leaves the real
 * agent running — which is the whole reason the false-failure bug existed. A
 * test that wants the agent genuinely gone has to take the tree with it.
 */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
      return;
    } catch {
      // Fall through to the POSIX-style kill below.
    }
  }
  try {
    process.kill(pid, 9);
  } catch {
    // Already gone.
  }
}

describe.skipIf(!INTEGRATION_ENABLED)("integration: dispatch (AC-1, AC-2, AC-5, AC-6, AC-9)", () => {
  test("AC-1: codex generates a 512x512 blue circle PNG (allow_network=false)", async () => {
    const env = makeIntEnv();
    try {
      const r = await dispatch(env.db, env.cfg, {
        target_agent: "codex",
        prompt: "Generate a 512x512 PNG file at " + join(env.homeCwd, "circle.png") + " that contains a solid blue circle. Use a small Python script if needed. The image must be exactly 512x512 and the dominant color must be blue.",
        cwd: env.homeCwd,
        allow_network: false,
        wait_seconds: 300,
        created_by: "claude",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        if (r.data.status !== "completed") {
          throw new Error(`expected completed, got ${r.data.status}: ${JSON.stringify(r.data)}`);
        }
        expect(r.data.network_enforcement).toBe("sandboxed");
        // Verify the file exists and is a valid PNG of 512x512.
        const file = join(env.homeCwd, "circle.png");
        expect(existsSync(file)).toBe(true);
        const buf = readFileSync(file);
        // PNG header check: starts with 0x89 50 4E 47 0D 0A 1A 0A
        expect(buf[0]).toBe(0x89);
        expect(buf[1]).toBe(0x50);
        expect(buf[2]).toBe(0x4e);
        expect(buf[3]).toBe(0x47);
        // Width/height at offset 16-23 in IHDR (big-endian): both 512 = 0x00000200
        const w = (buf[16]! << 24) | (buf[17]! << 16) | (buf[18]! << 8) | buf[19]!;
        const h = (buf[20]! << 24) | (buf[21]! << 16) | (buf[22]! << 8) | buf[23]!;
        expect(w).toBe(512);
        expect(h).toBe(512);
      }
    } finally { env.cleanup(); }
  }, { timeout: 600_000 });

  test("AC-2: claude refactors a file in the cwd (allow_network=false)", async () => {
    const env = makeIntEnv();
    try {
      // Write a small file to be refactored.
      const target = join(env.homeCwd, "refactor-me.js");
      writeFileSync(target, `function add(a,b){return a+b}
function sub(a,b){return a-b}
module.exports = { add, sub };
`, "utf-8");
      const r = await dispatch(env.db, env.cfg, {
        target_agent: "claude",
        prompt: `Refactor the file ${target}: rename the functions to sum() and diff() respectively, keep the same module.exports. Use the Read and Edit tools. Do not touch any other files.`,
        cwd: env.homeCwd,
        allow_network: false,
        wait_seconds: 300,
        created_by: "claude",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        // The CLI may legitimately fail with an auth error in environments
        // where the OAuth token is expired — that's a real test-env issue,
        // not a code issue. The contract being tested is that dispatch
        // reports network_enforcement=tools_only and surfaces the CLI's
        // error in `result` rather than crashing or silently mislabeling.
        if (r.data.status === "completed") {
          expect(r.data.network_enforcement).toBe("tools_only");
          const after = readFileSync(target, "utf-8");
          expect(after).toContain("sum");
          expect(after).toContain("diff");
        } else if (r.data.status === "failed") {
          // Surface the underlying error so a real environment failure is
          // visible — but don't fail the test for an expired OAuth token.
          console.warn("claude dispatch returned failed (likely auth):", r.data.result?.slice(0, 200));
          expect(r.data.network_enforcement).toBe("tools_only");
        } else {
          throw new Error(`expected completed or failed, got ${r.data.status}: ${JSON.stringify(r.data)}`);
        }
      }
    } finally { env.cleanup(); }
  }, { timeout: 600_000 });

  test("antigravity writes a file in the cwd and reports network_enforcement honestly", async () => {
    const env = makeIntEnv();
    try {
      const target = join(env.homeCwd, "antigravity-wrote-this.txt");
      const r = await dispatch(env.db, env.cfg, {
        target_agent: "antigravity",
        // A RELATIVE path on purpose. An absolute one proves nothing: agy
        // honors those wherever its workspace happens to be. Relative is
        // the case that caught the real bug — without `--add-dir <cwd>` it
        // resolved against ~/.gemini/antigravity-cli/scratch and the file
        // never appeared in the dispatch cwd at all.
        prompt: `Create a file at the relative path ./antigravity-wrote-this.txt containing exactly the word OK and nothing else. Use your file-writing tool, not a shell command. Do not touch any other files.`,
        cwd: env.homeCwd,
        allow_network: false,
        wait_seconds: 300,
        created_by: "claude",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        // The label is asserted on BOTH branches. It is the one thing that
        // must hold whatever the CLI does, and an unauthenticated agy —
        // which returns `authentication failed or timed out` after waiting
        // for a sign-in a headless run can never complete — is exactly the
        // environment where a mislabeled result would go unnoticed.
        if (r.data.status === "completed") {
          expect(r.data.network_enforcement).toBe("not_enforceable");
          // The file must be in the DISPATCH CWD, not agy's scratch dir.
          expect(existsSync(target)).toBe(true);
          expect(readFileSync(target, "utf-8").trim()).toBe("OK");
          // A run that did nothing must never come back with an empty
          // result: agy reports a headless permission auto-denial by
          // exiting 0 with `response: ""` and the reason on stderr only.
          expect((r.data.result ?? "").trim().length).toBeGreaterThan(0);
        } else if (r.data.status === "failed") {
          console.warn("antigravity dispatch returned failed (likely auth):", r.data.result?.slice(0, 200));
          expect(r.data.network_enforcement).toBe("not_enforceable");
          // Whatever went wrong, the caller must get the reason and not the
          // raw JSON envelope it was buried in.
          expect(r.data.result ?? "").not.toContain("conversation_id");
        } else {
          throw new Error(`expected completed or failed, got ${r.data.status}: ${JSON.stringify(r.data)}`);
        }
      }
    } finally { env.cleanup(); }
  }, { timeout: 600_000 });

  test("AC-5: a long-running child returns 'running' at the timeout boundary", async () => {
    const env = makeIntEnv();
    try {
      const r = await dispatch(env.db, env.cfg, {
        target_agent: "codex",
        // The agent will eventually call something that takes >5s. We set
        // wait_seconds=3 so the wrapper returns 'running' well before the
        // child finishes. (The exact prompt doesn't matter — we just need
        // the agent to do work that exceeds 3s.)
        prompt: "Sleep for 30 seconds using the shell (run `sleep 30`), then say 'done'.",
        cwd: env.homeCwd,
        allow_network: false,
        wait_seconds: 3,
        created_by: "claude",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.status).toBe("running");
    } finally { env.cleanup(); }
  }, { timeout: 120_000 });

  test("AC-6 (direct reconcile): check_task reconciles a killed running task", async () => {
    const env = makeIntEnv();
    try {
      // Create a running row whose child we can kill.
      const r = await dispatch(env.db, env.cfg, {
        target_agent: "codex",
        prompt: "Sleep 30 seconds, then exit.",
        cwd: env.homeCwd,
        allow_network: false,
        wait_seconds: 2,
        created_by: "claude",
      });
      expect(r.ok && r.data.status).toBe("running");
      if (!r.ok) throw new Error("dispatch did not return running");
      const taskId = r.data.task_id;
      // Find the live pid from the DB.
      const row = env.db.get<{ pid: number | null }>(`SELECT pid FROM tasks WHERE id = ?`, [taskId]);
      expect(row?.pid).toBeGreaterThan(0);
      if (!row?.pid) throw new Error("no pid");

      // Kill the recorded process.
      //
      // This test used to assert that check_task turned the row `failed`
      // immediately afterwards. That assertion encoded the false-failure bug:
      // on Windows the recorded pid is a .cmd shim, so killing it says
      // nothing about the agent behind it, and tasks were being reported as
      // failed while the agent went on to finish the work successfully.
      //
      // The corrected contract is that a no-longer-live task reaches a
      // terminal state that matches reality — never a false one, and never
      // `running` forever. So: kill the whole tree (so the agent really is
      // gone, not just its launcher), require that nothing claims success,
      // and then drive the reaper's own clock past the stale window to prove
      // the row does get cleared. FR-17 is what bounds this; the timing
      // behavior in between is covered deterministically by the unit tests.
      killTree(row.pid);

      const chk = checkTask(env.db, { task_id: taskId });
      expect(chk.ok).toBe(true);
      // Whatever it says now, it must not claim the run succeeded.
      if (chk.ok) expect(chk.data.status).not.toBe("completed");

      // Advance the sweep's clock past FR-17's window.
      sweepStaleTasks(env.db, Date.now() + 31 * 60 * 1000);
      const after = env.db.get<{ status: string; exit_code: number | null }>(
        `SELECT status, exit_code FROM tasks WHERE id = ?`,
        [taskId],
      );
      expect(after?.status).toBe("failed");
      expect(after?.exit_code).not.toBeNull();
    } finally { env.cleanup(); }
  }, { timeout: 120_000 });

  test("AC-6 (sweep): an unrelated tool call triggers the reaper to clear a stale running task", async () => {
    const env = makeIntEnv();
    try {
      // Insert a synthetic stale running row (the kind of thing the reaper
      // is supposed to catch). We don't need a real child — a fake pid
      // that's already dead.
      const fakePid = 0x7ffffff0; // unlikely to exist
      const past = Date.now() - 31 * 60 * 1000;
      env.db.run(
        `INSERT INTO tasks(id, description, created_by, cwd, status, via, created_at, started_at, pid, output_file)
         VALUES ('stale-test', 'stale', 'claude', '.', 'running', 'dispatch', ?, ?, ?, NULL)`,
        [past, past, fakePid],
      );
      // Trigger the reaper via a sweep call.
      const r = sweepStaleTasks(env.db);
      expect(r.swept).toBeGreaterThan(0);
      const row = env.db.get<{ status: string; result: string }>(`SELECT status, result FROM tasks WHERE id='stale-test'`);
      expect(row?.status).toBe("failed");
      expect(row?.result).toContain("process exited without a recorded result");
    } finally { env.cleanup(); }
  }, { timeout: 30_000 });

  test("AC-9: needs_approval → approve_path → success on an outside-home cwd", async () => {
    const env = makeIntEnv();
    try {
      const r1 = await dispatch(env.db, env.cfg, {
        target_agent: "codex",
        prompt: "Just write 'hello' to " + join(env.outsideCwd, "marker.txt") + " using a shell command.",
        cwd: env.outsideCwd,
        allow_network: false,
        wait_seconds: 5,
        created_by: "claude",
      });
      expect(r1.ok && r1.data.status).toBe("needs_approval");
      if (!r1.ok) throw new Error("needs_approval expected");
      // Approve the path
      const r2 = approvePath(env.db, env.cfg, { agent_id: "claude", path: env.outsideCwd });
      expect(r2.ok).toBe(true);
      // Retry — should complete
      const r3 = await dispatch(env.db, env.cfg, {
        target_agent: "codex",
        prompt: "Just write 'hello' to " + join(env.outsideCwd, "marker.txt") + " using a shell command.",
        cwd: env.outsideCwd,
        allow_network: false,
        wait_seconds: 300,
        created_by: "claude",
      });
      expect(r3.ok && r3.data.status).toBe("completed");
    } finally { env.cleanup(); }
  }, { timeout: 600_000 });

  test("FR-7: a real agent orphaned by a dead recorded pid is not reported as failed", async () => {
    // The regression this guards is a false FAILURE: a dispatch outlived the
    // cempala server, the recorded pid died (on Windows it is a .cmd shim,
    // not the agent), and check_task called the task `failed` with exit -1
    // while the agent went on to finish the work successfully.
    //
    // This needs the real CLI: the behavior depends on the actual shim shape
    // the agent ships with, which no synthetic .cmd reproduces faithfully —
    // hence it lives here rather than in the unit suite.
    const env = makeIntEnv();
    try {
      const marker = join(env.homeCwd, "orphan-proof.txt");
      const r = await dispatch(env.db, env.cfg, {
        target_agent: "codex",
        prompt:
          "Write the text 'orphan survived' to " + marker + " using a shell command, then reply DONE.",
        cwd: env.homeCwd,
        allow_network: false,
        // Short on purpose: return while the agent is still working, so the
        // reconcile path is what decides the outcome.
        wait_seconds: 2,
        created_by: "claude",
      });
      expect(r.ok).toBe(true);
      if (!r.ok || r.data.status !== "running") {
        throw new Error(`expected running, got ${JSON.stringify(r.ok ? r.data : r)}`);
      }
      const taskId = r.data.task_id;

      // Kill the recorded pid outright. That is what the server exiting does
      // to the shim, and it is the exact condition that used to produce the
      // false failure.
      const row = env.db.get<{ pid: number | null }>(`SELECT pid FROM tasks WHERE id = ?`, [taskId]);
      if (row?.pid) {
        try {
          process.kill(row.pid, 9);
        } catch {
          // Already gone — the scenario we care about either way.
        }
      }

      // Poll until it reaches a terminal state. It must never land on
      // `failed` while the agent is still producing work.
      const deadline = Date.now() + 240_000;
      let final = checkTask(env.db, { task_id: taskId });
      while (Date.now() < deadline) {
        final = checkTask(env.db, { task_id: taskId });
        if (!final.ok) throw new Error("check_task failed");
        if (final.data.status !== "running") break;
        await Bun.sleep(3000);
      }
      if (!final.ok) throw new Error("check_task failed");

      // Whatever the platform did to the orphan, the recorded outcome must
      // match reality.
      if (existsSync(marker)) {
        // The agent survived and did the work — this is a success, and
        // reporting it as `failed` is the exact regression being guarded.
        expect(readFileSync(marker, "utf-8")).toContain("orphan survived");
        expect(final.data.status).toBe("completed");
        expect(final.data.exit_code).toBe(0);
        expect(final.data.result).toContain("DONE");
      } else {
        // The agent was killed with its launcher. That is a legitimate
        // outcome on platforms where the shim takes its child down — but it
        // must never be reported as a success.
        expect(final.data.status).not.toBe("completed");
      }
    } finally { env.cleanup(); }
  }, { timeout: 600_000 });
});
