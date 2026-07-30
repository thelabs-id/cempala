// test/unit/agent-output.test.ts
//
// Regression tests for the shared agent-output parser. The bug these pin
// down: for `codex exec --json`, the caller used to receive the
// `turn.completed` token-usage line (or the whole raw JSONL blob) instead of
// the agent's actual answer, because the parser only looked for a top-level
// `result` key — a shape codex never emits.

import { describe, test, expect } from "bun:test";
import { parseAgentOutput } from "../../src/tools/agent-output.ts";

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
