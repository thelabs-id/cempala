// test/unit/_race-worker.ts
//
// Worker script for the two-connection claim_task race test. Spawned
// twice by the test, each with its own SQLite connection. Each worker:
//   1. Writes a `ready-*` file when it has reached the spin-wait
//   2. Spins on a single shared `go` file
//   3. Calls the real `claimTask` on its own DB connection
//   4. Writes its outcome to a result file
//
// Why this exists: `claimTask` is synchronous, so `Promise.all` of two
// claimTask calls in a single JS process serializes them and would
// hide any SELECT-then-UPDATE race in the implementation. To exercise
// real writer contention, the two calls must run in separate processes
// that each open their own SQLite connection and race the WAL. This
// worker calls the SAME `claimTask` function the production code
// uses, so any atomicity fix there is exercised here.

import { existsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { openDatabase } from "../../src/db/client.ts";
import { claimTask } from "../../src/tools/claim-task.ts";

const [, , dbPath, taskId, agentId, readyFile, goFile, outFile] = process.argv;

if (!dbPath || !taskId || !agentId || !readyFile || !goFile || !outFile) {
  console.error("usage: _race-worker.ts <dbPath> <taskId> <agentId> <readyFile> <goFile> <outFile>");
  process.exit(2);
}

// Open our own connection. We do NOT use the test's shared `DB`
// wrapper because we need a fully-independent handle. The wrapper
// itself is fine — `openDatabase` returns a real `bun:sqlite`
// connection with the same schema and PRAGMAs as the test.
const db = openDatabase(dbPath);

// Signal "I'm ready, waiting on go" BEFORE spinning. The test waits
// for BOTH ready files before releasing the `go` file, so the spin
// below is bounded and guaranteed to see both workers waiting.
writeFileSync(readyFile, "ready");
while (!existsSync(goFile)) {
  await new Promise((r) => setTimeout(r, 1));
}

// Issue the claim through the real `claimTask` function. If the
// implementation regresses to a non-atomic SELECT-then-UPDATE, this
// race test will catch it.
const r = claimTask(db, { task_id: taskId, agent_id: agentId });
let finalStatus: string | null = null;
if (!r.ok) {
  // Read the row's actual post-race state for diagnostic.
  const row = db.get<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
  finalStatus = row?.status ?? "unknown";
}
writeFileSync(
  outFile,
  JSON.stringify({
    ok: r.ok,
    agent: agentId,
    finalStatus,
    code: r.ok ? null : r.code,
    error: r.ok ? null : r.error,
  }),
);
db.close();
// Only the worker-owned ready file is cleaned up here. The shared
// `go` file is owned by the test (it created it, so it deletes it);
// unlinking it from inside the worker can race with the other
// worker reading it and leave the second worker spinning forever.
try { unlinkSync(readyFile); } catch { /* ignore */ }
