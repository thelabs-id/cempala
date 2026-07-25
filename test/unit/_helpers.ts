// test/unit/_helpers.ts
//
// Test helpers shared across unit tests. Provides:
//   - makeEnv()       — fresh in-memory DB + tmp dirs for a test
//   - outsideHomeDir() — a real, exists-on-disk, OUTSIDE the home dir;
//                        portable across Windows / macOS / Linux
//   - withEnv()       — async wrapper that auto-cleans the env
//
// Tests use bun:test, which is built into Bun — no extra deps.

import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/db/client.ts";
import { DEFAULT_CONFIG, type AppConfig } from "../../src/config.ts";
import { canonicalize } from "../../src/security/paths.ts";

export interface TestEnv {
  dir: string;
  db: DB;
  cfg: AppConfig;
  cleanup: () => void;
}

export function makeEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "cempala-test-"));
  const dbPath = join(dir, "cempala.db");
  const outDir = join(dir, "outputs");
  const db = openDatabase(dbPath);
  const cfg: AppConfig = {
    ...DEFAULT_CONFIG,
    server: { db_path: dbPath, output_dir: outDir },
    source: "<test>",
  };
  return {
    dir,
    db,
    cfg,
    cleanup: () => {
      try { db.close(); } catch { /* ignore */ }
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    },
  };
}

export function withEnv(fn: (env: TestEnv) => void | Promise<void>) {
  return async () => {
    const env = makeEnv();
    try {
      await fn(env);
    } finally {
      env.cleanup();
    }
  };
}

/**
 * Create a fresh, real-on-disk, OUTSIDE-the-home directory. Portable:
 *   - Windows: C:\cempala-outside-<rand>
 *   - macOS/Linux: /tmp/cempala-outside-<rand>
 *
 * `os.tmpdir()` is INSIDE the home on Windows (it lives under
 * %USERPROFILE%), so we can't use it for outside-home fixtures. On
 * macOS/Linux it's `/tmp` and is outside the home for our test
 * purposes. The split above is the only reliable portable approach.
 */
export function outsideHomeDir(prefix: string = "cempala-outside-"): string {
  const base = process.platform === "win32" ? "C:\\" : "/tmp";
  return mkdtempSync(join(base, prefix));
}

/**
 * The canonicalized home directory for the test environment. Used by
 * tests that need to assert "the trust boundary saw the canonical
 * home, not a different path" (e.g. cwd="~" expansion).
 */
export function canonicalizeHome(): string {
  return canonicalize(homedir());
}
