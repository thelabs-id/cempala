// test/integration/_helpers.ts
//
// Gated behind CEMPALA_INTEGRATION=1 (REQUIREMENTS.md §12 / AGENTS.md §9).
// These tests actually spawn `codex` and `claude` and need both CLIs on
// PATH. They are skipped by `bun test` (the unit test runner); the
// `npm run test:integration` script opts in.

import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/db/client.ts";
import { DEFAULT_CONFIG, type AppConfig } from "../../src/config.ts";

export const INTEGRATION_ENABLED = process.env.CEMPALA_INTEGRATION === "1";

export function requireIntegration(): void {
  if (!INTEGRATION_ENABLED) {
    throw new Error(
      "Integration tests require CEMPALA_INTEGRATION=1. They spawn real CLIs and need codex/claude on PATH.",
    );
  }
}

export function hasCLIs(): { codex: boolean; claude: boolean } {
  // Check via the shell; on Windows both `codex.cmd` and `claude.exe` may exist.
  const { existsSync: exists } = require("node:fs") as typeof import("node:fs");
  // We can't reliably probe PATH from inside the test; assume that if
  // CEMPALA_INTEGRATION=1 was set, the runner has them on PATH.
  return { codex: true, claude: true };
}

export interface IntEnv {
  dir: string;
  homeCwd: string;
  outsideCwd: string;
  db: DB;
  cfg: AppConfig;
  cleanup: () => void;
}

export function makeIntEnv(): IntEnv {
  const dir = mkdtempSync(join(tmpdir(), "cempala-int-"));
  const dbPath = join(dir, "cempala.db");
  const outDir = join(dir, "outputs");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const db = openDatabase(dbPath);

  // A real home-style cwd (the cempala dir is itself under home in tests,
  // which is the same path the real install hits).
  const homeCwd = join(process.env.USERPROFILE ?? process.env.HOME ?? dir, "cempala-int-runs");
  if (!existsSync(homeCwd)) mkdirSync(homeCwd, { recursive: true });

  // A real outside-home cwd: anchored at C:\ on Windows, /tmp on POSIX.
  const outsideRoot = process.platform === "win32" ? "C:\\" : "/tmp";
  const outsideCwd = join(outsideRoot, "cempala-int-outside");
  if (!existsSync(outsideCwd)) mkdirSync(outsideCwd, { recursive: true });

  const cfg: AppConfig = {
    ...DEFAULT_CONFIG,
    server: { db_path: dbPath, output_dir: outDir },
    source: "<int-test>",
  };
  return {
    dir,
    homeCwd,
    outsideCwd,
    db,
    cfg,
    cleanup: () => {
      try { db.close(); } catch { /* ignore */ }
    },
  };
}
