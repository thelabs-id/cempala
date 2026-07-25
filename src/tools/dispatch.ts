// src/tools/dispatch.ts
//
// FR-6: the synchronous "do this now and tell me the result" path.
//
// Flow (REQUIREMENTS.md §6):
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
//      a CLI flag — see AGENTS.md §6 for why there's one mechanism).
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
import { resolveAgentArgv, type NetworkEnforcement } from "./agent-args.ts";
import { spawnDetached, isAlive, makeOutputFile } from "../platform/spawn.ts";
import type { Result } from "./send-message.ts";
import { ensureAgent } from "./send-message.ts";

export interface DispatchInput {
  target_agent: "codex" | "claude";
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
  if (input.target_agent !== "codex" && input.target_agent !== "claude") {
    return { ok: false, error: `unsupported target_agent '${input.target_agent}'`, code: "invalid_input" };
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
  // scenario (REQUIREMENTS.md §1: "From Codex: Have Claude refactor
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
  const resolved = resolveAgentArgv(cfg, input.target_agent, input.prompt, allowNetwork, input.allowed_tools);

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
  db.run(`UPDATE tasks SET pid = ? WHERE id = ?`, [handle.pid, id]);

  // Step 3: bounded wait. We do NOT kill on timeout — the child keeps
  // running and `check_task` is the only path to its eventual result.
  const waitSeconds = clampWait(input.wait_seconds, cfg.dispatch.default_wait_seconds, cfg.dispatch.max_wait_seconds);
  const deadline = Date.now() + waitSeconds * 1000;

  const outcome = await waitForExit(handle, deadline);
  if (outcome.kind === "exited") {
    // Parse the result from the output file. We keep this tolerant:
    // if the output isn't parseable as JSON, surface the raw stdout.
    // For failed runs we ALSO read the stderr sibling (P2 fix):
    // many CLIs print auth/usage errors to stderr only, and we
    // don't want the caller to see an empty result for those.
    const out = readOutputFile(outFile);
    const parsed = tryParseJson(out);
    const resultText = parsed
      ? (typeof parsed === "object" && parsed && "result" in parsed
          ? String((parsed as Record<string, unknown>).result ?? "")
          : JSON.stringify(parsed))
      : out;
    const ok = outcome.exitCode === 0;
    let finalResult = resultText;
    if (!ok) {
      const errText = readOutputFile(handle.stderrFile).trim();
      if (errText && !resultText) {
        finalResult = errText;
      } else if (errText) {
        finalResult = `${resultText}\n\nstderr:\n${errText}`;
      }
    }
    const finalStatus = ok ? "completed" : "failed";
    db.run(
      `UPDATE tasks SET status = ?, result = ?, exit_code = ?, completed_at = ? WHERE id = ?`,
      [finalStatus, finalResult, outcome.exitCode, Date.now(), id],
    );
    return {
      ok: true,
      data: {
        status: finalStatus,
        result: finalResult,
        exit_code: outcome.exitCode,
        task_id: id,
        network_enforcement: resolved.network_enforcement,
      },
    };
  }
  // Still running at the timeout boundary — do NOT kill, just report.
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
  handle.exited.then((exitCode) => {
    try {
      const out = readOutputFile(outFile);
      const parsed = tryParseJson(out);
      let resultText = parsed
        ? (typeof parsed === "object" && parsed && "result" in parsed
            ? String((parsed as Record<string, unknown>).result ?? "")
            : JSON.stringify(parsed))
        : out;
      // For failed runs, also read the stderr sibling (P2 fix). Many
      // CLIs print auth/usage errors to stderr only — without this
      // step, the task row would say "failed" with an empty result
      // and the caller would have no actionable error.
      if (exitCode !== 0) {
        const errText = readOutputFile(handle.stderrFile).trim();
        if (errText && !resultText) {
          resultText = errText;
        } else if (errText) {
          resultText = `${resultText}\n\nstderr:\n${errText}`;
        }
      }
      const finalStatus = exitCode === 0 ? "completed" : "failed";
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

function tryParseJson(text: string): unknown {
  // Codex emits JSONL with multiple objects; prefer the FIRST line
  // that carries a `result` field (the canonical final answer),
  // falling back to the last parseable line if no `result` is
  // present (P2 fix). Walking from the end returns whatever the
  // last event happened to be — which for a successful run is
  // `thread.completed` with no `result`, leaving the caller
  // without the agent's actual answer.
  if (!text) return null;
  // Try parsing as a single JSON object first.
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object" && "result" in obj) return obj;
  } catch {
    // fall through
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // First pass: any line with a `result` field.
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && "result" in obj) return obj;
    } catch {
      // try next
    }
  }
  // Second pass: any line with an `exit_code` (failed runs).
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && "exit_code" in obj) return obj;
    } catch {
      // try next
    }
  }
  // Final fallback: last parseable line (best-effort).
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]!);
    } catch {
      // try next
    }
  }
  return null;
}

// ensureAgent is imported from send-message.ts.
