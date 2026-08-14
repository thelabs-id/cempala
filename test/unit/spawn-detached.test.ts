// test/unit/spawn-detached.test.ts
//
// Covers the spawn side of FR-7: a dispatched agent should outlive the
// cempala server that spawned it.
//
// The survival assertion runs on every platform, including Windows, because
// the helper launches a real executable (bun itself) — the same shape as a
// direct `.exe` agent install such as `claude.exe`. That case is detached and
// genuinely survives.
//
// The one case that cannot survive as itself is a `.cmd` shim (how npm
// installs `codex`), which is deliberately not detached because detaching
// destroys its output capture. There the shim dies and the real agent is
// orphaned but alive — which is exactly why liveness must not read a dead pid
// as a failed task. That rule is covered by task-liveness.test.ts, and the
// classification that decides between the two is pinned below.

import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAlive, shouldDetach, spawnDetached } from "../../src/platform/spawn.ts";

const IS_WINDOWS = process.platform === "win32";

const dir = mkdtempSync(join(tmpdir(), "cempala-detach-"));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A lingering child may still hold the output file on Windows.
  }
});

const HELPER = join(import.meta.dir, "_detach-parent.ts");
const CHILD_SLEEP_MS = 2500;

async function runParent(
  tag: string,
  commandPath?: string,
): Promise<{ pid: number; marker: string; outFile: string }> {
  const marker = join(dir, `${tag}-marker.txt`);
  const outFile = join(dir, `${tag}-out.log`);
  const args = [process.execPath, "run", HELPER, marker, outFile, String(CHILD_SLEEP_MS)];
  if (commandPath) args.push(commandPath);
  const proc = Bun.spawn({
    cmd: args,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`helper failed (${exitCode}): ${await new Response(proc.stderr).text()}`);
  }
  return { pid: JSON.parse(stdout.trim()).pid as number, marker, outFile };
}

describe("spawnDetached", () => {
  test("runtime environment overrides preserve inherited PATH", async () => {
    const outFile = join(dir, "env-merge.log");
    const child = spawnDetached({
      argv: [process.execPath, "-e", `console.log(process.env.CEMPALA_TEST_OVERRIDE + ":" + Boolean(process.env.PATH))`],
      cwd: dir,
      outputFile: outFile,
      env: { CEMPALA_TEST_OVERRIDE: "present" },
    });
    expect(await child.exited).toBe(0);
    expect((await Bun.file(outFile).text()).trim()).toBe("present:true");
  });

  test(
    "the child runs to completion after the spawning process exits",
    async () => {
      const { pid, marker } = await runParent("survives");

      // The parent has exited (we awaited it) and the child is still
      // mid-sleep, so the marker must not exist yet. Without this the final
      // assertion could pass on a race we happened to win.
      expect(existsSync(marker)).toBe(false);
      expect(isAlive(pid)).toBe(true);

      await Bun.sleep(CHILD_SLEEP_MS + 2500);

      expect(existsSync(marker)).toBe(true);
      expect(await Bun.file(marker).text()).toBe("child-completed");
      expect(isAlive(pid)).toBe(false);
    },
    20_000,
  );

  test(
    "the spawn handle reports a usable pid",
    async () => {
      const { pid, marker } = await runParent("handle");
      expect(pid).toBeGreaterThan(0);
      await Bun.sleep(CHILD_SLEEP_MS + 2500);
      expect(existsSync(marker)).toBe(true);
    },
    20_000,
  );

  test.skipIf(!IS_WINDOWS)(
    "Windows: a .cmd shim is spawned non-detached, which is what keeps its output capturable",
    async () => {
      // The codex-shaped case. Detaching a .cmd shim silently destroys its
      // output capture (a completed run writes a 0-byte log), so we don't —
      // which means Bun kills the shim when this process exits.
      //
      // Deliberately NOT asserted here: that the agent the shim launched
      // survives that kill. It does for npm's shim idiom (measured against
      // the real codex CLI, and covered by the gated integration test), but
      // a plain .cmd whose child is an ordinary executable does NOT survive
      // — so survival is a property of the specific shim, not something this
      // code can promise. That is precisely why the liveness policy has to
      // be correct whichever way it goes: task-liveness.test.ts covers both
      // the survived case (no false failure) and the killed case (no false
      // success).
      const grandchild = join(dir, "grandchild.ts");
      writeFileSync(grandchild, `console.log("SHIM-STDOUT");`);
      const shim = join(dir, "agent-shim.cmd");
      writeFileSync(
        shim,
        ["@echo off", `"${process.execPath}" run "${grandchild}"`, ""].join("\r\n"),
      );
      expect(shouldDetach(shim)).toBe(false);
    },
    20_000,
  );
});

describe("shouldDetach", () => {
  // Detaching is not a free win on Windows: for a .cmd shim it silently
  // destroys output capture (a completed run writes a 0-byte log and the
  // agent's answer is lost), while for a real .exe it works properly and
  // makes the recorded pid the agent's own. Getting this classification
  // backwards is silent in both directions — a lost result, or an agent
  // killed mid-run — so it is pinned here.
  test("POSIX detaches everything", () => {
    if (IS_WINDOWS) return;
    expect(shouldDetach("codex")).toBe(true);
    expect(shouldDetach("/usr/local/bin/claude")).toBe(true);
  });

  test.skipIf(!IS_WINDOWS)("Windows: a .cmd/.bat shim is NOT detached", () => {
    const shim = join(dir, "shim-agent.cmd");
    writeFileSync(shim, "@echo off\r\necho hi\r\n");
    expect(shouldDetach(shim)).toBe(false);
    const bat = join(dir, "shim-agent.bat");
    writeFileSync(bat, "@echo off\r\necho hi\r\n");
    expect(shouldDetach(bat)).toBe(false);
    // Case-insensitively, as Windows treats extensions.
    const upper = join(dir, "SHIM-AGENT.CMD");
    writeFileSync(upper, "@echo off\r\necho hi\r\n");
    expect(shouldDetach(upper)).toBe(false);
  });

  test.skipIf(!IS_WINDOWS)("Windows: a real executable IS detached", () => {
    // bun itself — the same shape as a direct `claude.exe` install.
    expect(shouldDetach(process.execPath)).toBe(true);
  });

  test("an unresolvable name falls through to detaching", () => {
    expect(shouldDetach("definitely-not-a-real-binary-xyzzy")).toBe(true);
    expect(shouldDetach(undefined)).toBe(true);
  });
});

describe("isAlive", () => {
  test("reports the current process as alive", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  test("rejects invalid pids without throwing", () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
    expect(isAlive(1.5)).toBe(false);
  });
});
