// test/unit/register-antigravity.test.ts
//
// Antigravity has no `mcp add`, so the installer merges cempala into
// ~/.gemini/config/mcp_config.json itself. That file belongs to the user
// and may already list servers they depend on, so the tests that matter
// most here are the ones about what we DON'T write: other servers survive,
// other top-level keys survive, and a config we cannot parse is left
// exactly as it was rather than replaced with our own two lines.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWithAntigravity, describeOutcome, SERVER_KEY } from "../../src/register-antigravity.ts";

const BIN = "/home/someone/.cempala/bin/cempala";

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cempala-ag-"));
  cfgPath = join(dir, "config", "mcp_config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function read(): Record<string, any> {
  return JSON.parse(readFileSync(cfgPath, "utf-8"));
}

function write(text: string): void {
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(cfgPath, text, "utf-8");
}

describe("registerWithAntigravity — creating", () => {
  test("creates the file and its parent directories", () => {
    const o = registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath });
    expect(o.kind).toBe("created");
    expect(read().mcpServers[SERVER_KEY].command).toBe(BIN);
  });

  test("an empty file is treated as absent, not as unparseable", () => {
    // A `touch`, or an interrupted write, leaves one. Refusing to register
    // into it would send the common case down the manual path for nothing.
    write("   \n");
    const o = registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath });
    expect(o.kind).toBe("updated");
    expect(read().mcpServers[SERVER_KEY].command).toBe(BIN);
  });
});

describe("registerWithAntigravity — preserving what it did not write", () => {
  test("other MCP servers survive the merge", () => {
    write(JSON.stringify({
      mcpServers: {
        "sqlite-explorer": { command: "node", args: ["/usr/local/bin/sqlite-mcp-server.js"] },
        "my-remote": { serverUrl: "https://api.example.com/mcp/", headers: { Authorization: "Bearer x" } },
      },
    }, null, 2));

    const o = registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath });
    expect(o.kind).toBe("updated");

    const after = read();
    expect(after.mcpServers["sqlite-explorer"].args).toEqual(["/usr/local/bin/sqlite-mcp-server.js"]);
    expect(after.mcpServers["my-remote"].serverUrl).toBe("https://api.example.com/mcp/");
    expect(after.mcpServers["my-remote"].headers.Authorization).toBe("Bearer x");
    expect(after.mcpServers[SERVER_KEY].command).toBe(BIN);
  });

  test("unrelated top-level keys survive", () => {
    write(JSON.stringify({ someOtherSetting: { deep: [1, 2, 3] }, mcpServers: {} }));
    registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath });
    expect(read().someOtherSetting).toEqual({ deep: [1, 2, 3] });
  });

  test("extra fields the user added to OUR entry survive", () => {
    // Someone may have set `disabled` or `disabledTools` on cempala's own
    // entry. Rewriting the entry wholesale would silently undo that, and
    // report "updated" as though it were an improvement.
    write(JSON.stringify({
      mcpServers: { [SERVER_KEY]: { command: "/old/path/cempala", disabledTools: ["dispatch"], env: { X: "1" } } },
    }));
    const o = registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath });
    expect(o.kind).toBe("updated");

    const entry = read().mcpServers[SERVER_KEY];
    expect(entry.command).toBe(BIN); // the field we own is corrected
    expect(entry.disabledTools).toEqual(["dispatch"]); // the fields we don't are kept
    expect(entry.env).toEqual({ X: "1" });
  });
});

describe("registerWithAntigravity — idempotence (FR-22)", () => {
  test("re-running with the same binary reports unchanged and rewrites nothing", () => {
    registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath });
    const before = readFileSync(cfgPath, "utf-8");

    const o = registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath });
    expect(o.kind).toBe("unchanged");
    expect(readFileSync(cfgPath, "utf-8")).toBe(before);
  });

  test("an upgrade that moves the binary updates the command", () => {
    registerWithAntigravity({ binaryPath: "/old/cempala", configPath: cfgPath });
    const o = registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath });
    expect(o.kind).toBe("updated");
    expect(read().mcpServers[SERVER_KEY].command).toBe(BIN);
  });

  test("leaves no backup file behind", () => {
    write(JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath });
    const leftovers = readdirSync(join(dir, "config")).filter((f) => f.includes("cempala-bak"));
    expect(leftovers).toEqual([]);
  });
});

describe("registerWithAntigravity — refusing to destroy a config it cannot understand", () => {
  test("invalid JSON is left byte-for-byte untouched", () => {
    // The case this whole branch exists for. A trailing comma, a comment,
    // an edit in progress — replacing any of those with our own object
    // would delete however many servers the user had registered.
    const original = `{\n  "mcpServers": {\n    "important": { "command": "keepme" },\n  }\n}\n`;
    write(original);

    const o = registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath });
    expect(o.kind).toBe("manual");
    expect(readFileSync(cfgPath, "utf-8")).toBe(original);
    if (o.kind === "manual") {
      // The message has to be actionable: the exact JSON to paste, and
      // the path to paste it into.
      expect(o.snippet).toContain(BIN);
      expect(JSON.parse(o.snippet).mcpServers[SERVER_KEY].command).toBe(BIN);
      expect(describeOutcome(o).join("\n")).toContain(cfgPath);
    }
  });

  test("valid JSON that is not an object is left untouched", () => {
    write(`["not", "a", "config"]`);
    const o = registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath });
    expect(o.kind).toBe("manual");
    expect(readFileSync(cfgPath, "utf-8")).toBe(`["not", "a", "config"]`);
  });

  test("an mcpServers key of the wrong type is left untouched", () => {
    // Spreading over a string or array would produce a nonsense config
    // that Antigravity then fails to load — worse than not registering.
    write(`{"mcpServers": "oops"}`);
    const o = registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath });
    expect(o.kind).toBe("manual");
    expect(readFileSync(cfgPath, "utf-8")).toBe(`{"mcpServers": "oops"}`);
  });

  test("the manual path never leaves a partial file behind", () => {
    write(`{invalid`);
    registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath });
    expect(existsSync(cfgPath)).toBe(true);
    expect(readFileSync(cfgPath, "utf-8")).toBe(`{invalid`);
  });
});

describe("describeOutcome", () => {
  test("every outcome produces at least one printable line", () => {
    const outcomes = [
      { kind: "created" as const, path: cfgPath },
      { kind: "updated" as const, path: cfgPath },
      { kind: "unchanged" as const, path: cfgPath },
      { kind: "manual" as const, path: cfgPath, reason: "because", snippet: "{}" },
    ];
    for (const o of outcomes) {
      const lines = describeOutcome(o);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).toContain(cfgPath);
    }
  });
});
