// src/tools/dispatch.ts
//
// FR-6: the synchronous "do this now and tell me the result" path.
//
// Flow:
//   1. Insert a `tasks` row immediately (`via = "dispatch"`), then
//      validate `cwd` against the trust boundary and `prompt`/expected
//      command against the denylist:
//        - denylist hit (path or prompt) → set `status = rejected`,
//          return ok:true with the rejected descriptor. Nothing spawns.
//        - cwd outside the home directory and not covered by an
//          approved_paths root → set `status = needs_approval`, return
//          ok:true {status: "needs_approval", path, task_id}. Nothing
//          spawns.
//        - otherwise → set `status = running`, continue to step 2.
//   2. Spawn the target CLI **detached**, stdout+stderr redirected to
//      `output_file`. Set the child's cwd via Bun.spawn({ cwd }) (not via
//      a CLI flag — there is deliberately one mechanism).
//   3. Wait up to `wait_seconds` (default 120, hard ceiling 600) for the
//      process to exit.
//        - exits in time → parse, set status, return result.
//        - still running at timeout → return {status: "running",
//          task_id, network_enforcement}. The process keeps running; only
//          `check_task` can retrieve its eventual result.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { DB } from "../db/client.ts";
import type { AppConfig } from "../config.ts";
import { evaluateTrustBoundary } from "../security/trust-boundary.ts";
import { effectivePathDenylist, matchPromptDenylist, matchAbsolutePathDenylist } from "../security/denylist.ts";
import { canonicalize } from "../security/paths.ts";
import { resolveAgentArgv, type AgentId, type NetworkEnforcement } from "./agent-args.ts";
import { AGENT_IDS } from "../config.ts";
import { parseAgentOutput, resolveResultText } from "./agent-output.ts";
import { assessTask, ACTIVITY_GRACE_MS } from "./task-liveness.ts";
import { spawnDetached, isAlive, makeOutputFile } from "../platform/spawn.ts";
import type { Result } from "./send-message.ts";
import { ensureAgent } from "./send-message.ts";

export interface DispatchInput {
  target_agent: AgentId;
  prompt: string;
  cwd: string;
  // Optional fields can be `null` from the MCP wire format (the schema
  // advertises `["X", "null"]` for these). The runtime treats
  // `undefined` ("field omitted") and `null` ("field present, but
  // unset") the same way, so we accept both here. Mismatching the
  // schema would either let nulls slip through untyped (a TS escape
  // hatch) or block the valid null form.
  wait_seconds?: number | null;
  allowed_tools?: string[] | null;
  allow_network?: boolean | null;
  created_by?: string | null;
}

export type DispatchOutput =
  | { status: "completed"; result: string; exit_code: number; task_id: string; network_enforcement: NetworkEnforcement }
  | { status: "failed"; result: string; exit_code: number | null; task_id: string; network_enforcement: NetworkEnforcement }
  | { status: "running"; task_id: string; network_enforcement: NetworkEnforcement }
  // `reason` distinguishes the two needs_approval cases so the calling
  // agent can present a useful message and a useful next step:
  //   - "outside_home": the cwd is outside the home directory and not
  //     covered by an approved root. The user can `approve_path` to
  //     allow this specific location.
  //   - "ancestor_of_denylist": the cwd contains a denylist root
  //     (e.g. `cwd: ~` contains `~/.ssh`) as a subpath. Approval is
  //     not possible; the user must NARROW the cwd to a subdirectory
  //     that is not a denylist ancestor.
  | { status: "needs_approval"; path: string; task_id: string; reason: "outside_home" | "ancestor_of_denylist" };

export async function dispatch(
  db: DB,
  cfg: AppConfig,
  input: DispatchInput,
): Promise<Result<DispatchOutput>> {
  if (!input.target_agent || !input.prompt || !input.cwd) {
    return { ok: false, error: "target_agent, prompt, and cwd are required", code: "invalid_input" };
  }
  // Validate against the shared AGENT_IDS list rather than a chain of !==
  // comparisons. The chain was one more place that had to be edited in
  // lockstep with the tool schema's enum, and a target the schema
  // advertised but this check rejected would fail with a confusing error
  // at the very end of a caller's turn.
  if (!(AGENT_IDS as readonly string[]).includes(input.target_agent)) {
    return {
      ok: false,
      error: `unsupported target_agent '${input.target_agent}' (expected one of: ${AGENT_IDS.join(", ")})`,
      code: "invalid_input",
    };
  }

  // Runtime type check for `wait_seconds` (P1 fix). The schema
  // advertises `["number", "null"]` but the MCP wire format doesn't
  // enforce that, so a caller could send `"5"` (string) or `NaN`. The
  // schema-side type narrowing would silently let `clampWait` produce
  // a `NaN` deadline, which means "wait forever" — and the child
  // never times out, so the dispatch hangs at the FR-15 hard ceiling.
  if (input.wait_seconds !== undefined && input.wait_seconds !== null) {
    if (typeof input.wait_seconds !== "number" || !Number.isFinite(input.wait_seconds)) {
      return {
        ok: false,
        error: `wait_seconds must be a finite number (got ${typeof input.wait_seconds})`,
        code: "invalid_input",
      };
    }
  }

  // created_by tracks the caller's identity for the audit row (G2) and
  // for the FK. We don't accept a hard-coded fallback to "claude" —
  // the reverse handoff path (Codex → Claude) is a documented v1
  // scenario ("From Codex: Have Claude refactor
  // this file."), and silently misattributing those rows to Claude
  // would break the ownership trail. If the caller doesn't supply
  // created_by, we leave it null in the row and skip the FK seed.
  //
  // Empty string is rejected (P1 fix): the type check above accepts
  // it as a valid string, but `ensureAgent("")` would no-op (the
  // truthy check below) and the FK insert would then fail with
  // FOREIGN KEY constraint. The user gets a clearer error here than
  // a raw SQL exception bubbled out of the tool boundary.
  if (input.created_by !== undefined && input.created_by !== null) {
    if (typeof input.created_by !== "string" || input.created_by.length === 0) {
      return {
        ok: false,
        error: `created_by must be a non-empty string (got ${JSON.stringify(input.created_by)})`,
        code: "invalid_input",
      };
    }
  }
  const createdBy = input.created_by;
  if (createdBy) ensureAgent(db, createdBy);

  // Validate `allow_network`'s type BEFORE inserting the task row.
  // The MCP wire format doesn't enforce the schema's `boolean` typing
  // — a caller can pass `"false"` (string) and a truthy value would
  // slip through `??` to the resolver, enabling network access the
  // user didn't ask for. Validate first; only then insert the row.
  if (input.allow_network !== undefined && input.allow_network !== null && typeof input.allow_network !== "boolean") {
    return {
      ok: false,
      error: `allow_network must be a boolean (got ${typeof input.allow_network})`,
      code: "invalid_input",
    };
  }
  const allowNetwork = input.allow_network ?? cfg.dispatch.allow_network_default;

  // Same runtime check for `allowed_tools` (P2 fix). The schema says
  // "array of strings" but a caller could send `"Read"` (single string)
  // and our resolver would silently fall through to "no restriction",
  // granting Claude the full baseline tool set. The semantics of
  // `allowed_tools` are "narrow by intersection"; a wrong type
  // shouldn't silently mean the opposite.
  if (input.allowed_tools !== undefined && input.allowed_tools !== null && !Array.isArray(input.allowed_tools)) {
    return {
      ok: false,
      error: `allowed_tools must be an array of strings (got ${typeof input.allowed_tools})`,
      code: "invalid_input",
    };
  }

  const id = randomUUID();
  const createdAt = Date.now();

  // Step 1: insert row immediately. We persist the CANONICAL cwd
  // (post-tilde-expansion, post-symlink-resolution) rather than the
  // raw input, so any audit query that reads tasks.cwd gets the
  // validated location — never whatever the server's process cwd or
  // the caller's relative path happened to be. started_at is
  // deliberately NULL here; we set it ONLY when actually transitioning
  // to 'running' (FR-15 timing is derived from started_at, so a row
  // that never spawned must not look like a started execution).
  const validatedCwd = canonicalize(input.cwd);
  db.run(
    `INSERT INTO tasks(id, description, created_by, assigned_to, cwd, status, via, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 'dispatch', ?)`,
    [id, input.prompt, createdBy, input.target_agent, validatedCwd, createdAt],
  );

  // Validation order matters. Prompt denylist FIRST — if the prompt is
  // obviously unsafe, there's no point asking the user to approve a path
  // for it. Asking would also create a misleading approval for an unsafe
  // request (the user approves the path, the prompt is then denied, the
  // approval now sits in the DB ungrounded).
  const promptPattern = matchPromptDenylist(input.prompt, cfg.dispatch.denylist.patterns);
  if (promptPattern) {
    db.run(
      `UPDATE tasks SET status = 'rejected', result = ?, completed_at = ? WHERE id = ?`,
      [`denied by prompt denylist: ${promptPattern}`, Date.now(), id],
    );
    return {
      ok: false,
      error: `prompt matches denylist pattern (${promptPattern}); dispatch rejected`,
      code: "denylist_prompt",
    };
  }

  // Cwd-aware absolute-path check for `.env*` outside the cwd. Done
  // before the path trust boundary so an obviously malicious prompt
  // fails fast. (The `..` / `~` cases are caught by
  // `matchPromptDenylist` above; this handles the absolute-path case
  // where the text alone can't tell in-cwd from out-of-cwd.)
  const absEnvHit = matchAbsolutePathDenylist(input.prompt, validatedCwd);
  if (absEnvHit) {
    db.run(
      `UPDATE tasks SET status = 'rejected', result = ?, completed_at = ? WHERE id = ?`,
      [`denied by prompt denylist: absolute .env* outside cwd: ${absEnvHit}`, Date.now(), id],
    );
    return {
      ok: false,
      error: `prompt targets .env* outside the task cwd (${absEnvHit}); dispatch rejected`,
      code: "denylist_prompt",
    };
  }

  // Then path trust boundary. We validate the cwd's canonical form
  // (which resolves a relative path against homedir()) and use the SAME
  // canonical path for spawning. Validating against one location and
  // spawning against another would let `cwd: "."` (validated as the home
  // directory via homedir()-relative resolution) actually spawn the
  // child in whatever the server's own process cwd is — possibly a
  // project outside the home boundary.
  const pathDenylist = effectivePathDenylist(cfg.trust.denylist);
  const approvedRoots = db.all<{ path: string }>(`SELECT path FROM approved_paths`).map((r) => r.path);
  const verdict = evaluateTrustBoundary({
    cwd: validatedCwd,
    pathDenylist,
    approvedRoots,
    homeRoot: cfg.trust.home_root,
  });
  if (verdict.kind === "denied") {
    db.run(
      `UPDATE tasks SET status = 'rejected', result = ?, completed_at = ? WHERE id = ?`,
      [`denied by denylist: ${verdict.root}`, Date.now(), id],
    );
    // FR-9: denylist hits are real rejections, not successes. The
    // task row is still recorded (G2 audit trail) but the outer result
    // is ok: false so the calling agent treats it as an error.
    return {
      ok: false,
      error: `cwd is on the denylist (${verdict.root}); dispatch rejected`,
      code: "denylist",
    };
  }
  if (verdict.kind === "needs_approval") {
    db.run(`UPDATE tasks SET status = 'needs_approval' WHERE id = ?`, [id]);
    return {
      ok: true,
      // Pass through the verdict's reason so the caller can tell
      // "approve this path" from "narrow the cwd" (FR-11b is
      // structurally `needs_approval`, but the escalation path
      // differs by case).
      data: { status: "needs_approval", path: validatedCwd, task_id: id, reason: verdict.reason },
    };
  }

  // (allow_network is already validated and resolved to a boolean
  // above, before the row insert; the resolved value is reused here.)
  // `validatedCwd` — not `input.cwd`. The argv must be anchored to the same
  // canonical path we validated and spawn in; agy takes its workspace from
  // the argv rather than from the process cwd, so passing the raw input
  // here would let a relative or tilde form reach the agent unresolved.
  const resolved = resolveAgentArgv(cfg, input.target_agent, input.prompt, validatedCwd, allowNetwork, input.allowed_tools);

  // Make sure the output dir exists, then make the output file path.
  const outDir = cfg.server.output_dir;
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outFile = makeOutputFile(outDir, id);

  // Update row to 'running' BEFORE spawning, so an immediate check_task
  // can find it in the right state even if the spawn throws.
  const startedAt = Date.now();
  db.run(
    `UPDATE tasks SET status = 'running', started_at = ?, output_file = ? WHERE id = ?`,
    [startedAt, outFile, id],
  );

  let handle;
  try {
    handle = spawnDetached({
      argv: resolved.argv,
      cwd: validatedCwd, // use the same path we validated, not the raw input
      outputFile: outFile,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.run(
      `UPDATE tasks SET status = 'failed', result = ?, exit_code = ?, completed_at = ? WHERE id = ?`,
      [`spawn failed: ${msg}`, -1, Date.now(), id],
    );
    return {
      ok: true,
      data: { status: "failed", result: `spawn failed: ${msg}`, exit_code: -1, task_id: id, network_enforcement: resolved.network_enforcement },
    };
  }
  db.run(`UPDATE tasks SET pid = ?, pid_is_agent = ? WHERE id = ?`, [handle.pid, handle.pidIsAgent ? 1 : 0, id]);

  // Step 3: bounded wait. We do NOT kill on timeout — the child keeps
  // running and `check_task` is the only path to its eventual result.
  const waitSeconds = clampWait(input.wait_seconds, cfg.dispatch.default_wait_seconds, cfg.dispatch.max_wait_seconds);
  const deadline = Date.now() + waitSeconds * 1000;

  const outcome = await waitForExit(handle, deadline);
  if (outcome.kind === "exited" && exitIsAuthoritative(handle, outFile)) {
    // Parse the result from the output file. We keep this tolerant:
    // if the output isn't parseable as JSON, surface the raw stdout.
    // For failed runs we ALSO read the stderr sibling (P2 fix):
    // many CLIs print auth/usage errors to stderr only, and we
    // don't want the caller to see an empty result for those.
    const out = readOutputFile(outFile);
    const parsed = parseAgentOutput(out);
    const { exitCode, ok } = judgeOutcome(outcome.exitCode, parsed.inferredExitCode, handle.pidIsAgent);
    const finalResult = resolveResultText({
      resultText: parsed.resultText,
      ok,
      readStderr: () => readOutputFile(handle.stderrFile),
    });
    const finalStatus = ok ? "completed" : "failed";
    db.run(
      `UPDATE tasks SET status = ?, result = ?, exit_code = ?, completed_at = ? WHERE id = ?`,
      [finalStatus, finalResult, exitCode, Date.now(), id],
    );
    return {
      ok: true,
      data: {
        status: finalStatus,
        result: finalResult,
        exit_code: exitCode,
        task_id: id,
        network_enforcement: resolved.network_enforcement,
      },
    };
  }
  // Either still running at the timeout boundary, or the process we spawned
  // is gone but was only a launcher and the agent behind it is still working
  // (see exitIsAuthoritative). Both mean the same thing to the caller: the
  // task continues. Do NOT kill, just report.
  // But: schedule a background reconciliation so that when the child
  // eventually exits, the task row is updated with the real exit code
  // and result. Without this, a child that completes successfully
  // minutes later stays "running" in the DB until the reaper sweeps
  // it as a generic failure, even though it actually completed.
  scheduleBackgroundReconcile(db, id, handle, outFile);

  return {
    ok: true,
    data: {
      status: "running",
      task_id: id,
      network_enforcement: resolved.network_enforcement,
    },
  };
}

/**
 * When dispatch returns "running" because the wait timed out, the
 * child process keeps running. We attach a fire-and-forget callback to
 * its `exited` promise so the DB row gets updated when (eventually)
 * the child finishes. We don't await this — it's a background update,
 * the caller has already returned.
 */
function scheduleBackgroundReconcile(
  db: DB,
  taskId: string,
  handle: ReturnType<typeof spawnDetached>,
  outFile: string,
): void {
  // Use the handle's `exited` promise as the trigger. We don't unref
  // because the child itself keeps the runtime alive; this callback
  // resolves alongside the child and the runtime exits naturally.
  handle.exited.then((rawExitCode) => {
    try {
      // The process we spawned is gone, but that is only the task's ending if
      // it was the agent itself — see exitIsAuthoritative. Recording a killed
      // shim's exit status here would be the same false failure by a
      // different route. Hand off to the watcher instead: `exited` has
      // already fired and will never fire again, so without it nothing would
      // be left following the run.
      if (!exitIsAuthoritative(handle, outFile)) {
        watchOrphanedRun(db, taskId, handle, outFile, rawExitCode);
        return;
      }
      const out = readOutputFile(outFile);
      const parsed = parseAgentOutput(out);
      const { exitCode, ok } = judgeOutcome(rawExitCode, parsed.inferredExitCode, handle.pidIsAgent);
      const resultText = resolveResultText({
        resultText: parsed.resultText,
        ok,
        readStderr: () => readOutputFile(handle.stderrFile),
      });
      const finalStatus = ok ? "completed" : "failed";
      // Only update if the row is still "running" — the reaper may have
      // swept it as a stale task in the meantime, in which case we
      // leave the sweep's "failed" verdict alone.
      db.run(
        `UPDATE tasks SET status = ?, result = ?, exit_code = ?, completed_at = ?
          WHERE id = ? AND status = 'running'`,
        [finalStatus, resultText, exitCode, Date.now(), taskId],
      );
    } catch {
      // Swallow — a background update that fails shouldn't bubble up.
    }
  }).catch(() => { /* ignore */ });
}

/** How often the orphan watcher re-reads the output file. */
const ORPHAN_POLL_MS = 5_000;

/**
 * Keep following a run whose launcher has exited but whose agent is still
 * working (the `exitIsAuthoritative` false case).
 *
 * This exists because `exited` is a one-shot: it has already fired by the
 * time we know to defer, and it will never fire again for the orphan behind
 * the shim. Without something watching, a task that finishes seconds later
 * would sit at `running` until a caller happened to poll `check_task` or the
 * reaper's sweep came round half an hour later — abandoning dispatch's
 * promise that a timed-out task settles its own row when the work finishes.
 *
 * The watcher reads the output on exactly the terms task-liveness uses, and
 * stops at the reaper's window: past that point the sweep is the backstop and
 * a lingering timer would add nothing. The timer is unref'd, so it can never
 * hold the server process open.
 */
function watchOrphanedRun(
  db: DB,
  taskId: string,
  handle: ReturnType<typeof spawnDetached>,
  outFile: string,
  /**
   * The launcher's own exit status, kept so it is not thrown away by
   * deferring. If the run ends up abandoned — nothing behind the launcher
   * ever produced a verdict — this was the most specific thing we ever
   * learned about why, and reporting a bare -1 instead would discard, say,
   * the exit 9 of a shim that died on a bad argument.
   */
  launcherExitCode: number,
): void {
  const giveUpAt = Date.now() + ACTIVITY_GRACE_MS;

  const schedule = () => {
    const timer = setTimeout(tick, ORPHAN_POLL_MS);
    // Bun/Node timers expose unref(); guard anyway so a runtime without it
    // degrades to "server waits for the timer" rather than crashing.
    (timer as { unref?: () => void }).unref?.();
  };

  function tick(): void {
    try {
      // Someone else may have settled the row (check_task, or the reaper).
      const row = db.get<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
      if (!row || row.status !== "running") return;

      // `pid: null` — the recorded process is gone; only the output can speak.
      const liveness = assessTask({ pid: null, outputFile: outFile });
      if (liveness.state !== "running") {
        const exitCode =
          liveness.state === "finished"
            ? liveness.exitCode
            : launcherExitCode !== 0
              ? launcherExitCode
              : -1;
        const ok = exitCode === 0;
        const resultText = resolveResultText({
          resultText:
            liveness.state === "finished"
              ? liveness.resultText
              : parseAgentOutput(readOutputFile(outFile)).resultText,
          ok,
          readStderr: () => readOutputFile(handle.stderrFile),
        });
        db.run(
          `UPDATE tasks SET status = ?, result = ?, exit_code = ?, completed_at = ?
            WHERE id = ? AND status = 'running'`,
          [ok ? "completed" : "failed", resultText, exitCode, Date.now(), taskId],
        );
        return;
      }

      if (Date.now() >= giveUpAt) return; // the reaper owns it from here.
      schedule();
    } catch {
      // Background work must never throw past this point.
    }
  }

  schedule();
}

/**
 * Whether the spawned process exiting actually means the TASK ended.
 *
 * Usually yes — the process we spawned is the agent. The exception is a
 * Windows .cmd shim (platform/spawn.ts), where the pid belongs to a launcher
 * standing in front of the agent. Killing that shim — which is what happens
 * when this server exits, and what an external `taskkill` does — makes
 * `exited` resolve with the SHIM's status while the agent it launched carries
 * on working. Treating that as the task's outcome reports `failed` for work
 * that then completes successfully: the same false failure task-liveness.ts
 * exists to prevent, arriving by a different route.
 *
 * So for a shim, whether the exit is the ending is precisely the liveness
 * question — and it is asked of the one module that answers it, rather than
 * re-derived here. An earlier version did re-derive it, from stdout alone,
 * and that was wrong in a way worth recording: a shim dying while its agent
 * had so far written only to stderr looked "not an agent stream" and was
 * taken as authoritative, so the still-running dispatch process failed a task
 * that check_task — which does read stderr — would have kept running. Two
 * code paths disagreeing about identical output is the bug generator this
 * whole area keeps producing; there is one policy, in task-liveness.ts.
 */
function exitIsAuthoritative(handle: ReturnType<typeof spawnDetached>, outFile: string): boolean {
  if (handle.pidIsAgent) return true;
  // `pid: null` on purpose — the recorded process is already gone, so the
  // question is only whether anything is still producing output.
  return assessTask({ pid: null, outputFile: outFile }).state !== "running";
}

/**
 * Combine the OS exit status with the verdict the agent wrote into its own
 * output, and decide the task's outcome.
 *
 * A process exit code of 0 is not by itself proof of success: `claude -p
 * --output-format json` reports API-level failures (an expired OAuth token,
 * for instance) as `is_error: true` in its result envelope, and a CLI that
 * paired that with a 0 exit would otherwise be recorded as `completed` with
 * an error message sitting in the result field.
 *
 * This also keeps the two reconciliation paths honest with each other. The
 * restart path (check_task / the reaper) has only the output to go on and
 * would call such a run `failed`; if this path called the very same output
 * `completed`, the status a caller saw would depend on nothing more than
 * whether the server happened to stay up.
 *
 * Which signal outranks which depends on whose exit status we actually have:
 *
 *   - `osExitIsAgents` true (the normal case) — a non-zero OS exit wins and
 *     is reported verbatim; it is the more specific signal. Inference only
 *     decides cases the exit code calls success.
 *
 *   - `osExitIsAgents` false — the exit status belongs to a Windows .cmd
 *     launcher, not the agent (see platform/spawn.ts). A shim killed after
 *     its agent already finished successfully exits non-zero, and letting
 *     that win would report `failed` for a completed run: the same false
 *     failure, one layer down. So when the agent has written its own verdict,
 *     that verdict is the outcome and the launcher's status is discarded.
 */
function judgeOutcome(
  osExitCode: number,
  inferredExitCode: number | null,
  osExitIsAgents: boolean,
): { exitCode: number; ok: boolean } {
  if (!osExitIsAgents && inferredExitCode !== null) {
    return { exitCode: inferredExitCode, ok: inferredExitCode === 0 };
  }
  if (osExitCode !== 0) return { exitCode: osExitCode, ok: false };
  if (inferredExitCode !== null && inferredExitCode !== 0) {
    return { exitCode: inferredExitCode, ok: false };
  }
  return { exitCode: 0, ok: true };
}

/** FR-15 hard ceiling, independent of any config override. */
const HARD_MAX_WAIT_SECONDS = 600;

function clampWait(requested: number | null | undefined, def: number, cap: number): number {
  // FR-15: 600 is a hard ceiling, not a default — it is enforced
  // regardless of what the user has set in config. The config's
  // max_wait_seconds caps the *requested* value, and the hard ceiling
  // then caps the *config* value, so no input can ever let a dispatch
  // block beyond 10 minutes.
  const effectiveCap = Math.min(cap, HARD_MAX_WAIT_SECONDS);
  if (requested === undefined || requested === null) return Math.min(def, effectiveCap);
  if (requested < 1) return 1;
  if (requested > effectiveCap) return effectiveCap;
  return Math.floor(requested);
}

function waitForExit(handle: ReturnType<typeof spawnDetached>, deadline: number): Promise<
  | { kind: "exited"; exitCode: number }
  | { kind: "still-running" }
> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: { kind: "exited"; exitCode: number } | { kind: "still-running" }) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    // Race: child exits vs deadline.
    handle.exited.then((code) => finish({ kind: "exited", exitCode: code }));
    const remain = deadline - Date.now();
    if (remain <= 0) {
      // Deadline already passed before we started waiting.
      if (isAlive(handle.pid)) finish({ kind: "still-running" });
      else finish({ kind: "exited", exitCode: -1 });
      return;
    }
    setTimeout(() => {
      if (isAlive(handle.pid)) finish({ kind: "still-running" });
      else finish({ kind: "exited", exitCode: -1 });
    }, remain);
  });
}

function readOutputFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

// ensureAgent is imported from send-message.ts.
