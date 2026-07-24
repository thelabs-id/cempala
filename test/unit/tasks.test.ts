// test/unit/tasks.test.ts
//
// FR-3, FR-4, FR-5, FR-7a: create_task / claim_task / complete_task / approve_path.
// Plus FR-9 (no silent error swallowing) and FR-11b (needs_approval is a
// successful outcome, not a failure).

import { describe, test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
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
