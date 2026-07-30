// test/unit/_detach-parent.ts
//
// Helper for spawn-detached.test.ts. Spawns a child via spawnDetached, prints
// its pid, then exits IMMEDIATELY. The point is to die while the child is
// still working, so the test can prove the child outlives us.
//
// Run as: bun run _detach-parent.ts <markerFile> <outputFile> <sleepMs> [commandPath]
//
// With no commandPath the child is bun itself — a real executable, the shape
// of a direct `claude.exe` install. With a commandPath (a .cmd shim) the
// child is that script, the shape npm installs for `codex`; the script is
// passed the marker file as its first argument.

import { spawnDetached } from "../../src/platform/spawn.ts";
import { dirname } from "node:path";

const [markerFile, outputFile, sleepMs, commandPath] = process.argv.slice(2);
if (!markerFile || !outputFile || !sleepMs) {
  console.error("usage: _detach-parent.ts <markerFile> <outputFile> <sleepMs> [commandPath]");
  process.exit(2);
}

// The child sleeps past our own exit, then writes the marker. If the child is
// killed when we exit, the marker never appears — which is exactly the bug.
const childSource = `await Bun.sleep(${Number(sleepMs)}); await Bun.write(${JSON.stringify(markerFile)}, "child-completed");`;

const argv = commandPath
  ? [commandPath, markerFile]
  : [process.execPath, "-e", childSource];

const handle = spawnDetached({
  argv,
  cwd: dirname(outputFile),
  outputFile,
});

console.log(JSON.stringify({ pid: handle.pid }));

// Hard exit: no waiting on the child, no graceful teardown. This mirrors the
// cempala server being restarted or killed mid-dispatch.
process.exit(0);
