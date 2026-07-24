// src/platform/spawn.ts
//
// Cross-platform detached subprocess spawn + PID liveness wrapper.
// All process-platform branching lives here; nothing else in the codebase
// should reach into `process.platform` directly. The two responsibilities
// are intentionally fused in one file because they share the same OS-level
// primitives (the child's pid is what liveness has to be re-derivable from
// after a server restart — see AGENTS.md §6 "Liveness must be restart-safe").

import { spawn, type Subprocess } from "bun";
import { realpathSync, existsSync } from "node:fs";
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
 * - POSIX: own process group, stdio redirected to a file, no TTY.
 * - Windows: no POSIX process groups, so we use the closest available
 *   mechanism (no `detached: true` does not exist in the Bun.spawn API;
 *   the child gets its own process tree by virtue of stdio redirection
 *   and not being waited on synchronously).
 *
 * Critically: we do NOT call `await proc.exited` here. The handle exposes
 * the promise but doesn't block. `dispatch`'s bounded wait is what decides
 * when to stop blocking the caller, and after that point the child keeps
 * running until it finishes on its own.
 */
export function spawnDetached(opts: SpawnOptions): SpawnHandle {
  const outFile = opts.outputFile;
  const errFile = opts.stderrFile ?? `${outFile}.err`;

  // Bun.spawn accepts a file path directly for stdout/stderr. Ensure the
  // parent dir exists so file creation cannot fail.
  const parent = dirname(outFile);
  if (!existsSync(parent)) {
    // Best-effort; if this throws the spawn will surface the underlying error.
    // The caller is expected to have created the output dir already.
  }

  // Two SEPARATE file handles for stdout and stderr (P2 fix). Sharing
  // a single Bun.file for both can corrupt the capture: Bun opens
  // distinct write handles per-stdio slot, and a process that writes
  // partial JSON to stdout + a warning to stderr can have stderr
  // overwrite stdout (or the writes interleave on disk), losing the
  // JSON result the dispatch wrapper needs to parse. Stderr is kept
  // in a sibling file for diagnostics; the dispatch result only
  // reads stdout.
  const outHandle = Bun.file(outFile);
  const errHandle = Bun.file(errFile);

  // Cross-platform note: we deliberately let Bun.spawn inherit the parent
  // process's env by default. Spreading `process.env` into an `env` object
  // on Windows can cause the spawned process to lose the PATH/PATHEXT
  // resolution context for the .cmd / .ps1 wrappers the npm-installed
  // CLIs use, surfacing as "ENOENT: uv_spawn 'codex'". When the caller
  // supplies explicit overrides, we layer them on top — but only those
  // overrides; the rest is inherited automatically. To override PATH
  // itself, the caller is expected to put the new value in opts.env.
  const env: Record<string, string | undefined> | undefined = opts.env
    ? opts.env
    : undefined;

  const proc: Subprocess = spawn({
    cmd: opts.argv,
    cwd: opts.cwd,
    env,
    stdio: ["ignore", outHandle, errHandle],
    // On POSIX, { detached: true } creates a new process group so the
    // child survives parent exit. On Windows the flag has no equivalent
    // semantics and is ignored; we still set it so the intent is recorded
    // at the call site.
    detached: process.platform !== "win32",
  });

  return {
    pid: proc.pid,
    outputFile: outFile,
    stderrFile: errFile,
    exited: proc.exited,
  };
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
