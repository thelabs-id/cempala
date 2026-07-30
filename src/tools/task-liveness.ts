// src/tools/task-liveness.ts
//
// One place decides whether a `running` task is still running, has finished,
// or has been abandoned. `check_task` (FR-7) and the reaper (FR-17) both ask
// this question after a server restart, when the only things left to go on
// are what was persisted: the pid and the output file.
//
// Why this is not just `isAlive(pid)`:
//
// On Windows the npm-installed agent CLIs run behind a .cmd shim, so the pid
// we record is the SHIM's, not the agent's. When the cempala server exits,
// Bun kills the shim — but the agent itself is orphaned and carries on,
// finishes its work, and keeps writing to the inherited output fd. Reading
// the dead shim pid as "the task failed" produced exactly that false
// failure: a task reported `failed` with exit -1 while the agent went on to
// complete successfully. The calling agent would then redo work that had
// already been done.
//
// So a dead pid is treated as *one* signal, and never the deciding one on
// its own:
//
//   1. The output says the run finished  → finished. Authoritative, and it
//      also covers pid reuse (a recycled pid reading "alive" can no longer
//      pin a completed task at `running` forever).
//   2. The recorded pid is alive         → running.
//   3. The output changed recently      → running. This is the orphaned
//      agent above: its shim is gone, but it is demonstrably still working.
//      Output identifiable as an agent's event stream earns the full window;
//      ambiguous output (plain diagnostics, or stderr-only progress) earns a
//      short one, because a launcher that died printing a usage error also
//      leaves fresh output behind and must not be mistaken for a live agent.
//   4. Otherwise                         → abandoned.
//
// The grace window in (3) has to cover an agent that is thinking without
// emitting anything. Erring long is cheap — a task sits at `running` a
// little longer — whereas erring short reintroduces the false failure this
// module exists to prevent.

import { statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { isAlive } from "../platform/spawn.ts";
import { parseAgentOutput, looksLikeAgentStream } from "./agent-output.ts";

/**
 * How long after its last observable activity a run with no verdict is still
 * treated as alive.
 *
 * This is FR-17's 30-minute stale window on purpose, and the reaper derives
 * its own cutoff from this same constant so the two can never disagree. A
 * shorter window here was tempting and wrong: at 2 minutes, an agent that
 * reasons quietly — or writes only to stderr — for longer than that would be
 * declared abandoned and reported `failed` while still working, which is the
 * exact false failure this module exists to prevent, merely rarer and so
 * harder to catch. Nothing is gained by failing a task early; the only cost
 * of waiting is that a genuinely dead task reads `running` until the sweep.
 */
export const ACTIVITY_GRACE_MS = 30 * 60 * 1000;

/**
 * The same idea for output we cannot positively identify as an agent's.
 *
 * Fresh output that is not a recognisable agent stream is ambiguous at a
 * glance: it is equally the shape of an agent reporting progress on stderr
 * before it has written anything to stdout, and of a launcher that died
 * printing `usage: bad args`. A single snapshot cannot tell those apart —
 * but successive ones can, because only one of them keeps writing.
 *
 * So ambiguous output gets a short benefit of the doubt rather than the full
 * window or none at all. An agent that keeps producing output keeps pushing
 * its mtime forward and stays `running` indefinitely; a launcher whose output
 * froze at the moment it died falls out of this window quickly and is
 * reported for what it is. Neither of the two failure modes this module
 * exists to prevent — a false failure, or a task parked at `running` — is
 * reachable for more than this long.
 */
export const UNSTRUCTURED_ACTIVITY_GRACE_MS = 30_000;

export type TaskLiveness =
  /** The run finished and the output carries its verdict. */
  | { state: "finished"; exitCode: number; resultText: string }
  /** Still going: pid alive, or output still being written. */
  | { state: "running" }
  /** Dead, with no verdict and no recent activity. */
  | { state: "abandoned" };

export interface AssessOptions {
  pid: number | null;
  outputFile: string | null;
  /**
   * Whether `pid` is the agent itself rather than a launcher in front of it,
   * as persisted by dispatch (`tasks.pid_is_agent`).
   *
   * This changes what a DEAD pid proves. When the pid was the agent, its
   * death ends the run — full stop — and we reconcile from whatever it wrote.
   * When it was only a shim, its death proves nothing and the output has to
   * decide. Defaults to false, the conservative reading, so rows written by
   * builds before the column existed keep the safe behavior.
   */
  pidIsAgent?: boolean;
  now?: number;
  graceMs?: number;
}

export function assessTask(opts: AssessOptions): TaskLiveness {
  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? ACTIVITY_GRACE_MS;
  // Never longer than the main window, so an explicit `graceMs` override
  // still bounds both.
  const shortGraceMs = Math.min(graceMs, UNSTRUCTURED_ACTIVITY_GRACE_MS);
  const text = readOutput(opts.outputFile);

  // 1. A verdict in the output beats every other signal, alive or not.
  if (text) {
    const { resultText, inferredExitCode } = parseAgentOutput(text);
    if (inferredExitCode !== null) {
      return { state: "finished", exitCode: inferredExitCode, resultText };
    }
  }

  // 2. The recorded process is still there.
  if (opts.pid !== null && isAlive(opts.pid)) return { state: "running" };

  // 2b. The pid WAS the agent, and it is gone. That is conclusive: there is
  //     nothing left running to produce anything further, so no amount of
  //     recently-written output should hold the task at `running`. Skipping
  //     this would leave a crashed direct-.exe or POSIX agent — one that
  //     wrote `turn.started` and then died — reported as running until the
  //     activity window expired, which is FR-7's "process has exited →
  //     reconcile from output" quietly not happening.
  //
  //     Only the shim case below is entitled to the benefit of the doubt.
  if (opts.pidIsAgent && opts.pid !== null) return { state: "abandoned" };

  // 3. Something is still writing — an agent orphaned by the loss of its
  //    launcher. Recency is judged on mtime rather than size (an agent can
  //    rewrite in place) and across BOTH streams, because plenty of CLIs
  //    report progress on stderr while stdout stays silent until the final
  //    JSON.
  //
  //    How much recency buys depends on what the output looks like. Output we
  //    can positively identify as an agent's event stream earns the full
  //    window. Anything else — plain diagnostics, or stderr progress with
  //    nothing on stdout yet — is ambiguous and earns only the short one, so
  //    a launcher that died mid-sentence is not mistaken for a working agent,
  //    while an agent that genuinely keeps writing keeps renewing its own
  //    lease and stays `running` for as long as it works.
  const touched = lastActivity(opts.outputFile);
  if (touched !== null) {
    const window = text !== null && looksLikeAgentStream(text) ? graceMs : shortGraceMs;
    if (now - touched <= window) return { state: "running" };
  }

  return { state: "abandoned" };
}

function readOutput(file: string | null): string | null {
  if (!file) return null;
  try {
    const t = readFileSync(file, "utf-8");
    return t.trim() ? t : null;
  } catch {
    return null;
  }
}

/**
 * Most recent write across stdout and its stderr sibling. `spawnDetached`
 * names the stderr file `<outputFile>.err`, and that convention is already
 * relied on by check_task, so it is reproduced rather than plumbed through.
 */
function lastActivity(outputFile: string | null): number | null {
  if (!outputFile) return null;
  const times = [mtime(outputFile), mtime(`${outputFile}.err`)].filter(
    (t): t is number => t !== null,
  );
  return times.length ? Math.max(...times) : null;
}

function mtime(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}
