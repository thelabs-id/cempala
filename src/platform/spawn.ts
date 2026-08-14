// src/platform/spawn.ts
//
// Cross-platform detached subprocess spawn + PID liveness wrapper.
// All process-platform branching lives here; nothing else in the codebase
// should reach into `process.platform` directly. The two responsibilities
// are intentionally fused in one file because they share the same OS-level
// primitives (the child's pid is what liveness has to be re-derivable from
// after a server restart: liveness has to be restart-safe).

import { spawn, type Subprocess } from "bun";
import { realpathSync, existsSync, openSync, closeSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";

export interface SpawnOptions {
  /** Argv to pass to Bun.spawn. NEVER a shell string. */
  argv: string[];
  /** Working directory; set on every platform via Bun.spawn({ cwd }). */
  cwd: string;
  /** File to redirect stdout into. Created if missing. */
  outputFile: string;
  /** File to redirect stderr into. Defaults to outputFile + ".err". */
  stderrFile?: string;
  /** Environment overrides; the child inherits by default. */
  env?: Record<string, string>;
}

export interface SpawnHandle {
  /** OS-level PID. Persist this — liveness is re-derivable from it alone. */
  pid: number;
  /**
   * Whether `pid` is the agent itself rather than a launcher standing in
   * front of it.
   *
   * True in every case except a Windows .cmd shim, where the pid belongs to
   * the shim. That distinction decides whether the process's exit status can
   * be taken as the task's outcome: a shim exiting non-zero (because it was
   * killed) says nothing about the agent it launched, which may still be
   * working. See shouldDetach().
   */
  pidIsAgent: boolean;
  /** File where stdout is being captured (the JSON result, etc). */
  outputFile: string;
  /** File where stderr is being captured (diagnostics). */
  stderrFile: string;
  /**
   * Resolves when the child exits. Fast-path liveness signal — useful while
   * the spawning server process is still alive, but NEVER the only path
   * (after a server restart the promise is gone, so `isAlive(pid)` is what
   * the reaper and check_task have to fall back on).
   */
  exited: Promise<number>;
}

/**
 * Detach a child process from the current one.
 *
 * - POSIX: own session/process group via setsid(), stdio redirected to a
 *   file, no TTY.
 * - Windows: no POSIX process groups; whether UV_PROCESS_DETACHED is used
 *   depends on whether we're launching a real .exe or a .cmd shim, because
 *   it breaks output capture for the latter — see shouldDetach() below. In
 *   the shim case the recorded pid can die while the agent lives on, which
 *   is exactly why liveness is not allowed to equate a dead pid with a
 *   failed task (tools/task-liveness.ts).
 *
 * Critically: we do NOT call `await proc.exited` here. The handle exposes
 * the promise but doesn't block. `dispatch`'s bounded wait is what decides
 * when to stop blocking the caller, and after that point the child keeps
 * running until it finishes on its own.
 */
export function spawnDetached(opts: SpawnOptions): SpawnHandle {
  const outFile = opts.outputFile;
  const errFile = opts.stderrFile ?? `${outFile}.err`;

  // Ensure the output dir exists before opening the capture files. Callers
  // are expected to have created it already; this is belt-and-braces, and it
  // has to actually run now that we open the files ourselves — `openSync`
  // throws on a missing directory, where the old path silently deferred the
  // failure to Bun.
  const parent = dirname(outFile);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  // Two SEPARATE handles for stdout and stderr (P2 fix). Sharing one for
  // both can corrupt the capture: a process that writes partial JSON to
  // stdout + a warning to stderr can have stderr overwrite stdout (or the
  // writes interleave on disk), losing the JSON result the dispatch wrapper
  // needs to parse. Stderr is kept in a sibling file for diagnostics; the
  // dispatch result only reads stdout.
  //
  // Raw OS file descriptors rather than `Bun.file(path)`: the child inherits
  // these as real handles it writes to directly, so capture does not depend
  // on this process being around to pump anything. Verified on Windows 11 /
  // Bun 1.3.14 that output keeps landing in the file after the spawning
  // process exits cleanly AND after a hard `taskkill /F`.
  const outFd = openSync(outFile, "w");
  const errFd = openSync(errFile, "w");

  // Bun treats an explicit `env` object as the child process's complete
  // environment rather than a patch. Runtime overrides therefore must be
  // layered over process.env; passing only OPENCODE_CONFIG_CONTENT made the
  // OpenCode dispatch lose PATH and fail before it could start. Keeping the
  // default `undefined` path preserves Bun's ordinary inheritance for all
  // other dispatches, while an override retains PATH/PATHEXT (needed by
  // Windows npm shims) as well as every credential the target CLI normally
  // inherits. The PATH behavior is covered by spawn-detached.test.ts;
  // Windows shim behavior remains covered by the platform-gated suite.
  const env: Record<string, string | undefined> | undefined = opts.env
    ? { ...process.env, ...opts.env }
    : undefined;

  // See shouldDetach() — on Windows this depends on what we're actually
  // launching, and the difference is measured, not assumed. It doubles as
  // "is the pid we're about to record the agent's own?", since the only case
  // we don't detach is the one where a shim sits in front of the agent.
  const detached = shouldDetach(opts.argv[0]);

  let proc: Subprocess;
  try {
    proc = spawn({
      cmd: opts.argv,
      cwd: opts.cwd,
      env,
      stdio: ["ignore", outFd, errFd],
      detached,
    });
  } finally {
    // The child holds its own inherited copies of these descriptors, so our
    // originals are dead weight the moment spawn() returns — and leaking one
    // per dispatch would eventually exhaust the fd table of a long-lived
    // server. Closing in `finally` covers the spawn-throws path too.
    closeQuietly(outFd);
    closeQuietly(errFd);
  }

  return {
    pid: proc.pid,
    pidIsAgent: detached,
    outputFile: outFile,
    stderrFile: errFile,
    exited: proc.exited,
  };
}

/**
 * Whether to pass `detached` for a given executable.
 *
 * POSIX: always. setsid() gives the child its own session, it genuinely
 * outlives us, and nothing about output capture changes.
 *
 * Windows: only when we are launching a real executable, NOT a command-script
 * shim (`.cmd` / `.bat`). Both halves of that are measured on Windows 11 /
 * Bun 1.3.14, and the asymmetry is the whole reason this function exists:
 *
 *   - Direct .exe (how `claude` installs here) — `detached` works properly:
 *     the child survives this process exiting AND its output is captured in
 *     full. So we detach, and as a bonus the pid we record IS the agent's,
 *     which makes liveness exact.
 *
 *   - .cmd shim (how npm installs `codex`) — `detached` silently destroys
 *     output capture: a run that does its work perfectly writes a 0-byte
 *     log, losing the agent's answer entirely and leaving check_task nothing
 *     to reconcile from. So we do NOT detach there, which means Bun kills
 *     the shim when this process exits, and the pid we recorded dies with it.
 *
 * Whether the agent BEHIND a shim survives that kill is a property of the
 * shim, not something this code can promise. Measured both ways: the real
 * codex CLI (npm's shim idiom) is orphaned and runs to completion, still
 * writing to the inherited fd above; a plain .cmd whose child is an ordinary
 * executable is killed along with it.
 *
 * So on Windows a dead recorded pid means "the shim is gone" and nothing
 * more — the task may have finished, may still be running, or may have been
 * killed. Liveness must therefore never read "recorded pid is dead" as "the
 * task failed"; tools/task-liveness.ts is what decides between those cases,
 * and is where the false-failure bug this comment exists to prevent was
 * actually fixed.
 *
 * `Bun.which` resolves through PATH/PATHEXT the way the OS would, so this
 * classifies the file that will really be launched rather than guessing from
 * the bare name in argv. An unresolvable name falls through to detaching:
 * the spawn is about to fail anyway, and the alternative would silently opt
 * real executables out of detachment whenever `which` came up empty.
 */
export function shouldDetach(argv0: string | undefined): boolean {
  if (process.platform !== "win32") return true;
  if (!argv0) return true;
  const resolved = Bun.which(argv0) ?? argv0;
  return !/\.(cmd|bat)$/i.test(resolved);
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Already closed, or never validly opened — nothing useful to do here.
  }
}

/**
 * Test whether a pid is still alive, using only the pid alone (no in-memory
 * handle). This is the only path liveness is allowed to take on POSIX
 * (`process.kill(pid, 0)` throws ESRCH when the process is gone).
 *
 * On Windows, `process.kill(pid, 0)` is also implemented by Bun and returns
 * the same way; we route through it unconditionally so call sites do not
 * have to branch.
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a unique output file path under the given output dir.
 * Pattern: `<outputDir>/<taskId>-<random>.log`.
 */
export function makeOutputFile(outputDir: string, taskId: string): string {
  return join(outputDir, `${taskId}-${randomUUID().slice(0, 8)}.log`);
}

/**
 * Convert a possibly-relative path to absolute, resolving symlinks if they
 * exist. Used only for canonicalization — see security/paths.ts for the
 * authoritative version. This is a small helper exposed for platform/spawn
 * callers that need a realpath for safety.
 */
export function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Re-export tmpdir so callers don't have to import from `node:os` just for
 * the few places we need a temp path.
 */
export function tmpDir(): string {
  return tmpdir();
}

/**
 * Re-export basename for symmetry with dirname usage above.
 */
export { basename };
