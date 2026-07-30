// test/unit/task-liveness.test.ts
//
// The load-bearing regression test for the false-failure bug.
//
// Observed on Windows: a dispatch outlived the cempala server, the recorded
// pid (a .cmd shim) died with the server, and check_task therefore reported
// the task `failed` with exit -1 — while the agent went right on working and
// completed successfully. Any policy that reads "recorded pid is dead" as
// "the task failed" reproduces that bug, so these tests pin the policy, not
// the implementation.

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessTask, ACTIVITY_GRACE_MS, UNSTRUCTURED_ACTIVITY_GRACE_MS } from "../../src/tools/task-liveness.ts";

const dir = mkdtempSync(join(tmpdir(), "cempala-liveness-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
let outFile = "";
beforeEach(() => {
  outFile = join(dir, `out-${seq++}.log`);
});

/** A pid that is certainly not running. */
const DEAD_PID = 0x7ffffff0;
/** Our own pid — certainly running. */
const LIVE_PID = process.pid;

function write(text: string, ageMs = 0) {
  writeFileSync(outFile, text);
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(outFile, when, when);
  }
}

const CODEX_DONE = [
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"DONE"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":1}}`,
].join("\n");

const CODEX_MIDRUN = [
  `{"type":"thread.started","thread_id":"x"}`,
  `{"type":"turn.started"}`,
].join("\n");

describe("assessTask", () => {
  test("THE BUG: a dead pid mid-run is NOT reported as finished", () => {
    // Exactly the observed case: shim dead, agent still working, output has
    // no verdict yet but was just written.
    write(CODEX_MIDRUN);
    const r = assessTask({ pid: DEAD_PID, outputFile: outFile });
    expect(r.state).toBe("running");
  });

  test("a completed run is finished with its real result, even with a dead pid", () => {
    write(CODEX_DONE);
    const r = assessTask({ pid: DEAD_PID, outputFile: outFile });
    expect(r.state).toBe("finished");
    if (r.state === "finished") {
      expect(r.exitCode).toBe(0);
      expect(r.resultText).toBe("DONE");
    }
  });

  test("a completed run is finished even while the pid is still alive", () => {
    // Guards against pid reuse pinning a finished task at `running` forever.
    write(CODEX_DONE);
    const r = assessTask({ pid: LIVE_PID, outputFile: outFile });
    expect(r.state).toBe("finished");
  });

  test("a live pid with no verdict is still running", () => {
    write(CODEX_MIDRUN);
    expect(assessTask({ pid: LIVE_PID, outputFile: outFile }).state).toBe("running");
  });

  test("a dead pid with stale output and no verdict is abandoned", () => {
    write(CODEX_MIDRUN, ACTIVITY_GRACE_MS * 2);
    expect(assessTask({ pid: DEAD_PID, outputFile: outFile }).state).toBe("abandoned");
  });

  test("activity just inside the grace window still counts as running", () => {
    write(CODEX_MIDRUN, Math.floor(ACTIVITY_GRACE_MS / 2));
    expect(assessTask({ pid: DEAD_PID, outputFile: outFile }).state).toBe("running");
  });

  test("a failed run is finished with a non-zero exit code", () => {
    write(`{"type":"turn.failed","error":"sandbox denied write"}`);
    const r = assessTask({ pid: DEAD_PID, outputFile: outFile });
    expect(r.state).toBe("finished");
    if (r.state === "finished") {
      expect(r.exitCode).toBe(1);
      expect(r.resultText).toBe("sandbox denied write");
    }
  });

  test("claude's single-object output is recognised as finished", () => {
    write(`{"type":"result","subtype":"success","is_error":false,"result":"PONG"}`);
    const r = assessTask({ pid: DEAD_PID, outputFile: outFile });
    expect(r.state).toBe("finished");
    if (r.state === "finished") expect(r.resultText).toBe("PONG");
  });

  test("a dead pid with no output file at all is abandoned", () => {
    expect(assessTask({ pid: DEAD_PID, outputFile: join(dir, "missing.log") }).state).toBe(
      "abandoned",
    );
  });

  test("a null pid falls back to output activity", () => {
    write(CODEX_MIDRUN);
    expect(assessTask({ pid: null, outputFile: outFile }).state).toBe("running");
    write(CODEX_MIDRUN, ACTIVITY_GRACE_MS * 2);
    expect(assessTask({ pid: null, outputFile: outFile }).state).toBe("abandoned");
  });

  test("an empty output file from a dead run is abandoned once stale", () => {
    write("", ACTIVITY_GRACE_MS * 2);
    expect(assessTask({ pid: DEAD_PID, outputFile: outFile }).state).toBe("abandoned");
  });

  test("recent stderr keeps a task running when stdout has gone quiet", () => {
    // Plenty of CLIs report progress on stderr while stdout stays silent
    // until the final JSON. Judging activity on stdout alone would call such
    // a run abandoned while it is demonstrably still working.
    write(CODEX_MIDRUN, ACTIVITY_GRACE_MS * 2);
    writeFileSync(`${outFile}.err`, "still thinking...");
    expect(assessTask({ pid: DEAD_PID, outputFile: outFile }).state).toBe("running");
  });

  test("both streams stale with no verdict is abandoned", () => {
    write(CODEX_MIDRUN, ACTIVITY_GRACE_MS * 2);
    const errFile = `${outFile}.err`;
    writeFileSync(errFile, "old noise");
    const when = new Date(Date.now() - ACTIVITY_GRACE_MS * 2);
    utimesSync(errFile, when, when);
    expect(assessTask({ pid: DEAD_PID, outputFile: outFile }).state).toBe("abandoned");
  });

  test("output that is NOT an agent stream falls out of `running` quickly", () => {
    // A launcher that died printing a usage error leaves non-empty,
    // just-written output. Giving that the full 30-minute window would park
    // a real, immediate failure at `running` — trading a false failure for a
    // stuck task. It gets the short window instead.
    write("usage: bad args\nsee --help for details", UNSTRUCTURED_ACTIVITY_GRACE_MS * 2);
    expect(assessTask({ pid: DEAD_PID, outputFile: outFile }).state).toBe("abandoned");
    // ...but well inside the full window, so it is the SHORT one deciding.
    expect(UNSTRUCTURED_ACTIVITY_GRACE_MS * 2).toBeLessThan(ACTIVITY_GRACE_MS);
  });

  test("stderr-only progress with an empty stdout counts as life", () => {
    // Plenty of CLIs report progress on stderr and write nothing to stdout
    // until the final JSON. Requiring an agent-looking STDOUT before stderr
    // activity counts would call such a run abandoned — and `check_task`
    // would fail it — while it is demonstrably still working.
    write("");
    writeFileSync(`${outFile}.err`, "thinking... 40%");
    expect(assessTask({ pid: DEAD_PID, outputFile: outFile }).state).toBe("running");
  });

  test("an agent that keeps writing keeps renewing its own lease", () => {
    // The short window is not a deadline on the run, only on silence: each
    // fresh write pushes it forward again.
    write("progress: step 1", UNSTRUCTURED_ACTIVITY_GRACE_MS * 2);
    expect(assessTask({ pid: DEAD_PID, outputFile: outFile }).state).toBe("abandoned");
    write("progress: step 2"); // written just now
    expect(assessTask({ pid: DEAD_PID, outputFile: outFile }).state).toBe("running");
  });

  test("when the pid WAS the agent, its death is conclusive — no waiting out the window", () => {
    // The grace window exists for launchers that die in front of a living
    // agent. When the recorded pid is the agent itself (POSIX, or a direct
    // .exe on Windows), its death ends the run, and FR-7's "process has
    // exited -> reconcile from output" must happen now rather than 30
    // minutes later.
    write(CODEX_MIDRUN); // fresh agent output, but the agent is gone
    expect(assessTask({ pid: DEAD_PID, pidIsAgent: true, outputFile: outFile }).state).toBe(
      "abandoned",
    );
    // Same inputs, launcher pid: the output still gets the benefit of the doubt.
    expect(assessTask({ pid: DEAD_PID, pidIsAgent: false, outputFile: outFile }).state).toBe(
      "running",
    );
  });

  test("a verdict still wins even when the pid was the agent", () => {
    write(CODEX_DONE);
    const r = assessTask({ pid: DEAD_PID, pidIsAgent: true, outputFile: outFile });
    expect(r.state).toBe("finished");
    if (r.state === "finished") expect(r.resultText).toBe("DONE");
  });

  test("pidIsAgent defaults to the conservative reading", () => {
    // Rows written before the column existed read as NULL -> false, so they
    // keep the safe behavior rather than being newly treated as conclusive.
    write(CODEX_MIDRUN);
    expect(assessTask({ pid: DEAD_PID, outputFile: outFile }).state).toBe("running");
  });

  test("a partial agent stream, freshly written, still counts as life", () => {
    // The mirror of the case above — this one really is an agent mid-run.
    write(CODEX_MIDRUN);
    expect(assessTask({ pid: DEAD_PID, outputFile: outFile }).state).toBe("running");
  });

  test("the grace window is FR-17's stale window, not a shorter one", () => {
    // A 2-minute window would declare a quietly-reasoning agent abandoned.
    // Pinning this stops that regression from sneaking back in.
    expect(ACTIVITY_GRACE_MS).toBe(30 * 60 * 1000);
    write(CODEX_MIDRUN, 5 * 60 * 1000);
    expect(assessTask({ pid: DEAD_PID, outputFile: outFile }).state).toBe("running");
  });
});
