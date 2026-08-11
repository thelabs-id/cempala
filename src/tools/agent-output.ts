// src/tools/agent-output.ts
//
// The single parser for a spawned agent's captured stdout. `dispatch` (both
// the in-wait path and the background reconcile), `check_task` and the
// reaper all read agent output, and each used to carry its own near-copy of
// this logic. They had already drifted — which is how the codex result bug
// got in: two of them looked only for a top-level `result` key, which codex
// never emits, so the caller got a token-usage line or the raw JSONL blob
// instead of the agent's answer.
//
// Three CLIs, three output shapes:
//
//   claude -p --output-format json
//     ONE JSON object with a `result` field (plus `is_error` / `subtype`).
//
//   codex exec --json
//     A JSONL event stream. The agent's answer is the `text` of the LAST
//     `item.completed` event whose `item.type` is "agent_message"; the run
//     is terminated by a `turn.completed` event. Note that the per-command
//     `command_execution` items carry their own `exit_code` — that is the
//     exit status of a command the agent ran, NOT the agent's exit status,
//     and reading it as such was the other half of the drift.
//
//   agy -p --output-format json
//     ONE JSON object again, but the answer is under `response` and the
//     verdict under `status` — no `result`, no `is_error`. Verified against
//     agy 1.1.12, which emits e.g.
//       {"conversation_id":"","status":"ERROR","response":"",
//        "error":"authentication failed or timed out","duration_seconds":0,
//        "num_turns":0,"usage":{...}}
//     This shape needs its own branch and not a `response ?? result`
//     fallback: without one, a SUCCESS envelope matches none of the rules
//     below and the caller receives the raw JSON blob where the answer
//     should be — the exact failure the codex bug in this file's history
//     was. (The ERROR case would have limped through the bare-`error`
//     rule, which is what makes the success case so easy to miss.)

export interface ParsedAgentOutput {
  /** The agent's final answer — what the calling agent should read. */
  resultText: string;
  /**
   * Exit status inferred from the output text alone, or null when the
   * output carries no verdict.
   *
   * This is only consulted on the restart path (`check_task` / the reaper),
   * where the child was spawned by a previous server process and its OS
   * exit status is no longer available to us. When the real exit code is
   * known it always wins — inference never overrides it.
   */
  inferredExitCode: number | null;
}

function tryParse(line: string): Record<string, unknown> | null {
  try {
    const o: unknown = JSON.parse(line);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Claude's shape: a lone object carrying `result`. */
function fromResultObject(o: Record<string, unknown> | null): ParsedAgentOutput | null {
  if (!o || !("result" in o)) return null;
  // `is_error: true` with an otherwise-successful envelope is how the CLI
  // reports API-level failures (e.g. an expired OAuth token), so it has to
  // count as a failure even though `subtype` still says "success".
  const isError = o.is_error === true || (typeof o.subtype === "string" && o.subtype !== "success");
  return { resultText: String(o.result ?? ""), inferredExitCode: isError ? 1 : 0 };
}

/**
 * Antigravity's shape: a lone object carrying `status` plus `response`.
 *
 * `status` is one of SUCCESS | ERROR | CANCELED | INTERRUPTED | INVALID |
 * WAITING | RUNNING. The first is success and the next four are failures;
 * WAITING and RUNNING are neither — they mean the run had not reached a
 * verdict when this envelope was written, so we return `null` and let the
 * caller's own signal (the real OS exit code, or liveness on the restart
 * path) decide. Mapping them to 0 would report a half-finished run as
 * completed; mapping them to 1 would fail a run still doing its job.
 *
 * A failed run's text comes from `error`, falling back to `response`: agy
 * leaves `response` empty on failure and puts the reason in `error`, and a
 * caller handed an empty string has been told nothing.
 */
function fromAntigravityObject(o: Record<string, unknown> | null): ParsedAgentOutput | null {
  if (!o || typeof o.status !== "string") return null;
  // Require `response` as well. `status` alone is far too common a key to
  // claim an envelope on — a bare `{"status":"ok"}` from some other tool
  // would otherwise be read as an agy verdict.
  if (!("response" in o)) return null;

  const status = o.status.toUpperCase();
  const inferredExitCode =
    status === "SUCCESS" ? 0
    : status === "WAITING" || status === "RUNNING" ? null
    : 1;

  const response = typeof o.response === "string" ? o.response : "";
  if (inferredExitCode === 0) return { resultText: response, inferredExitCode };

  const err = errorTextOf(o);
  return { resultText: err ?? response, inferredExitCode };
}

function errorTextOf(o: Record<string, unknown>): string | null {
  const e = o.error;
  if (typeof e === "string" && e.length > 0) return e;
  if (e && typeof e === "object") return JSON.stringify(e);
  if (typeof o.message === "string" && o.message.length > 0) return o.message;
  return null;
}

/**
 * Does this output look like an agent's structured event stream, rather than
 * a launcher's plain-text diagnostics?
 *
 * Used to answer "did an agent ever actually start behind this process?".
 * The CLIs emit JSON objects carrying an event `type`, a `result`, or —
 * for agy — a `status`/`response` pair; a shim that dies printing
 * `usage: bad args` emits none of them. The distinction decides whether a
 * dead launcher's failure is the whole story or whether something is still
 * working behind it, so getting it wrong means either a false failure or a
 * task left sitting at `running`.
 *
 * The agy clause is not optional garnish. Its envelope carries neither
 * `type` nor `result`, so without it every Antigravity run behind a Windows
 * .cmd shim would look like output no agent produced — and a completed run
 * would be recorded as a failure on the strength of the shim's exit status.
 */
export function looksLikeAgentStream(text: string): boolean {
  if (!text || !text.trim()) return false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const o = tryParse(trimmed);
    if (!o) continue;
    if (typeof o.type === "string" || "result" in o) return true;
    if (typeof o.status === "string" && "response" in o) return true;
  }
  return false;
}

/**
 * Decide what the caller actually gets to read, given the parsed answer and
 * whatever the run wrote to stderr.
 *
 * Every path that settles a task — dispatch's in-wait branch, its background
 * reconcile, the orphan watcher, and check_task — used to carry its own copy
 * of this rule, and every copy read stderr ONLY when the run had failed. That
 * left one case reporting nothing at all: a run that exits 0, declares
 * success, and produces an empty answer.
 *
 * It is not hypothetical. `agy` in headless mode auto-denies any tool needing
 * a permission it cannot prompt for, and when that happens it exits 0, reports
 * `status: "SUCCESS"`, returns `response: ""`, and writes the only
 * explanation to stderr:
 *
 *   jetski: no output produced — a tool required the "command" permission
 *   that headless mode cannot prompt for, so it was auto-denied. Add an
 *   allow-rule under permissions.allow in settings.json …
 *
 * Gated on failure alone, cempala recorded that as `completed`, exit 0, with
 * an empty result — telling the caller the work succeeded when nothing had
 * happened, and throwing away the one line that said why. An empty answer is
 * precisely when stderr is the only thing that can explain the outcome, so it
 * earns the read just as a failure does.
 *
 * Note what this deliberately does NOT do: it does not turn that run into a
 * `failed` one. The agent reported success and cempala relays verdicts rather
 * than inventing them — a prompt whose whole effect is a file edit can
 * legitimately return no prose, and failing it would be its own misreport.
 * The caller gets the honest pair: the status the agent gave, and the reason
 * text that explains it.
 *
 * `readStderr` is a thunk so the file is touched only when it is needed, and
 * so this module stays free of filesystem access.
 */
export function resolveResultText(opts: {
  resultText: string;
  ok: boolean;
  readStderr: () => string;
}): string {
  const { resultText, ok } = opts;
  if (ok && resultText.trim()) return resultText;

  const errText = opts.readStderr().trim();
  if (!errText) return resultText;
  if (!resultText.trim()) return errText;
  return `${resultText}\n\nstderr:\n${errText}`;
}

/**
 * Extract the agent's final answer (and, where the output says so, a verdict)
 * from captured stdout. Tolerant by design: unparseable output is handed back
 * verbatim rather than swallowed, because a caller staring at raw CLI output
 * is strictly better off than one staring at an empty string.
 */
export function parseAgentOutput(text: string): ParsedAgentOutput {
  if (!text || !text.trim()) return { resultText: "", inferredExitCode: null };

  // --- Claude: the whole file is one JSON object with `result`. ---
  const whole = fromResultObject(tryParse(text));
  if (whole) return whole;

  // --- Antigravity: the whole file is one JSON object with `status` +
  //     `response`. Checked after claude's `result` so an envelope that
  //     somehow carried both keeps its existing meaning. ---
  const wholeAg = fromAntigravityObject(tryParse(text));
  if (wholeAg) return wholeAg;

  // --- JSONL: parse every line we can, then interpret the stream. ---
  const objs = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(tryParse)
    .filter((o): o is Record<string, unknown> => o !== null);

  // A `result` field anywhere still wins — it is the canonical final answer
  // whenever a CLI emits one. Same for an agy envelope on a line of its
  // own: a CLI that prefixes its JSON with a banner line, or a shell that
  // appends one, must not cost the caller the answer.
  for (const o of objs) {
    const hit = fromResultObject(o) ?? fromAntigravityObject(o);
    if (hit) return hit;
  }

  let lastMessage: string | null = null;
  let sawCompletion = false;
  let errorText: string | null = null;

  for (const o of objs) {
    const type = typeof o.type === "string" ? o.type : "";
    const item = o.item && typeof o.item === "object" ? (o.item as Record<string, unknown>) : null;

    if (
      type === "item.completed" &&
      item &&
      item.type === "agent_message" &&
      typeof item.text === "string"
    ) {
      lastMessage = item.text;
    }

    if (type === "turn.completed" || type === "thread.completed") {
      sawCompletion = true;
      // A completion event can still carry an error: the run finished, and
      // finished badly. Reading the event's mere presence as success would
      // report exit 0 for a failed run and hide the reason in a field nobody
      // looks at.
      errorText = errorText ?? errorTextOf(o);
    }

    if (type === "turn.failed" || type === "error") {
      errorText = errorText ?? errorTextOf(o);
    } else if (!type && errorText === null) {
      // A bare `{"error": "..."}` line with no event type.
      errorText = errorTextOf(o);
    }
  }

  if (errorText) return { resultText: errorText, inferredExitCode: 1 };
  if (lastMessage !== null) {
    return { resultText: lastMessage, inferredExitCode: sawCompletion ? 0 : null };
  }
  if (sawCompletion) return { resultText: text.trim(), inferredExitCode: 0 };

  // Nothing structured to go on — raw text, no verdict.
  return { resultText: text.trim(), inferredExitCode: null };
}
