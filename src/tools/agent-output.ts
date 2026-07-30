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
// Two CLIs, two output shapes:
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
 * Both CLIs emit JSON objects carrying either an event `type` or a `result`;
 * a shim that dies printing `usage: bad args` emits neither. The distinction
 * decides whether a dead launcher's failure is the whole story or whether
 * something is still working behind it, so getting it wrong means either a
 * false failure or a task left sitting at `running`.
 */
export function looksLikeAgentStream(text: string): boolean {
  if (!text || !text.trim()) return false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const o = tryParse(trimmed);
    if (o && (typeof o.type === "string" || "result" in o)) return true;
  }
  return false;
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

  // --- JSONL: parse every line we can, then interpret the stream. ---
  const objs = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(tryParse)
    .filter((o): o is Record<string, unknown> => o !== null);

  // A `result` field anywhere still wins — it is the canonical final answer
  // whenever a CLI emits one.
  for (const o of objs) {
    const hit = fromResultObject(o);
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
