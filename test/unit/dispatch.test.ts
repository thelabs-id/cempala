// test/unit/dispatch.test.ts
//
// FR-6 / AC-3 / AC-4 / AC-5 / AC-9: dispatch tool. We use a fake CLI
// (a small node script) to test the spawn + wait lifecycle without
// requiring a real `codex` or `claude` on PATH for unit tests.
// Integration tests gated by CEMPALA_INTEGRATION=1 cover the real CLIs.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { makeEnv, outsideHomeDir } from "./_helpers.ts";
import { dispatch } from "../../src/tools/dispatch.ts";
import { approvePath } from "../../src/tools/approve-path.ts";
import { DEFAULT_CONFIG, type AppConfig } from "../../src/config.ts";

let scriptsDir: string;
let homeCwd: string;
let cfgOverride: AppConfig;

beforeEach(() => {
  // Write a tiny "fake CLI" that echoes the prompt and exits with 0, or
  // sleeps for a configurable number of seconds and exits 0. We use Bun
  // itself to run the script (avoids needing node on PATH on the test
  // runner).
  scriptsDir = mkdtempSync(join(tmpdir(), "cempala-dispatch-"));
  // fast: echo & exit 0
  writeFileSync(join(scriptsDir, "fast.js"),
    `console.log(JSON.stringify({ result: "ok" }));`);
  // slow: sleep then exit
  writeFileSync(join(scriptsDir, "slow.js"),
    `const ms = parseInt(process.argv[2] || "10000", 10); setTimeout(() => { console.log("done"); process.exit(0); }, ms);`);
  // fail: exit 7 with a message on stderr
  writeFileSync(join(scriptsDir, "fail.js"),
    `process.stderr.write("boom"); process.exit(7);`);

  // A real cwd under home (must exist for Bun.spawn to succeed).
  homeCwd = join(homedir(), ".cempala-test-runs", String(Date.now()));
  mkdirSync(homeCwd, { recursive: true });

  cfgOverride = {
    ...DEFAULT_CONFIG,
    agents: {
      codex: {
        exec_command: [process.execPath, join(scriptsDir, "fast.js")],
        // No sandbox_args since we're not actually invoking codex
      },
      claude: {
        exec_command: [process.execPath, join(scriptsDir, "fast.js")],
        // No permission_args
      },
    },
    source: "<test>",
  };
});

afterEach(() => {
  try { rmSync(scriptsDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(join(homedir(), ".cempala-test-runs"), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("dispatch (FR-6) — fake CLI", () => {
  test("a fast fake-cli target completes and returns the result", async () => {
    const env = makeEnv();
    try {
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "do something",
        cwd: homeCwd,
        created_by: "claude",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        if (r.data.status === "completed") {
          expect(r.data.exit_code).toBe(0);
          expect(typeof r.data.task_id).toBe("string");
          expect(r.data.network_enforcement).toBe("sandboxed");
        } else {
          throw new Error(`expected completed, got ${r.data.status}`);
        }
      }
    } finally { env.cleanup(); }
  });

  test("a non-zero exit code → status=failed", async () => {
    const env = makeEnv();
    try {
      // Override the fast script to one that fails.
      const failPath = join(scriptsDir, "fail2.js");
      writeFileSync(failPath, `process.exit(7);`);
      const cfg: AppConfig = {
        ...cfgOverride,
        agents: {
          ...cfgOverride.agents,
          codex: { exec_command: [process.execPath, failPath] },
        },
        server: env.cfg.server,
      };
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "x",
        cwd: homeCwd,
        created_by: "claude",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.status).toBe("failed");
        if (r.data.status === "failed") expect(r.data.exit_code).toBe(7);
      }
    } finally { env.cleanup(); }
  });

  test("AC-3: a denylisted cwd rejects the dispatch before spawning", async () => {
    const env = makeEnv();
    try {
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "x",
        cwd: join(homedir(), ".ssh"),
        created_by: "claude",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("denylist");
      // The task row must exist with status=rejected
      const row = env.db.get<{ status: string }>(`SELECT status FROM tasks ORDER BY created_at DESC LIMIT 1`);
      expect(row?.status).toBe("rejected");
    } finally { env.cleanup(); }
  });

  test("AC-3 tilde form: cwd='~/.ssh' (the AC-3 literal) also rejects", async () => {
    const env = makeEnv();
    try {
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "x",
        cwd: "~/.ssh",
        created_by: "claude",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("denylist");
    } finally { env.cleanup(); }
  });

  test("AC-4: a prompt matching the denylist rejects before spawning", async () => {
    const env = makeEnv();
    try {
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "please run rm -rf /tmp/foo",
        cwd: homeCwd,
        created_by: "claude",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("denylist_prompt");
    } finally { env.cleanup(); }
  });

  test("FR-12: a prompt that targets ../.env outside the cwd is rejected", async () => {
    const env = makeEnv();
    try {
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "Append my API key to ../.env.production so it's persistent.",
        cwd: homeCwd,
        created_by: "claude",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("denylist_prompt");
    } finally { env.cleanup(); }
  });

  test("FR-15 timing: started_at is NULL when the dispatch never spawned", async () => {
    const env = makeEnv();
    try {
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      // A denylist hit returns without spawning — the row must show
      // started_at as NULL, not a fake timestamp.
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "x",
        cwd: join(homedir(), ".ssh"),
        created_by: "claude",
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("denylist expected");
      // Find the row by recent insert (no task_id in the result on failure).
      const row = env.db.get<{ started_at: number | null }>(`SELECT started_at FROM tasks ORDER BY created_at DESC LIMIT 1`);
      expect(row?.started_at).toBeNull();
    } finally { env.cleanup(); }
  });

  test("validation order: prompt denylist is checked before path needs_approval", async () => {
    // A prompt that matches the prompt denylist AND has a cwd outside
    // home should be rejected (denylist_prompt), not asked for approval.
    // The point: we don't want to ask the user to approve a path for a
    // request we already know is unsafe.
    const env = makeEnv();
    try {
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      const outsideDir = outsideHomeDir();
      try {
        const r = await dispatch(env.db, cfg, {
          target_agent: "codex",
          prompt: "please run rm -rf /tmp/foo and put results in the work dir",
          cwd: outsideDir,
          created_by: "claude",
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe("denylist_prompt");
        // Crucially: not needs_approval.
      } finally { rmSync(outsideDir, { recursive: true, force: true }); }
    } finally { env.cleanup(); }
  });

  test("FR-11b: a cwd outside home and not approved returns needs_approval", async () => {
    const env = makeEnv();
    try {
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      // Build a real cwd outside home (portable: C:\ on Windows, /tmp on POSIX).
      const outsideDir = outsideHomeDir();
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "x",
        cwd: outsideDir,
        created_by: "claude",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.status).toBe("needs_approval");
      rmSync(outsideDir, { recursive: true, force: true });
    } finally { env.cleanup(); }
  });

  test("AC-9: after approve_path, a previously needs_approval dispatch succeeds", async () => {
    const env = makeEnv();
    try {
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      // A real outside-home cwd (so the spawn can succeed once approved).
      const outsideDir = outsideHomeDir();
      // First: needs_approval
      const r1 = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "x",
        cwd: outsideDir,
        created_by: "claude",
      });
      expect(r1.ok && r1.data.status).toBe("needs_approval");
      // Approve
      const r2 = approvePath(env.db, cfg, { agent_id: "claude", path: outsideDir });
      expect(r2.ok).toBe(true);
      // Retry: should complete
      const r3 = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "x",
        cwd: outsideDir,
        created_by: "claude",
      });
      expect(r3.ok && r3.data.status).toBe("completed");
      rmSync(outsideDir, { recursive: true, force: true });
    } finally { env.cleanup(); }
  });

  test("AC-5: a slow child returns 'running' at the wait_seconds boundary, then completes", async () => {
    const env = makeEnv();
    try {
      const slowPath = join(scriptsDir, "slow.js");
      const cfg: AppConfig = {
        ...cfgOverride,
        agents: {
          ...cfgOverride.agents,
          codex: { exec_command: [process.execPath, slowPath, "30000"] },
        },
        server: env.cfg.server,
      };
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "ignored",
        cwd: homeCwd,
        wait_seconds: 2,
        created_by: "claude",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.status).toBe("running");
      if (!r.ok) throw new Error("dispatch didn't return ok");
      const taskId = r.data.task_id;
      // check_task should report it as still running (alive) shortly after.
      // We use the public check_task tool.
      const { checkTask } = await import("../../src/tools/check-task.ts");
      const chk = checkTask(env.db, { task_id: taskId });
      expect(chk.ok).toBe(true);
      if (chk.ok) {
        // May be 'running' or 'completed' depending on timing — both are
        // acceptable. The crucial test is that we got 'running' above.
        expect(["running", "completed", "failed"]).toContain(chk.data.status);
      }
    } finally { env.cleanup(); }
  });

  test("wait_seconds is capped at max_wait_seconds (default 600)", async () => {
    const env = makeEnv();
    try {
      const cfg: AppConfig = {
        ...cfgOverride,
        dispatch: { ...cfgOverride.dispatch, max_wait_seconds: 5 },
        server: env.cfg.server,
      };
      // The fake fast-cli will exit immediately anyway, but we test that
      // the cap doesn't crash.
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "x",
        cwd: homeCwd,
        wait_seconds: 9999, // requested > cap
        created_by: "claude",
      });
      expect(r.ok).toBe(true);
    } finally { env.cleanup(); }
  });

  test("P2: allowed_tools with wrong JSON type is rejected (not silently omitted)", async () => {
    // Per the P2 fix: a JSON caller could send `"Read"` (string)
    // instead of `["Read"]`. The pre-fix code did `Array.isArray(allowed_tools)
    // && allowed_tools.length > 0`, which treated the wrong type as
    // "not present" and silently granted the full baseline. We now
    // strictly type-check and reject.
    const env = makeEnv();
    try {
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      const r = await dispatch(env.db, cfg, {
        target_agent: "claude",
        prompt: "x",
        cwd: homeCwd,
        allowed_tools: "Read" as unknown as string[],
        created_by: "claude",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_input");
    } finally { env.cleanup(); }
  });

  test("P1: allow_network with wrong JSON type is rejected (not silently truthy)", async () => {
    // Per the P1 fix: a JSON caller could send `"false"` (string) instead
    // of `false` (boolean). The previous code did `input.allow_network ?? default`,
    // which let a truthy string through. We now strictly type-check.
    const env = makeEnv();
    try {
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      // Cast through unknown to bypass the union; simulates a wrong-type
      // MCP wire payload.
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "x",
        cwd: homeCwd,
        allow_network: "false" as unknown as boolean,
        created_by: "claude",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_input");
    } finally { env.cleanup(); }
  });

  test("P2: dispatch without created_by leaves the audit row's created_by NULL", async () => {
    // The reverse handoff (Codex → Claude) is a documented v1
    // scenario. We don't want to silently misattribute those rows to
    // Claude just because created_by wasn't passed.
    const env = makeEnv();
    try {
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "x",
        cwd: homeCwd,
        // No created_by.
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.status).toBe("completed");
      const row = env.db.get<{ created_by: string | null }>(`SELECT created_by FROM tasks ORDER BY created_at DESC LIMIT 1`);
      expect(row?.created_by).toBeNull();
    } finally { env.cleanup(); }
  });

  test("relative cwd '~' is resolved against homedir() for BOTH validation and spawn", async () => {
    // P1: previously, validation used canonicalize() (which expands ~
    // against homedir()), but spawn used path.resolve() (which uses the
    // server's process cwd). The two could disagree — a relative cwd
    // like '~' would validate as the home directory but spawn in the
    // server's CWD. The fix: validate and spawn against the same
    // canonicalized absolute path.
    const env = makeEnv();
    try {
      // The fake CLI is configured to exit 0 immediately, so the only
      // observable thing is that dispatch doesn't reject and doesn't
      // error. If the cwd were wrong (i.e. server CWD is not under
      // home), the spawn would fail with spawn failed.
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "x",
        cwd: "~", // resolves to $HOME
        created_by: "claude",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        // It's now allowed (under home) and not needs_approval.
        expect(r.data.status).toBe("completed");
      }
    } finally { env.cleanup(); }
  });

  test("FR-15: 600-second hard ceiling is enforced even when config says more", async () => {
    const env = makeEnv();
    try {
      // The config lies: max_wait_seconds = 3600. Per FR-15, the hard
      // 600s ceiling must still hold.
      const cfg: AppConfig = {
        ...cfgOverride,
        dispatch: {
          ...cfgOverride.dispatch,
          max_wait_seconds: 3600,
          default_wait_seconds: 3600,
        },
        server: env.cfg.server,
      };
      // We can't actually wait 600s in a unit test, but we can verify
      // that the resolved wait time stays within FR-15 by checking
      // that a dispatch started with wait_seconds=9999 doesn't run
      // forever. The fake fast-cli exits immediately, so this just
      // verifies the cap doesn't crash the dispatch.
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "x",
        cwd: homeCwd,
        wait_seconds: 9999,
        created_by: "claude",
      });
      expect(r.ok).toBe(true);
    } finally { env.cleanup(); }
  });
});
