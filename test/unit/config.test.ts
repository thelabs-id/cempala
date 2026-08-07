// test/unit/config.test.ts
//
// FR-20: cempala --init writes a default config if absent; never overwrites
// an existing one. Also verifies ~ expansion and that the default config
// has the right shape (no `home_root` baked in).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, initConfigIfMissing, DEFAULT_CONFIG_TEMPLATE } from "../../src/config.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cempala-cfg-"));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("initConfigIfMissing (FR-20 / FR-22)", () => {
  test("writes a default config when none exists", () => {
    const path = join(tmp, "config.toml");
    const wrote = initConfigIfMissing(path);
    expect(wrote).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  test("does not overwrite an existing config (FR-22 idempotency)", () => {
    const path = join(tmp, "config.toml");
    writeFileSync(path, "# user content\n", "utf-8");
    const wrote = initConfigIfMissing(path);
    expect(wrote).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe("# user content\n");
  });

  test("the default config does NOT bake in home_root (per spec / §8)", () => {
    const path = join(tmp, "config.toml");
    initConfigIfMissing(path);
    const text = readFileSync(path, "utf-8");
    expect(text).not.toMatch(/^\s*home_root\s*=/m);
  });

  test("the default config includes baseline denylist entries", () => {
    const path = join(tmp, "config.toml");
    initConfigIfMissing(path);
    const text = readFileSync(path, "utf-8");
    expect(text).toContain(".ssh");
    expect(text).toContain(".aws");
  });

  test("DEFAULT_CONFIG_TEMPLATE is non-empty and well-formed TOML", () => {
    expect(DEFAULT_CONFIG_TEMPLATE.length).toBeGreaterThan(0);
    const parsed = Bun.TOML.parse(DEFAULT_CONFIG_TEMPLATE) as Record<string, unknown>;
    expect(parsed.server).toBeDefined();
    expect(parsed.trust).toBeDefined();
    expect(parsed.dispatch).toBeDefined();
  });
});

describe("loadConfig", () => {
  test("returns defaults when the file is missing", () => {
    const cfg = loadConfig(join(tmp, "nonexistent.toml"));
    expect(cfg.server.db_path).toContain(".cempala");
    expect(cfg.dispatch.allow_network_default).toBe(false);
    expect(cfg.dispatch.default_wait_seconds).toBe(120);
    expect(cfg.dispatch.max_wait_seconds).toBe(600);
  });

  test("expands `~/` against os.homedir()", () => {
    const path = join(tmp, "config.toml");
    writeFileSync(path, `[server]
db_path = "~/test-cempala-db.db"
output_dir = "~/test-cempala-output"
`, "utf-8");
    const cfg = loadConfig(path);
    expect(cfg.server.db_path).not.toContain("~");
    expect(cfg.server.db_path).toContain("test-cempala-db.db");
  });

  test("missing home_root → resolved at call time via os.homedir()", () => {
    const path = join(tmp, "config.toml");
    writeFileSync(path, "[trust]\n", "utf-8");
    const cfg = loadConfig(path);
    // home_root is undefined in the config; the resolver should return os.homedir().
    const home = cfg.trust.home_root ?? "<unset>";
    expect(home).toBe("<unset>");
  });

  test("P1: empty home_root is rejected (would let trust boundary treat '' as the root)", () => {
    // Per FR-9 / the §9 config doc: "home_root defaults to the OS home
    // directory when this key is omitted entirely." A direct
    // `home_root = ""` is NOT equivalent to omission — it's a
    // misconfiguration that, if accepted, lets evaluateTrustBoundary
    // treat the empty string as the root, matching every absolute
    // path (any path "starts with ''" trivially) and silently
    // allowing outside-home cwds. We reject it at config-load time.
    const path = join(tmp, "config.toml");
    writeFileSync(path, '[trust]\nhome_root = ""\n', "utf-8");
    expect(() => loadConfig(path)).toThrow(/home_root is empty/);
  });
});
