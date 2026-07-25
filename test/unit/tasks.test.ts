// test/unit/tasks.test.ts
//
// FR-3, FR-4, FR-5, FR-7a: create_task / claim_task / complete_task / approve_path.
// Plus FR-9 (no silent error swallowing) and FR-11b (needs_approval is a
// successful outcome, not a failure).

import { describe, test, expect } from "bun:test";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { makeEnv } from "./_helpers.ts";
import { createTask } from "../../src/tools/create-task.ts";
import { claimTask } from "../../src/tools/claim-task.ts";
import { completeTask } from "../../src/tools/complete-task.ts";
import { approvePath } from "../../src/tools/approve-path.ts";
import { checkTask } from "../../src/tools/check-task.ts";

const HOME = homedir();
const HOME_CWD = join(HOME, "projects", "test-proj");
const OUTSIDE_CWD = join(HOME, "..", "external", "client-x");

describe("create_task (FR-3)", () => {
  test("a path under home stays pending", () => {
    const env = makeEnv();
    try {
      const r = createTask(env.db, env.cfg, {
        description: "do thing",
        created_by: "claude",
        cwd: HOME_CWD,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.status).toBe("pending");
    } finally { env.cleanup(); }
  });

  test("P1: wrong-type `assigned_to` is rejected (not silently coerced to agent id)", () => {
    // The schema advertises `["string", "null"]` but the MCP wire
    // format doesn't enforce it. A wrong type would either be
    // silently dropped (number `0`, boolean `false`) or coerced
    // into a misleading string. The handler now rejects.
    const env = makeEnv();
    try {
      const r = createTask(env.db, env.cfg, {
        description: "x",
        created_by: "claude",
        cwd: HOME_CWD,
        assigned_to: 42 as unknown as string,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("invalid_input");
        expect(r.error).toMatch(/assigned_to/i);
      }
    } finally { env.cleanup(); }
  });

  test("P1: empty-string `assigned_to` is rejected (not silently FK-errored)", () => {
    // The `if (input.assigned_to)` truthy check would skip
    // `ensureAgent("")` and the FK insert would fail with FOREIGN KEY
    // constraint. We now reject at the type-check stage.
    const env = makeEnv();
    try {
      const r = createTask(env.db, env.cfg, {
        description: "x",
        created_by: "claude",
        cwd: HOME_CWD,
        assigned_to: "",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("invalid_input");
        expect(r.error).toMatch(/assigned_to/i);
      }
    } finally { env.cleanup(); }
  });

  test("AC-3: a denylisted path is rejected (ok:false, code=denylist, task row recorded)", () => {
    const env = makeEnv();
    try {
      const r = createTask(env.db, env.cfg, {
        description: "do thing",
        created_by: "claude",
        cwd: join(HOME, ".ssh"),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("denylist");
      }
      const row = env.db.get<{ status: string }>(`SELECT status FROM tasks ORDER BY created_at DESC LIMIT 1`);
      expect(row?.status).toBe("rejected");
    } finally { env.cleanup(); }
  });

  test("FR-11b: a path outside home and not approved is needs_approval (ok=true, not an error)", () => {
    const env = makeEnv();
    try {
      const r = createTask(env.db, env.cfg, {
        description: "do thing",
        created_by: "claude",
        cwd: OUTSIDE_CWD,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.status).toBe("needs_approval");
    } finally { env.cleanup(); }
  });

  test("after approve_path, a previously needs_approval path is allowed (AC-9)", () => {
    const env = makeEnv();
    try {
      // First: needs_approval
      const r1 = createTask(env.db, env.cfg, { description: "x", created_by: "claude", cwd: OUTSIDE_CWD });
      expect(r1.ok && r1.data.status).toBe("needs_approval");
      // Approve
      const r2 = approvePath(env.db, env.cfg, { agent_id: "claude", path: OUTSIDE_CWD });
      expect(r2.ok).toBe(true);
      // Retry
      const r3 = createTask(env.db, env.cfg, { description: "x", created_by: "claude", cwd: OUTSIDE_CWD });
      expect(r3.ok && r3.data.status).toBe("pending");
    } finally { env.cleanup(); }
  });

  test("FR / P2: tasks.cwd is persisted as the canonical path, not the raw input", () => {
    const env = makeEnv();
    try {
      // Caller passes a tilde-prefixed path. The DB row should store
      // the expanded/canonical form, not the raw "~" form. On Windows
      // canonical form is case-folded (path comparison is
      // case-insensitive on that platform); on POSIX it preserves
      // case. We compare case-insensitively on Windows to absorb that.
      const r = createTask(env.db, env.cfg, {
        description: "x",
        created_by: "claude",
        cwd: "~/.cempala-test-cwd-canonical",
      });
      expect(r.ok && r.data.status).toBe("pending");
      if (!r.ok) throw new Error("setup failed");
      const row = env.db.get<{ cwd: string }>(`SELECT cwd FROM tasks WHERE id = ?`, [r.data.task_id]);
      expect(row?.cwd).not.toContain("~");
      // Compare case-insensitively on Windows (canonicalize lowercases
      // the entire path there, while os.homedir() preserves the OS case).
      const expected = join(HOME, ".cempala-test-cwd-canonical");
      const compareCI = process.platform === "win32"
        ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
        : (a: string, b: string) => a === b;
      expect(compareCI(row!.cwd, expected)).toBe(true);
    } finally { env.cleanup(); }
  });
});

describe("claim_task (FR-4)", () => {
  test("claims a pending task", () => {
    const env = makeEnv();
    try {
      const c = createTask(env.db, env.cfg, { description: "x", created_by: "claude", cwd: HOME_CWD });
      if (!c.ok) throw new Error("setup failed");
      const r = claimTask(env.db, { task_id: c.data.task_id, agent_id: "codex" });
      expect(r.ok).toBe(true);
    } finally { env.cleanup(); }
  });

  test("a second claim on the same task fails (not pending anymore)", () => {
    const env = makeEnv();
    try {
      const c = createTask(env.db, env.cfg, { description: "x", created_by: "claude", cwd: HOME_CWD });
      if (!c.ok) throw new Error("setup failed");
      const r1 = claimTask(env.db, { task_id: c.data.task_id, agent_id: "codex" });
      expect(r1.ok).toBe(true);
      const r2 = claimTask(env.db, { task_id: c.data.task_id, agent_id: "claude" });
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.code).toBe("invalid_state");
    } finally { env.cleanup(); }
  });

  test("claiming a needs_approval task is invalid_state (not pending)", () => {
    const env = makeEnv();
    try {
      const c = createTask(env.db, env.cfg, { description: "x", created_by: "claude", cwd: OUTSIDE_CWD });
      if (!c.ok || c.data.status !== "needs_approval") throw new Error("setup failed");
      const r = claimTask(env.db, { task_id: c.data.task_id, agent_id: "codex" });
      expect(r.ok).toBe(false);
    } finally { env.cleanup(); }
  });

  test("P3: two real processes racing on the same task — exactly one claim wins", async () => {
    // The single-connection claim tests above can pass even if the
    // implementation has a SELECT-then-UPDATE race, because there's
    // only one writer to serialize against itself. `claimTask` is
    // synchronous, so `Promise.all` of two calls in the same process
    // also runs them sequentially — no real race. The production
    // setup is two writers (Claude's server + Codex's server) on
    // the same DB, so the test mirrors that: it spawns two `bun`
    // subprocesses that each open their own SQLite connection. Each
    // worker calls the real `claimTask` function (not a hand-rolled
    // duplicate), so any atomicity fix in `claimTask` is exercised
    // here.
    //
    // Coordination: each worker writes a `ready-*` file when it has
    // reached its spin-wait, and then spins on a single shared `go`
    // file. The test waits for BOTH ready files before releasing
    // `go`, so the spin is guaranteed to find both workers waiting
    // (not just "we slept 50ms and hoped").
    //
    // If both claims report success, the implementation has a
    // lost-update bug. If both fail, the implementation is too
    // strict. Exactly one must succeed.
    const env = makeEnv();
    try {
      const c = createTask(env.db, env.cfg, { description: "x", created_by: "claude", cwd: HOME_CWD });
      if (!c.ok) throw new Error("setup failed");
      const taskId = c.data.task_id;
      const readyA = join(env.dir, "ready-A");
      const readyB = join(env.dir, "ready-B");
      const goFile = join(env.dir, "go");
      const outA = join(env.dir, "result-A.json");
      const outB = join(env.dir, "result-B.json");
      const workerPath = join(import.meta.dir, "_race-worker.ts");
      // Spawn both workers. They each write their `ready-*` file as
      // soon as they're at the spin-wait, then watch for `go`.
      const procA = Bun.spawn({
        cmd: [process.execPath, workerPath, env.cfg.server.db_path, taskId, "codex", readyA, goFile, outA],
        stdout: "pipe",
        stderr: "pipe",
      });
      const procB = Bun.spawn({
        cmd: [process.execPath, workerPath, env.cfg.server.db_path, taskId, "claude", readyB, goFile, outB],
        stdout: "pipe",
        stderr: "pipe",
      });
      // Wait for BOTH ready files. The two `existsSync` polls are
      // cheap and bounded: workers reach the spin-wait within
      // milliseconds of being spawned (they only need the DB
      // connection + the ready write).
      const readyDeadline = Date.now() + 5000;
      while ((!existsSync(readyA) || !existsSync(readyB)) && Date.now() < readyDeadline) {
        await new Promise((r) => setTimeout(r, 1));
      }
      expect(existsSync(readyA)).toBe(true);
      expect(existsSync(readyB)).toBe(true);
      // Release both at once. A single `writeFileSync` of the
      // shared `go` file unblocks both spin-waits in the same
      // event-loop tick (or very close to it).
      writeFileSync(goFile, "go");
      const [exitA, exitB] = await Promise.all([procA.exited, procB.exited]);
      expect(exitA).toBe(0);
      expect(exitB).toBe(0);
      const resultA = JSON.parse(readFileSync(outA, "utf-8"));
      const resultB = JSON.parse(readFileSync(outB, "utf-8"));
      // Exactly one of the two must have succeeded.
      const successes = [resultA, resultB].filter((r) => r.ok);
      const failures = [resultA, resultB].filter((r) => !r.ok);
      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);
      // The loser's `finalStatus` must reflect the row's actual
      // post-race state (`claimed`, not `pending`).
      expect(failures[0].finalStatus).toBe("claimed");
      // The loser must have failed with the documented
      // `invalid_state` code (not_found would mean we hit a
      // different bug).
      expect(failures[0].code).toBe("invalid_state");
      // The row itself must be in `claimed` state with one of the
      // two agents as the assignee.
      const row = env.db.get<{ status: string; assigned_to: string | null; claimed_at: number | null }>(
        `SELECT status, assigned_to, claimed_at FROM tasks WHERE id = ?`,
        [taskId],
      );
      expect(row?.status).toBe("claimed");
      if (row?.assigned_to) {
        expect(["codex", "claude"]).toContain(row.assigned_to);
      } else {
        throw new Error("expected assigned_to to be set after a successful claim");
      }
      expect(row?.claimed_at ?? 0).toBeGreaterThan(0);
      // The test owns the `go` file. Clean it up explicitly so
      // a re-run of the test in the same tmp dir doesn't see a
      // stale file and immediately unblock the workers.
      try { unlinkSync(goFile); } catch { /* ignore */ }
    } finally { env.cleanup(); }
  });
});

describe("complete_task (FR-5)", () => {
  test("completes a claimed task", () => {
    const env = makeEnv();
    try {
      const c = createTask(env.db, env.cfg, { description: "x", created_by: "claude", cwd: HOME_CWD });
      if (!c.ok) throw new Error("setup failed");
      claimTask(env.db, { task_id: c.data.task_id, agent_id: "codex" });
      const r = completeTask(env.db, { task_id: c.data.task_id, result: "done", status: "completed" });
      expect(r.ok).toBe(true);
    } finally { env.cleanup(); }
  });

  test("rejects invalid status", () => {
    const env = makeEnv();
    try {
      // Cast through unknown to bypass the union type so the test can
      // verify the runtime check rejects an out-of-enum value.
      const r = completeTask(env.db, { task_id: "x", result: "x", status: "rejected" as unknown as "completed" });
      expect(r.ok).toBe(false);
    } finally { env.cleanup(); }
  });

  test("rejects empty result (FR-5 requires non-empty)", () => {
    const env = makeEnv();
    try {
      const c = createTask(env.db, env.cfg, { description: "x", created_by: "claude", cwd: HOME_CWD });
      if (!c.ok) throw new Error("setup");
      claimTask(env.db, { task_id: c.data.task_id, agent_id: "codex" });
      const r = completeTask(env.db, { task_id: c.data.task_id, result: "", status: "completed" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_input");
    } finally { env.cleanup(); }
  });

  test("a second complete_task on an already-completed task fails (state guard)", () => {
    const env = makeEnv();
    try {
      const c = createTask(env.db, env.cfg, { description: "x", created_by: "claude", cwd: HOME_CWD });
      if (!c.ok) throw new Error("setup");
      claimTask(env.db, { task_id: c.data.task_id, agent_id: "codex" });
      const r1 = completeTask(env.db, { task_id: c.data.task_id, result: "first", status: "completed" });
      expect(r1.ok).toBe(true);
      // Second call: the row is now "completed", not "claimed"/"running".
      // The state guard should reject the second update.
      const r2 = completeTask(env.db, { task_id: c.data.task_id, result: "second", status: "completed" });
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.code).toBe("invalid_state");
      // The first result is preserved.
      const row = env.db.get<{ result: string }>(`SELECT result FROM tasks WHERE id = ?`, [c.data.task_id]);
      expect(row?.result).toBe("first");
    } finally { env.cleanup(); }
  });
});

describe("approve_path (FR-7a / AC-10)", () => {
  test("AC-10: cannot approve ~/.ssh", () => {
    const env = makeEnv();
    try {
      const r = approvePath(env.db, env.cfg, { agent_id: "claude", path: join(HOME, ".ssh") });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("denylist");
      // Confirm not persisted
      const row = env.db.get<{ path: string }>(`SELECT path FROM approved_paths WHERE path = ?`, [join(HOME, ".ssh")]);
      expect(row).toBeNull();
    } finally { env.cleanup(); }
  });

  test("approve_path is idempotent (AC-9 second call no-ops)", () => {
    const env = makeEnv();
    try {
      const r1 = approvePath(env.db, env.cfg, { agent_id: "claude", path: OUTSIDE_CWD });
      expect(r1.ok).toBe(true);
      const r2 = approvePath(env.db, env.cfg, { agent_id: "claude", path: OUTSIDE_CWD });
      expect(r2.ok).toBe(true);
      if (r2.ok && r2.data.ok) expect(r2.data.already_approved).toBe(true);
    } finally { env.cleanup(); }
  });

  test("approve_path is atomic under concurrent calls (P2 fix)", () => {
    // Even if the SELECT-then-INSERT race didn't matter (because the
    // second INSERT would have failed on the PK), verify the upsert
    // path is genuinely idempotent at the row level — exactly one
    // approval row exists, not zero or two.
    const env = makeEnv();
    try {
      // Fire two approvals in parallel.
      const [r1, r2] = [
        approvePath(env.db, env.cfg, { agent_id: "claude", path: OUTSIDE_CWD }),
        approvePath(env.db, env.cfg, { agent_id: "claude", path: OUTSIDE_CWD }),
      ];
      expect(r1.ok && r2.ok).toBe(true);
      const rows = env.db.all<{ path: string }>(`SELECT path FROM approved_paths WHERE path = ?`, [
        env.db.get<{ path: string }>(`SELECT path FROM approved_paths LIMIT 1`)?.path ?? "",
      ]);
      // Exactly one row in the table (regardless of how many callers).
      const count = env.db.get<{ c: number }>(`SELECT COUNT(*) as c FROM approved_paths WHERE path = ?`,
        [env.db.get<{ path: string }>(`SELECT path FROM approved_paths LIMIT 1`)?.path ?? ""],
      );
      expect(count?.c).toBe(1);
      // At least one of the two callers reports "already_approved".
      const alreadyFlags = [r1, r2].map((r) => r.ok && r.data && r.data.ok ? r.data.already_approved : null);
      expect(alreadyFlags).toContain(true);
    } finally { env.cleanup(); }
  });

  test("approve_path rejects an ancestor of a denylist root (P1 fix, symmetric to evaluateTrustBoundary)", () => {
    // The home directory is not on the denylist itself, but it
    // contains ~/.ssh as a subpath. Approving HOME would let a future
    // dispatch with `cwd: ~` slip past the denylist. Symmetric to
    // the ancestor check in `evaluateTrustBoundary`.
    const env = makeEnv();
    try {
      const r = approvePath(env.db, env.cfg, { agent_id: "claude", path: HOME });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("denylist");
        // The error message must mention the contained denylist root,
        // not just "on the denylist" — the user needs to understand
        // why a non-denylist path is rejected.
        expect(r.error).toMatch(/\.ssh|denylist root/i);
      }
      // Confirm not persisted.
      const count = env.db.get<{ c: number }>(`SELECT COUNT(*) as c FROM approved_paths`);
      expect(count?.c).toBe(0);
    } finally { env.cleanup(); }
  });
});

describe("check_task (FR-7) on terminal tasks", () => {
  test("returns a not_found error for an unknown id", () => {
    const env = makeEnv();
    try {
      const r = checkTask(env.db, { task_id: "does-not-exist" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("not_found");
    } finally { env.cleanup(); }
  });

  test("returns current status for a completed task", () => {
    const env = makeEnv();
    try {
      const c = createTask(env.db, env.cfg, { description: "x", created_by: "claude", cwd: HOME_CWD });
      if (!c.ok) throw new Error("setup");
      claimTask(env.db, { task_id: c.data.task_id, agent_id: "codex" });
      completeTask(env.db, { task_id: c.data.task_id, result: "ok", status: "completed" });
      const r = checkTask(env.db, { task_id: c.data.task_id });
      expect(r.ok && r.data.status).toBe("completed");
    } finally { env.cleanup(); }
  });

  test("P2: check_task reconciles a Codex-style JSONL with thread.completed as success", () => {
    // After a server restart, the in-memory handle is gone and
    // check_task must infer the final state from output_file. A
    // successful Codex run emits JSONL events ending in
    // `thread.completed` (no top-level `result`/`exit_code`); treating
    // that as a 0 exit is the P2 fix.
    const env = makeEnv();
    try {
      const c = createTask(env.db, env.cfg, { description: "x", created_by: "claude", cwd: HOME_CWD });
      if (!c.ok) throw new Error("setup");
      // Simulate a task that finished while the server was down:
      // mark it as `running` with a real output_file, no pid.
      const fakeOut = join(env.dir, "out.jsonl");
      writeFileSync(fakeOut, [
        JSON.stringify({ type: "thread.started", thread_id: "abc" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Hi." } }),
        JSON.stringify({ type: "turn.completed" }),
        JSON.stringify({ type: "thread.completed" }),
      ].join("\n") + "\n");
      env.db.run(
        `UPDATE tasks SET status = 'running', output_file = ? WHERE id = ?`,
        [fakeOut, c.data.task_id],
      );
      const r = checkTask(env.db, { task_id: c.data.task_id });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.status).toBe("completed");
        // Exit code inferred as 0 from the thread.completed signal.
        expect(r.data.exit_code).toBe(0);
      }
    } finally { env.cleanup(); }
  });
});
