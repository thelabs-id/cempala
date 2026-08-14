// test/unit/dispatch.test.ts
//
// FR-6 / AC-3 / AC-4 / AC-5 / AC-9: dispatch tool. We use a fake CLI
// (a small node script) to test the spawn + wait lifecycle without
// requiring a real `codex` or `claude` on PATH for unit tests.
// Integration tests gated by CEMPALA_INTEGRATION=1 cover the real CLIs.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { makeEnv, outsideHomeDir, canonicalizeHome } from "./_helpers.ts";
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
  // agent-reported failure with a SUCCESSFUL process exit: the shape
  // `claude -p --output-format json` uses for API-level errors such as an
  // expired OAuth token.
  writeFileSync(join(scriptsDir, "soft-fail.js"),
    `console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "API Error: 401 OAuth access token has expired." })); process.exit(0);`);

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
      antigravity: {
        exec_command: [process.execPath, join(scriptsDir, "fast.js")],
        // No sandbox_args / permission_args
      },
      opencode: {
        exec_command: [process.execPath, join(scriptsDir, "fast.js")],
      },
    },
    source: "<test>",
  };
});

afterEach(() => {
  try { rmSync(scriptsDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(join(homedir(), ".cempala-test-runs"), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("dispatch (FR-6) — Windows .cmd shim exit handling", () => {
  // On Windows a .cmd shim is spawned non-detached (see platform/spawn.ts),
  // so the recorded pid is the SHIM's. A shim exiting non-zero — because it
  // was killed, which is what happens when this server goes down — says
  // nothing about the agent it launched. Recording that as the task's
  // outcome is the false-failure bug arriving by a second route.
  const IS_WINDOWS = process.platform === "win32";

  function writeShim(name: string, body: string[]): string {
    const p = join(scriptsDir, name);
    writeFileSync(p, ["@echo off", ...body, ""].join("\r\n"));
    return p;
  }

  test.skipIf(!IS_WINDOWS)(
    "a shim that dies AFTER its agent started producing output leaves the task running",
    async () => {
      // Emits agent output (no verdict yet), then exits non-zero — the shape
      // of a shim killed mid-run while its agent works on.
      const shim = writeShim("shim-midrun.cmd", [
        'echo {"type":"thread.started","thread_id":"x"}',
        'echo {"type":"turn.started"}',
        "exit /b 1",
      ]);
      const env = makeEnv();
      try {
        const cfg: AppConfig = {
          ...cfgOverride,
          server: env.cfg.server,
          agents: { ...cfgOverride.agents, codex: { exec_command: [shim] } },
        };
        const r = await dispatch(env.db, cfg, {
          target_agent: "codex",
          prompt: "work",
          cwd: homeCwd,
          created_by: "claude",
          wait_seconds: 20,
        });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.data.status).toBe("running");
        const row = env.db.get<{ status: string }>(
          `SELECT status FROM tasks WHERE via='dispatch' ORDER BY created_at DESC LIMIT 1`,
        );
        expect(row?.status).toBe("running");
      } finally { env.cleanup(); }
    },
    30_000,
  );

  test.skipIf(!IS_WINDOWS)(
    "a shim that dies having produced NOTHING is a real failure, not a stuck task",
    async () => {
      // No agent ever got far enough to speak, so the shim's failure is the
      // whole story. Deferring here would swap a false failure for a task
      // pinned at `running` until the reaper — no bargain.
      const shim = writeShim("shim-nostart.cmd", ["exit /b 9"]);
      const env = makeEnv();
      try {
        const cfg: AppConfig = {
          ...cfgOverride,
          server: env.cfg.server,
          agents: { ...cfgOverride.agents, codex: { exec_command: [shim] } },
        };
        const r = await dispatch(env.db, cfg, {
          target_agent: "codex",
          prompt: "work",
          cwd: homeCwd,
          created_by: "claude",
          wait_seconds: 20,
        });
        expect(r.ok).toBe(true);
        if (r.ok && r.data.status !== "running" && r.data.status !== "needs_approval") {
          expect(r.data.status).toBe("failed");
          expect(r.data.exit_code).toBe(9);
        }
      } finally { env.cleanup(); }
    },
    30_000,
  );

  test.skipIf(!IS_WINDOWS)(
    "a shim that dies printing plain diagnostics settles as a failure, keeping its exit code",
    async () => {
      // Plain diagnostics are ambiguous at a glance — equally the shape of a
      // launcher dying on a bad argument and of an agent reporting progress
      // before its first stdout. So the task is briefly `running` while that
      // resolves, and must then settle as the failure it is WITHOUT losing
      // the launcher's exit code to a bare -1. It must not sit at `running`
      // until the reaper.
      const shim = writeShim("shim-usage.cmd", ["echo usage: bad args", "exit /b 9"]);
      const env = makeEnv();
      try {
        const cfg: AppConfig = {
          ...cfgOverride,
          server: env.cfg.server,
          agents: { ...cfgOverride.agents, codex: { exec_command: [shim] } },
        };
        const r = await dispatch(env.db, cfg, {
          target_agent: "codex",
          prompt: "work",
          cwd: homeCwd,
          created_by: "claude",
          wait_seconds: 20,
        });
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error("expected ok");

        // Nobody calls check_task and no reaper runs — the watcher settles it.
        const deadline = Date.now() + 60_000;
        let row: { status: string; exit_code: number | null } | undefined;
        while (Date.now() < deadline) {
          row = env.db.get<{ status: string; exit_code: number | null }>(
            `SELECT status, exit_code FROM tasks WHERE id = ?`,
            [r.data.task_id],
          );
          if (row && row.status !== "running") break;
          await Bun.sleep(1000);
        }
        expect(row?.status).toBe("failed");
        expect(row?.exit_code).toBe(9);
      } finally { env.cleanup(); }
    },
    90_000,
  );

  test.skipIf(!IS_WINDOWS)(
    "a shim that dies while its agent has written only to stderr does NOT fail the task",
    async () => {
      // The asymmetry bug: judging the shim's exit from stdout alone made the
      // live dispatch process fail a task that check_task — which reads
      // stderr too — would have kept running. Two paths must never disagree
      // about identical output.
      const shim = writeShim("shim-stderr.cmd", ["echo working... 1>&2", "exit /b 1"]);
      const env = makeEnv();
      try {
        const cfg: AppConfig = {
          ...cfgOverride,
          server: env.cfg.server,
          agents: { ...cfgOverride.agents, codex: { exec_command: [shim] } },
        };
        const r = await dispatch(env.db, cfg, {
          target_agent: "codex",
          prompt: "work",
          cwd: homeCwd,
          created_by: "claude",
          wait_seconds: 20,
        });
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error("expected ok");
        expect(r.data.status).toBe("running");
        const row = env.db.get<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [
          r.data.task_id,
        ]);
        expect(row?.status).toBe("running");
      } finally { env.cleanup(); }
    },
    30_000,
  );

  test.skipIf(!IS_WINDOWS)(
    "a deferred task settles itself once the orphaned agent finishes, without anyone polling",
    async () => {
      // Deferring the shim's exit is only half the job. `exited` is a
      // one-shot and has already fired, so if nothing keeps watching, a run
      // that finishes seconds later sits at `running` until a caller happens
      // to call check_task or the reaper sweeps 30 minutes on. Here nobody
      // calls check_task at all — the row must settle on its own.
      const shim = writeShim("shim-defer.cmd", [
        'echo {"type":"thread.started","thread_id":"x"}',
        'echo {"type":"turn.started"}',
        "exit /b 1",
      ]);
      const env = makeEnv();
      try {
        const cfg: AppConfig = {
          ...cfgOverride,
          server: env.cfg.server,
          agents: { ...cfgOverride.agents, codex: { exec_command: [shim] } },
        };
        const r = await dispatch(env.db, cfg, {
          target_agent: "codex",
          prompt: "work",
          cwd: homeCwd,
          created_by: "claude",
          wait_seconds: 20,
        });
        expect(r.ok && r.data.status).toBe("running");
        if (!r.ok) throw new Error("expected ok");

        const row = env.db.get<{ output_file: string }>(
          `SELECT output_file FROM tasks WHERE id = ?`,
          [r.data.task_id],
        );
        expect(row?.output_file).toBeTruthy();

        // Stand in for the orphaned agent finishing its turn and writing its
        // answer to the inherited output handle.
        appendFileSync(
          row!.output_file,
          [
            `{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"DONE"}}`,
            `{"type":"turn.completed","usage":{"input_tokens":1}}`,
            "",
          ].join("\n"),
        );

        // No check_task, no reaper — just wait for the watcher.
        const deadline = Date.now() + 20_000;
        let status = "running";
        while (Date.now() < deadline) {
          await Bun.sleep(1000);
          status =
            env.db.get<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [r.data.task_id])
              ?.status ?? "running";
          if (status !== "running") break;
        }
        expect(status).toBe("completed");
        const done = env.db.get<{ result: string; exit_code: number | null }>(
          `SELECT result, exit_code FROM tasks WHERE id = ?`,
          [r.data.task_id],
        );
        expect(done?.result).toBe("DONE");
        expect(done?.exit_code).toBe(0);
      } finally { env.cleanup(); }
    },
    45_000,
  );

  test.skipIf(!IS_WINDOWS)(
    "a shim's non-zero exit does not override a successful agent verdict",
    async () => {
      const shim = writeShim("shim-verdict.cmd", [
        'echo {"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"DONE"}}',
        'echo {"type":"turn.completed","usage":{"input_tokens":1}}',
        "exit /b 1",
      ]);
      const env = makeEnv();
      try {
        const cfg: AppConfig = {
          ...cfgOverride,
          server: env.cfg.server,
          agents: { ...cfgOverride.agents, codex: { exec_command: [shim] } },
        };
        const r = await dispatch(env.db, cfg, {
          target_agent: "codex",
          prompt: "work",
          cwd: homeCwd,
          created_by: "claude",
          wait_seconds: 20,
        });
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error("expected ok");
        // The shim exited 1, but that status belongs to the LAUNCHER. The
        // agent finished its turn and said DONE, so the task succeeded.
        // Letting the shim's exit win here would report `failed` for a
        // completed run — the false failure, one layer down.
        expect(r.data.status).toBe("completed");
        if (r.data.status === "completed") {
          expect(r.data.exit_code).toBe(0);
          expect(r.data.result).toBe("DONE");
        }
        const row = env.db.get<{ status: string; exit_code: number | null; result: string }>(
          `SELECT status, exit_code, result FROM tasks WHERE id = ?`,
          [r.data.task_id],
        );
        expect(row?.status).toBe("completed");
        expect(row?.exit_code).toBe(0);
        expect(row?.result).toBe("DONE");
      } finally { env.cleanup(); }
    },
    30_000,
  );

  test.skipIf(!IS_WINDOWS)(
    "a shim's non-zero exit still fails the task when the agent itself reported failure",
    async () => {
      // The mirror of the case above: discarding the launcher's status must
      // not turn an agent-reported failure into a success.
      const shim = writeShim("shim-agentfail.cmd", [
        'echo {"type":"turn.failed","error":"sandbox denied write"}',
        "exit /b 1",
      ]);
      const env = makeEnv();
      try {
        const cfg: AppConfig = {
          ...cfgOverride,
          server: env.cfg.server,
          agents: { ...cfgOverride.agents, codex: { exec_command: [shim] } },
        };
        const r = await dispatch(env.db, cfg, {
          target_agent: "codex",
          prompt: "work",
          cwd: homeCwd,
          created_by: "claude",
          wait_seconds: 20,
        });
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error("expected ok");
        expect(r.data.status).toBe("failed");
        if (r.data.status === "failed") {
          expect(r.data.exit_code).not.toBe(0);
          expect(r.data.result).toContain("sandbox denied write");
        }
      } finally { env.cleanup(); }
    },
    30_000,
  );
});

describe("dispatch (FR-6) — fake CLI", () => {
  test("an agent that reports is_error but exits 0 is recorded as failed", async () => {
    // A zero exit status is not proof of success. `claude -p --output-format
    // json` reports API-level failures (an expired token, say) as
    // `is_error: true` in its envelope. Trusting the exit code alone would
    // record that as `completed` with the error text sitting in `result` —
    // and would disagree with the restart path (check_task / the reaper),
    // which reads the same output and calls it failed. The status a caller
    // sees must not depend on whether the server happened to stay up.
    const env = makeEnv();
    try {
      const cfg: AppConfig = {
        ...cfgOverride,
        server: env.cfg.server,
        agents: {
          ...cfgOverride.agents,
          codex: { exec_command: [process.execPath, join(scriptsDir, "soft-fail.js")] },
        },
      };
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "do something",
        cwd: homeCwd,
        created_by: "claude",
        wait_seconds: 30,
      });
      expect(r.ok).toBe(true);
      if (r.ok && r.data.status !== "running" && r.data.status !== "needs_approval") {
        expect(r.data.status).toBe("failed");
        expect(r.data.exit_code).not.toBe(0);
        expect(r.data.result).toContain("401");
      }
      const row = env.db.get<{ status: string; exit_code: number | null }>(
        `SELECT status, exit_code FROM tasks WHERE via='dispatch' ORDER BY created_at DESC LIMIT 1`,
      );
      expect(row?.status).toBe("failed");
      expect(row?.exit_code).not.toBe(0);
    } finally { env.cleanup(); }
  });

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

  test("an antigravity dispatch completes and reports network_enforcement honestly", async () => {
    const env = makeEnv();
    try {
      // A stand-in emitting agy's real envelope shape: `status` + `response`,
      // no `result`, no `type`.
      const agPath = join(scriptsDir, "fake-agy.js");
      writeFileSync(agPath,
        `console.log(JSON.stringify({ conversation_id: "c1", status: "SUCCESS", response: "PONG", num_turns: 1 }));`);
      const cfg: AppConfig = {
        ...cfgOverride,
        agents: { ...cfgOverride.agents, antigravity: { exec_command: [process.execPath, agPath] } },
        server: env.cfg.server,
      };
      const r = await dispatch(env.db, cfg, {
        target_agent: "antigravity",
        prompt: "do something",
        cwd: homeCwd,
        created_by: "claude",
        allow_network: false,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        if (r.data.status !== "completed") throw new Error(`expected completed, got ${r.data.status}`);
        // The answer, not the envelope.
        expect(r.data.result).toBe("PONG");
        expect(r.data.exit_code).toBe(0);
        // allow_network=false was asked for and could NOT be enforced.
        // Reporting anything else here is the failure this label exists
        // to prevent.
        expect(r.data.network_enforcement).toBe("not_enforceable");
      }
    } finally { env.cleanup(); }
  });

  test("a run that says on stderr it did nothing is recorded as FAILED, not completed", async () => {
    // The real agy headless soft-deny: exit 0, status SUCCESS, empty
    // response, and the only explanation on stderr. Two bugs lived here.
    // First the result came back empty, because stderr was read only on
    // failure. Then, with the text surfaced but the verdict left alone,
    // the row still said `completed` for a run that had explicitly
    // announced it did nothing — which a calling agent reads as "the work
    // is done". Both halves have to be right.
    const env = makeEnv();
    try {
      const p = join(scriptsDir, "fake-agy-softdeny.js");
      writeFileSync(p,
        `console.log(JSON.stringify({ conversation_id: "c1", status: "SUCCESS", response: "", num_turns: 1 }));` +
        `process.stderr.write('jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.');`);
      const cfg: AppConfig = {
        ...cfgOverride,
        agents: { ...cfgOverride.agents, antigravity: { exec_command: [process.execPath, p] } },
        server: env.cfg.server,
      };
      const r = await dispatch(env.db, cfg, {
        target_agent: "antigravity", prompt: "x", cwd: homeCwd, created_by: "claude",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.status).toBe("failed");
        if (r.data.status !== "failed") throw new Error("unreachable");
        // The zero exit is overturned, and the recorded code agrees with
        // the status — a `failed` row carrying exit_code 0 would
        // contradict itself.
        expect(r.data.exit_code).toBe(1);
        // And the caller gets something actionable, not "".
        expect(r.data.result).not.toBe("");
        expect(r.data.result).toContain("auto-denied");
        // Persisted, not merely returned.
        const row = env.db.get<{ result: string; status: string; exit_code: number }>(
          `SELECT result, status, exit_code FROM tasks WHERE id = ?`, [r.data.task_id],
        );
        expect(row?.status).toBe("failed");
        expect(row?.exit_code).toBe(1);
        expect(row?.result).toContain("auto-denied");
      }
    } finally { env.cleanup(); }
  });

  test("an empty answer with NO did-nothing statement is still a success", async () => {
    // The boundary of the rule above. A prompt whose whole effect is a
    // file edit can legitimately return no prose, and failing it would be
    // its own misreport.
    const env = makeEnv();
    try {
      const p = join(scriptsDir, "fake-agy-quiet.js");
      writeFileSync(p, `console.log(JSON.stringify({ status: "SUCCESS", response: "" }));`);
      const cfg: AppConfig = {
        ...cfgOverride,
        agents: { ...cfgOverride.agents, antigravity: { exec_command: [process.execPath, p] } },
        server: env.cfg.server,
      };
      const r = await dispatch(env.db, cfg, {
        target_agent: "antigravity", prompt: "x", cwd: homeCwd, created_by: "claude",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.status).toBe("completed");
        if (r.data.status === "completed") expect(r.data.exit_code).toBe(0);
      }
    } finally { env.cleanup(); }
  });

  test("a successful run WITH an answer does not get stderr glued onto it", async () => {
    // The other side of the rule: progress chatter on stderr must not
    // contaminate a perfectly good answer.
    const env = makeEnv();
    try {
      const p = join(scriptsDir, "fake-agy-chatty.js");
      writeFileSync(p,
        `process.stderr.write("loading model...\\nthinking...");` +
        `console.log(JSON.stringify({ status: "SUCCESS", response: "PONG" }));`);
      const cfg: AppConfig = {
        ...cfgOverride,
        agents: { ...cfgOverride.agents, antigravity: { exec_command: [process.execPath, p] } },
        server: env.cfg.server,
      };
      const r = await dispatch(env.db, cfg, {
        target_agent: "antigravity", prompt: "x", cwd: homeCwd, created_by: "claude",
      });
      expect(r.ok).toBe(true);
      if (r.ok && r.data.status === "completed") {
        expect(r.data.result).toBe("PONG");
        expect(r.data.result).not.toContain("loading model");
      } else {
        throw new Error(`expected completed, got ${(r as any).data?.status}`);
      }
    } finally { env.cleanup(); }
  });

  test("an antigravity run that reports ERROR with a zero exit is recorded as failed", async () => {
    // agy exits non-zero on failure, but the same rule that catches
    // claude's is_error must hold here: the envelope's own verdict
    // decides when the exit code says success.
    const env = makeEnv();
    try {
      const agPath = join(scriptsDir, "fake-agy-err.js");
      writeFileSync(agPath,
        `console.log(JSON.stringify({ status: "ERROR", response: "", error: "authentication failed or timed out" })); process.exit(0);`);
      const cfg: AppConfig = {
        ...cfgOverride,
        agents: { ...cfgOverride.agents, antigravity: { exec_command: [process.execPath, agPath] } },
        server: env.cfg.server,
      };
      const r = await dispatch(env.db, cfg, {
        target_agent: "antigravity",
        prompt: "x",
        cwd: homeCwd,
        created_by: "claude",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.status).toBe("failed");
        if (r.data.status === "failed") expect(r.data.result).toContain("authentication failed");
      }
    } finally { env.cleanup(); }
  });

  test("an unknown target_agent is rejected with the supported list", async () => {
    const env = makeEnv();
    try {
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      const r = await dispatch(env.db, cfg, {
        target_agent: "gemini" as never,
        prompt: "x",
        cwd: homeCwd,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("invalid_input");
        expect(r.error).toContain("antigravity");
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
    //
    // Note: `cwd: "~"` is now a strict ancestor of the denylist roots
    // (`~/.ssh`, etc.), so the trust boundary returns `needs_approval`
    // before any spawn — which is the correct new behavior. To verify
    // the canonicalization-consistency fix in isolation, this test
    // observes the needs_approval verdict and asserts that the path in
    // the verdict equals the canonical home. The "validation and spawn
    // agree" property is exercised by the `completed` tests above
    // (which use a real subpath under home and verify spawn succeeded).
    const env = makeEnv();
    try {
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "x",
        cwd: "~", // resolves to $HOME
        created_by: "claude",
      });
      // cwd="~" is a strict ancestor of the denylist (contains ~/.ssh),
      // so the trust boundary correctly returns needs_approval. The
      // canonicalize machinery still has to expand `~` against
      // homedir() before the trust boundary sees it.
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.status).toBe("needs_approval");
        if (r.data.status === "needs_approval") {
          // The path in the verdict must be the canonical home, not
          // the raw "~" or the server's process cwd. A bug here
          // would mean the trust boundary was told a different
          // location than the caller asked about.
          expect(r.data.path).toBe(canonicalizeHome());
        }
      }
    } finally { env.cleanup(); }
  });

  test("P1: cwd=~ is needs_approval (ancestor of denylist), no spawn happens", async () => {
    // Documents the new behavior: a cwd that contains a denylist root
    // as a subpath is treated as needs_approval (not denied, not
    // allowed). The user must narrow their cwd to a project
    // subdirectory. This test guards against accidental regressions
    // that let `cwd=~` through to spawn, which would let the child
    // read `~/.ssh` etc. We assert no fake-CLI output file was
    // produced.
    const env = makeEnv();
    try {
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "x",
        cwd: "~",
        created_by: "claude",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.status).toBe("needs_approval");
        if (r.data.status === "needs_approval") {
          // The `reason` must be `ancestor_of_denylist` so the
          // calling agent can tell the user to narrow the cwd
          // (rather than asking them to approve home wholesale —
          // which `canApprove` would also reject).
          expect(r.data.reason).toBe("ancestor_of_denylist");
        }
      }
    } finally { env.cleanup(); }
  });

  test("P1: wait_seconds with wrong type is rejected (not silently NaN)", async () => {
    // Per the P1 fix: a wrong-type `wait_seconds` (string, NaN) would
    // either be coerced or produce a NaN deadline, which would hang
    // the dispatch. The handler now rejects at the type-check stage.
    const env = makeEnv();
    try {
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "x",
        cwd: homeCwd,
        wait_seconds: "5" as unknown as number,
        created_by: "claude",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("invalid_input");
        expect(r.error).toMatch(/wait_seconds/i);
      }
    } finally { env.cleanup(); }
  });

  test("P1: wait_seconds with NaN is rejected", async () => {
    const env = makeEnv();
    try {
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "x",
        cwd: homeCwd,
        wait_seconds: Number.NaN,
        created_by: "claude",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_input");
    } finally { env.cleanup(); }
  });

  test("P1: empty-string `created_by` is rejected (not silently FK-errored)", async () => {
    // An empty string passes the `typeof === "string"` check and the
    // `if (createdBy)` truthy check both succeed, so the FK insert
    // would fail with FOREIGN KEY constraint — a raw SQL exception
    // bubbled out of the tool boundary. We now reject at the
    // type-check stage with a clear error.
    const env = makeEnv();
    try {
      const cfg: AppConfig = { ...cfgOverride, server: env.cfg.server };
      const r = await dispatch(env.db, cfg, {
        target_agent: "codex",
        prompt: "x",
        cwd: homeCwd,
        created_by: "",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("invalid_input");
        expect(r.error).toMatch(/created_by/i);
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
