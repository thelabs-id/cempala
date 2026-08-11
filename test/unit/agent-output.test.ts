// test/unit/agent-output.test.ts
//
// Regression tests for the shared agent-output parser. The bug these pin
// down: for `codex exec --json`, the caller used to receive the
// `turn.completed` token-usage line (or the whole raw JSONL blob) instead of
// the agent's actual answer, because the parser only looked for a top-level
// `result` key — a shape codex never emits.

import { describe, test, expect } from "bun:test";
import { parseAgentOutput, looksLikeAgentStream, resolveResultText } from "../../src/tools/agent-output.ts";

// A faithful codex `--json` transcript, trimmed to the events that matter.
const CODEX_OK = [
  `{"type":"thread.started","thread_id":"019fb1ea-80cc-7982-a385-456a0bd289b9"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Creating the file now."}}`,
  `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"powershell -Command ...","exit_code":null,"status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"powershell -Command ...","exit_code":0,"status":"completed"}}`,
  `{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"DONE"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":28328,"output_tokens":401}}`,
].join("\n");

describe("parseAgentOutput — codex JSONL", () => {
  test("returns the agent's final message, not the usage line", () => {
    const r = parseAgentOutput(CODEX_OK);
    expect(r.resultText).toBe("DONE");
    expect(r.inferredExitCode).toBe(0);
  });

  test("does not leak token usage or raw JSONL into the result", () => {
    const r = parseAgentOutput(CODEX_OK);
    expect(r.resultText).not.toContain("usage");
    expect(r.resultText).not.toContain("turn.completed");
    expect(r.resultText).not.toContain("input_tokens");
  });

  test("the last agent_message wins over earlier ones", () => {
    const r = parseAgentOutput(CODEX_OK);
    expect(r.resultText).not.toBe("Creating the file now.");
  });

  test("a command's own exit_code is not read as the agent's exit status", () => {
    // item_1 carries exit_code 0 for a command the agent ran. If the run
    // itself never completes, we must NOT infer success from that.
    const truncated = CODEX_OK.split("\n").slice(0, 5).join("\n");
    const r = parseAgentOutput(truncated);
    expect(r.inferredExitCode).not.toBe(0);
  });

  test("a run that died mid-turn yields no verdict", () => {
    const r = parseAgentOutput(
      `{"type":"thread.started","thread_id":"x"}\n{"type":"turn.started"}`,
    );
    expect(r.inferredExitCode).toBeNull();
  });

  test("a completion event carrying an error is a failure, not a success", () => {
    // The run finished, and finished badly. Reading the completion event's
    // mere presence as success reports exit 0 for a failed run and buries the
    // reason in a field nobody reads.
    const r = parseAgentOutput(
      [
        `{"type":"turn.started"}`,
        `{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"working"}}`,
        `{"type":"thread.completed","error":"model overloaded"}`,
      ].join("\n"),
    );
    expect(r.inferredExitCode).toBe(1);
    expect(r.resultText).toBe("model overloaded");
  });

  test("turn.completed carrying an error is likewise a failure", () => {
    const r = parseAgentOutput(
      `{"type":"turn.started"}\n{"type":"turn.completed","error":"sandbox denied write"}`,
    );
    expect(r.inferredExitCode).toBe(1);
    expect(r.resultText).toBe("sandbox denied write");
  });

  test("a clean completion event is still a success", () => {
    // The mirror: guarding against errors must not make every completion look
    // like a failure.
    const r = parseAgentOutput(CODEX_OK);
    expect(r.inferredExitCode).toBe(0);
    expect(r.resultText).toBe("DONE");
  });

  test("turn.failed is surfaced as an error", () => {
    const r = parseAgentOutput(
      `{"type":"turn.started"}\n{"type":"turn.failed","error":"sandbox denied write"}`,
    );
    expect(r.inferredExitCode).toBe(1);
    expect(r.resultText).toBe("sandbox denied write");
  });
});

describe("parseAgentOutput — claude JSON", () => {
  test("extracts the result field", () => {
    const r = parseAgentOutput(
      `{"type":"result","subtype":"success","is_error":false,"result":"PONG","session_id":"abc"}`,
    );
    expect(r.resultText).toBe("PONG");
    expect(r.inferredExitCode).toBe(0);
  });

  test("is_error marks a failure even when subtype says success", () => {
    // The real shape of an expired-OAuth run: subtype "success", is_error true.
    const r = parseAgentOutput(
      `{"type":"result","subtype":"success","is_error":true,"api_error_status":401,"result":"Failed to authenticate. API Error: 401 OAuth access token has expired."}`,
    );
    expect(r.inferredExitCode).toBe(1);
    expect(r.resultText).toContain("401");
  });
});

describe("parseAgentOutput — antigravity JSON", () => {
  // The exact envelope agy 1.1.12 writes, verified by running it. Note it
  // carries neither `result` nor a `type` — the two keys every other rule
  // in the parser keys off — which is why this shape needs its own branch
  // and its own tests.
  const AG_OK = JSON.stringify({
    conversation_id: "c-1",
    status: "SUCCESS",
    response: "PONG",
    duration_seconds: 1.2,
    num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  });

  const AG_ERR = `{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}`;

  test("extracts the response field on SUCCESS", () => {
    const r = parseAgentOutput(AG_OK);
    expect(r.resultText).toBe("PONG");
    expect(r.inferredExitCode).toBe(0);
  });

  test("does not leak the raw envelope into the result", () => {
    // The regression this branch exists to prevent: with no rule for this
    // shape, a successful run falls through to "hand back the raw text"
    // and the caller reads JSON where the answer should be.
    const r = parseAgentOutput(AG_OK);
    expect(r.resultText).not.toContain("conversation_id");
    expect(r.resultText).not.toContain("usage");
    expect(r.resultText).not.toContain("num_turns");
  });

  test("ERROR reports the error text, not the empty response", () => {
    const r = parseAgentOutput(AG_ERR);
    expect(r.inferredExitCode).toBe(1);
    expect(r.resultText).toBe("authentication failed or timed out");
    expect(r.resultText).not.toBe("");
  });

  test("CANCELED / INTERRUPTED / INVALID are failures", () => {
    for (const status of ["CANCELED", "INTERRUPTED", "INVALID"]) {
      const r = parseAgentOutput(JSON.stringify({ status, response: "partial", error: `run ${status}` }));
      expect(r.inferredExitCode).toBe(1);
    }
  });

  test("WAITING / RUNNING yield NO verdict, not a success", () => {
    // These mean the run had not finished when the envelope was written.
    // Inferring 0 would record a half-done run as completed; inferring 1
    // would fail a run still doing its job. Neither is ours to decide —
    // the real exit code (or liveness) is.
    for (const status of ["WAITING", "RUNNING"]) {
      const r = parseAgentOutput(JSON.stringify({ status, response: "so far" }));
      expect(r.inferredExitCode).toBeNull();
    }
  });

  test("a bare {\"status\":...} with no `response` is NOT read as an agy envelope", () => {
    // `status` on its own is far too common a key to claim an envelope on.
    const r = parseAgentOutput(`{"status":"ok"}`);
    expect(r.inferredExitCode).toBeNull();
  });

  test("survives a banner line printed before the JSON", () => {
    const r = parseAgentOutput(`Loading workspace...\n${AG_OK}`);
    expect(r.resultText).toBe("PONG");
    expect(r.inferredExitCode).toBe(0);
  });

  test("looksLikeAgentStream recognises the envelope", () => {
    // It carries neither `type` nor `result`, so without an explicit
    // clause a run behind a Windows .cmd shim looks like output no agent
    // produced — and a completed run gets recorded as the shim's failure.
    expect(looksLikeAgentStream(AG_OK)).toBe(true);
    expect(looksLikeAgentStream(AG_ERR)).toBe(true);
    expect(looksLikeAgentStream("usage: bad args")).toBe(false);
  });
});

describe("resolveResultText — stderr is read when there is nothing else to go on", () => {
  // The real stderr line agy writes when headless mode auto-denies a tool.
  const SOFT_DENY = `jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.`;

  test("a SUCCESSFUL run with an empty answer still surfaces stderr", () => {
    // The regression. agy exits 0, says SUCCESS, returns "" — and the only
    // explanation is on stderr. Gated on failure alone, the caller was told
    // the work succeeded and given an empty string to read.
    const out = resolveResultText({ resultText: "", ok: true, readStderr: () => SOFT_DENY });
    expect(out).toBe(SOFT_DENY);
    expect(out).toContain("permissions.allow");
  });

  test("a successful run WITH an answer never reads stderr", () => {
    // Progress chatter on stderr must not be glued onto a good answer.
    let reads = 0;
    const out = resolveResultText({
      resultText: "PONG",
      ok: true,
      readStderr: () => { reads++; return "downloading model...\nthinking..."; },
    });
    expect(out).toBe("PONG");
    expect(reads).toBe(0); // lazily skipped entirely
  });

  test("a failed run with an answer appends stderr under a label", () => {
    const out = resolveResultText({ resultText: "partial work", ok: false, readStderr: () => "boom" });
    expect(out).toBe("partial work\n\nstderr:\nboom");
  });

  test("a failed run with no answer becomes the stderr text", () => {
    expect(resolveResultText({ resultText: "", ok: false, readStderr: () => "401 unauthorized" }))
      .toBe("401 unauthorized");
  });

  test("empty stderr leaves the result exactly as it was", () => {
    expect(resolveResultText({ resultText: "", ok: true, readStderr: () => "" })).toBe("");
    expect(resolveResultText({ resultText: "x", ok: false, readStderr: () => "   \n " })).toBe("x");
  });

  test("whitespace-only output counts as empty", () => {
    // "   \n" is not an answer; it must not block the stderr read.
    expect(resolveResultText({ resultText: "  \n ", ok: true, readStderr: () => SOFT_DENY }))
      .toBe(SOFT_DENY);
  });

  test("the soft-deny case does NOT become a failure — the verdict is the agent's", () => {
    // resolveResultText only ever chooses TEXT. A prompt whose whole effect
    // is a file edit can legitimately return no prose, and inventing a
    // failure for it would be its own misreport.
    const parsed = parseAgentOutput(JSON.stringify({ status: "SUCCESS", response: "" }));
    expect(parsed.inferredExitCode).toBe(0);
    expect(resolveResultText({ resultText: parsed.resultText, ok: true, readStderr: () => SOFT_DENY }))
      .toBe(SOFT_DENY);
  });
});

describe("parseAgentOutput — degenerate input", () => {
  test("empty output yields no verdict", () => {
    expect(parseAgentOutput("")).toEqual({ resultText: "", inferredExitCode: null });
    expect(parseAgentOutput("   \n  ")).toEqual({ resultText: "", inferredExitCode: null });
  });

  test("non-JSON output is handed back verbatim with no verdict", () => {
    const r = parseAgentOutput("command not found: codex");
    expect(r.resultText).toBe("command not found: codex");
    expect(r.inferredExitCode).toBeNull();
  });

  test("CRLF line endings parse the same as LF", () => {
    const r = parseAgentOutput(CODEX_OK.replace(/\n/g, "\r\n"));
    expect(r.resultText).toBe("DONE");
    expect(r.inferredExitCode).toBe(0);
  });
});
