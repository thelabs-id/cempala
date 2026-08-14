// test/unit/register-opencode.test.ts
//
// OpenCode has `mcp add` but no `mcp remove`, so the installer registers
// through the CLI and only the REMOVAL lives in our code. That asymmetry
// sets what these tests are about.
//
// The removal is a byte-level cut rather than a parse-and-reserialise,
// because OpenCode's default config is JSONC and the comments in it are the
// user's. So the assertions that matter most are about what survives: the
// comments, the other servers, the user's indentation and line endings, and
// — for anything we cannot confidently read — the file exactly as it was.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  removeServerEntry,
  unregisterFromOpenCode,
  describeUnregisterOutcome,
  SERVER_KEY,
} from "../../src/register-opencode.ts";
import { openCodeConfigCandidates } from "../../src/platform/paths.ts";

const BIN = "/home/someone/.cempala/bin/cempala";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cempala-oc-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The shape `opencode mcp add cempala -- <bin>` actually writes. */
function written(...others: string[]): string {
  const entries = [
    ...others,
    `    "${SERVER_KEY}": {\n      "type": "local",\n      "command": [\n        "${BIN}"\n      ]\n    }`,
  ];
  return `{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n${entries.join(",\n")}\n  }\n}\n`;
}

function removed(text: string): string {
  const r = removeServerEntry(text, SERVER_KEY);
  if (r.kind !== "removed") throw new Error(`expected removed, got ${r.kind}`);
  return r.text;
}

describe("removeServerEntry — position within the mcp object", () => {
  test("the only server leaves an empty mcp object behind", () => {
    // Deliberately not tidied away to `"mcp": {}` or deleted outright. An
    // empty object is OpenCode's setting to keep, and an uninstaller that
    // starts pruning keys it did not write has overstepped.
    expect(removed(written())).toBe(
      `{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n  }\n}\n`,
    );
  });

  test("first of several: the trailing comma goes with it", () => {
    const other = `    "other": {\n      "type": "local",\n      "command": ["/usr/bin/other"]\n    }`;
    const text = `{\n  "mcp": {\n    "${SERVER_KEY}": { "type": "local" },\n${other}\n  }\n}\n`;
    expect(removed(text)).toBe(`{\n  "mcp": {\n${other}\n  }\n}\n`);
  });

  test("last of several: the PRECEDING comma goes, leaving valid JSON", () => {
    // The failure mode this guards is a dangling comma on the previous
    // member — the single easiest way to write a config OpenCode then
    // refuses to load.
    const text = written(`    "other": {\n      "command": ["/usr/bin/other"]\n    }`);
    const out = removed(text);
    expect(out).toBe(
      `{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "other": {\n      "command": ["/usr/bin/other"]\n    }\n  }\n}\n`,
    );
    expect(() => JSON.parse(out)).not.toThrow();
  });

  test("middle of three: neighbours on both sides survive intact", () => {
    const a = `    "a": { "command": ["/a"] }`;
    const b = `    "b": { "command": ["/b"] }`;
    const text = `{\n  "mcp": {\n${a},\n    "${SERVER_KEY}": { "command": ["/c"] },\n${b}\n  }\n}\n`;
    const out = removed(text);
    expect(out).toBe(`{\n  "mcp": {\n${a},\n${b}\n  }\n}\n`);
    expect(Object.keys(JSON.parse(out).mcp)).toEqual(["a", "b"]);
  });

  test("no blank line is left where the entry stood", () => {
    const out = removed(written(`    "other": { "command": ["/o"] }`));
    expect(out).not.toMatch(/\n[ \t]*\n/);
  });
});

describe("removeServerEntry — what must survive", () => {
  test("comments are preserved, including one attached to another server", () => {
    const text = [
      "{",
      "  // my own notes, hand-written",
      '  "$schema": "https://opencode.ai/config.json",',
      '  "theme": "tokyonight",',
      '  "mcp": {',
      "    /* the one I actually use */",
      '    "other": { "type": "local", "command": ["/usr/bin/other"] },',
      `    "${SERVER_KEY}": { "type": "local", "command": ["${BIN}"] }`,
      "  }",
      "}",
      "",
    ].join("\n");

    const out = removed(text);
    expect(out).toContain("// my own notes, hand-written");
    expect(out).toContain("/* the one I actually use */");
    expect(out).toContain('"theme": "tokyonight"');
    expect(out).toContain('"other"');
    expect(out).not.toContain(SERVER_KEY);
  });

  test("everything outside the cut is byte-identical", () => {
    // The strongest statement of the rule: take the file we produce, and
    // the file the user would have had if cempala had never registered,
    // and they are the same bytes.
    const before = `{\n  "theme": "x",\n  "mcp": {\n    "other": { "command": ["/o"] }\n  }\n}\n`;
    const withUs = `{\n  "theme": "x",\n  "mcp": {\n    "other": { "command": ["/o"] },\n    "${SERVER_KEY}": { "command": ["${BIN}"] }\n  }\n}\n`;
    expect(removed(withUs)).toBe(before);
  });

  test("CRLF line endings are not converted", () => {
    const text = written(`    "other": { "command": ["/o"] }`).replace(/\n/g, "\r\n");
    const out = removed(text);
    expect(out).not.toContain(SERVER_KEY);
    expect(out.includes("\r\n")).toBe(true);
    // No lone LF sneaked in where a CRLF was cut out.
    expect(/[^\r]\n/.test(out)).toBe(false);
  });

  test("a file with no trailing newline does not gain one", () => {
    const text = `{"mcp":{"other":{"command":["/o"]},"${SERVER_KEY}":{"command":["${BIN}"]}}}`;
    expect(removed(text)).toBe(`{"mcp":{"other":{"command":["/o"]}}}`);
  });

  test("tabs and unusual indentation are left as found", () => {
    const text = `{\n\t"mcp": {\n\t\t"other": {"command": ["/o"]},\n\t\t"${SERVER_KEY}": {"command": ["${BIN}"]}\n\t}\n}\n`;
    expect(removed(text)).toBe(`{\n\t"mcp": {\n\t\t"other": {"command": ["/o"]}\n\t}\n}\n`);
  });
});

describe("removeServerEntry — comments belonging to the previous member", () => {
  // The last-member cut has to remove the comma that precedes it. Taking
  // the whole span from that comma to the end of our value is the obvious
  // implementation and it eats anything sitting in between — which is
  // exactly where a trailing comment about the PREVIOUS member lives.
  test("a trailing comment after the previous member's comma survives", () => {
    const text = `{\n  "mcp": {\n    "other": {}, /* documents other */\n    "${SERVER_KEY}": { "command": ["${BIN}"] }\n  }\n}\n`;
    const out = removed(text);
    expect(out).toContain("/* documents other */");
    expect(out).not.toContain(SERVER_KEY);
    expect(out).toBe(`{\n  "mcp": {\n    "other": {} /* documents other */\n  }\n}\n`);
  });

  test("a line comment between the comma and our entry survives", () => {
    const text = `{\n  "mcp": {\n    "other": {},\n    // why cempala is here\n    "${SERVER_KEY}": { "command": ["${BIN}"] }\n  }\n}\n`;
    const out = removed(text);
    expect(out).toContain("// why cempala is here");
    expect(out).not.toContain(`"${SERVER_KEY}"`);
    // Still loadable: the comma went even though the comment stayed.
    expect(out).toBe(`{\n  "mcp": {\n    "other": {}\n    // why cempala is here\n  }\n}\n`);
  });
});

describe("removeServerEntry — ambiguity is refused, not guessed", () => {
  // Duplicate keys are legal to write and ambiguous to act on. Parsers that
  // accept them generally take the last, so removing the first would delete
  // an inert entry and leave the live registration behind — the one outcome
  // an uninstaller must never produce.
  test("two cempala keys under mcp are refused", () => {
    const text = `{"mcp":{"${SERVER_KEY}":{"command":["/a"]},"${SERVER_KEY}":{"command":["/b"]}}}`;
    const r = removeServerEntry(text, SERVER_KEY);
    expect(r.kind).toBe("unparseable");
    if (r.kind === "unparseable") expect(r.reason).toContain(SERVER_KEY);
  });

  test("two mcp objects are refused rather than half-cleaned", () => {
    const text = `{"mcp":{"other":{}},"mcp":{"${SERVER_KEY}":{"command":["/b"]}}}`;
    const r = removeServerEntry(text, SERVER_KEY);
    expect(r.kind).toBe("unparseable");
    if (r.kind === "unparseable") expect(r.reason).toContain("mcp");
  });
});

describe("removeServerEntry — degenerate files", () => {
  test("a leading UTF-8 BOM is stepped over, not treated as corruption", () => {
    const text = `﻿{\n  "mcp": {\n    "other": {},\n    "${SERVER_KEY}": { "command": ["${BIN}"] }\n  }\n}\n`;
    const out = removed(text);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out).not.toContain(SERVER_KEY);
  });

  test("an empty file is absent, not a failed cleanup", () => {
    expect(removeServerEntry("", SERVER_KEY).kind).toBe("absent");
  });

  test("a whitespace-only file is absent, not a failed cleanup", () => {
    expect(removeServerEntry("\n  \t\n", SERVER_KEY).kind).toBe("absent");
  });

  test("nesting deep enough to exhaust the stack is refused, not a crash", () => {
    // An uninstall that dies with a stack trace leaves the user with no
    // idea what state their config is in.
    const deep = "[".repeat(100_000) + "]".repeat(100_000);
    const text = `{"mcp":{"${SERVER_KEY}":${deep}}}`;
    const r = removeServerEntry(text, SERVER_KEY);
    expect(r.kind).toBe("unparseable");
  });
});

describe("removeServerEntry — scanning hazards", () => {
  test("a brace inside a string value does not end the object early", () => {
    const text = `{\n  "mcp": {\n    "other": { "command": ["/bin/sh", "-c", "echo }{ \\" done"] },\n    "${SERVER_KEY}": { "command": ["${BIN}"] }\n  }\n}\n`;
    const out = removed(text);
    expect(out).toContain(`echo }{ \\" done`);
    expect(out).not.toContain(SERVER_KEY);
    expect(Object.keys(JSON.parse(out).mcp)).toEqual(["other"]);
  });

  test("a `//` inside a string is not treated as a comment", () => {
    const text = `{\n  "mcp": {\n    "other": { "url": "https://example.com/x" },\n    "${SERVER_KEY}": { "command": ["${BIN}"] }\n  }\n}\n`;
    const out = removed(text);
    expect(out).toContain("https://example.com/x");
    expect(Object.keys(JSON.parse(out).mcp)).toEqual(["other"]);
  });

  test("a trailing comma after the last member is tolerated", () => {
    const text = `{\n  "mcp": {\n    "other": { "command": ["/o"] },\n    "${SERVER_KEY}": { "command": ["${BIN}"] },\n  }\n}\n`;
    const out = removed(text);
    expect(out).not.toContain(SERVER_KEY);
    expect(out).toContain('"other"');
  });

  test("nested objects and arrays inside our own entry are consumed whole", () => {
    const text = `{\n  "mcp": {\n    "${SERVER_KEY}": { "command": ["${BIN}"], "env": { "A": "1", "B": ["x", { "y": 2 }] } },\n    "other": { "command": ["/o"] }\n  }\n}\n`;
    const out = removed(text);
    expect(out).not.toContain("cempala");
    expect(Object.keys(JSON.parse(out).mcp)).toEqual(["other"]);
  });

  test("an `mcp` key nested inside another server is not mistaken for the real one", () => {
    // The scanner walks members of the top-level object only; a value that
    // happens to contain its own "mcp" must not be descended into.
    const text = `{\n  "experimental": { "mcp": { "${SERVER_KEY}": { "command": ["/decoy"] } } },\n  "mcp": {\n    "${SERVER_KEY}": { "command": ["${BIN}"] },\n    "other": { "command": ["/o"] }\n  }\n}\n`;
    const out = removed(text);
    expect(out).toContain("/decoy");
    expect(Object.keys(JSON.parse(out).mcp)).toEqual(["other"]);
  });
});

describe("removeServerEntry — declining to act", () => {
  test("absent when there is no mcp object", () => {
    expect(removeServerEntry(`{\n  "theme": "x"\n}\n`, SERVER_KEY).kind).toBe("absent");
  });

  test("absent when mcp holds only other servers", () => {
    expect(removeServerEntry(`{"mcp":{"other":{"command":["/o"]}}}`, SERVER_KEY).kind).toBe("absent");
  });

  test("unparseable rather than a guess when the file is malformed", () => {
    // Truncated mid-file, the shape an interrupted write leaves. Refusing
    // is the only safe answer: the alternative is writing back a file we
    // did not understand.
    const r = removeServerEntry(`{\n  "mcp": {\n    "${SERVER_KEY}": { "command": [`, SERVER_KEY);
    expect(r.kind).toBe("unparseable");
  });

  test("unparseable when mcp is not an object", () => {
    const r = removeServerEntry(`{"mcp": "nonsense"}`, SERVER_KEY);
    expect(r.kind).toBe("unparseable");
    if (r.kind === "unparseable") expect(r.reason).toContain("mcp");
  });

  test("unparseable when the top level is an array", () => {
    expect(removeServerEntry(`[1, 2, 3]`, SERVER_KEY).kind).toBe("unparseable");
  });

  test("unparseable when anything follows the top-level object", () => {
    // Scanning stops at the root's closing brace, so without an explicit
    // check this edited and wrote back a file it had never read to the end.
    const r = removeServerEntry(`{"mcp":{"${SERVER_KEY}":{}}} trailing`, SERVER_KEY);
    expect(r.kind).toBe("unparseable");
  });

  test("a comment after the top-level object is still fine", () => {
    // Trivia is not content: rejecting this would refuse a file OpenCode
    // reads perfectly well.
    const text = `{\n  "mcp": { "${SERVER_KEY}": {} }\n}\n// done\n`;
    const r = removeServerEntry(text, SERVER_KEY);
    expect(r.kind).toBe("removed");
    if (r.kind === "removed") expect(r.text).toContain("// done");
  });
});

describe("config discovery — every file OpenCode reads", () => {
  const prevXdg = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  });

  // `opencode mcp add` writes opencode.json / opencode.jsonc, but OpenCode
  // also still LOADS a legacy config.json — verified against 1.18.15, where
  // a server defined only there shows as connected in `opencode mcp list`.
  // Cleaning only the files we would write leaves that one live, pointing
  // at a binary the uninstaller is about to delete.
  test("includes the legacy config.json, not just the two we write", () => {
    process.env.XDG_CONFIG_HOME = "/xdg";
    expect(openCodeConfigCandidates()).toEqual([
      "/xdg/opencode/opencode.json",
      "/xdg/opencode/opencode.jsonc",
      "/xdg/opencode/config.json",
    ]);
  });

  test("an empty XDG_CONFIG_HOME falls back to ~/.config rather than /opencode", () => {
    process.env.XDG_CONFIG_HOME = "";
    for (const p of openCodeConfigCandidates()) {
      expect(p.startsWith("/opencode")).toBe(false);
      expect(p).toContain(join(".config", "opencode"));
    }
  });

  test("a legacy config.json is found and cleaned by discovery, with no path given", () => {
    process.env.XDG_CONFIG_HOME = dir;
    mkdirSync(join(dir, "opencode"), { recursive: true });
    const p = join(dir, "opencode", "config.json");
    writeFileSync(p, `{"mcp":{"${SERVER_KEY}":{"command":["${BIN}"]}}}`);

    const outcomes = unregisterFromOpenCode();
    expect(outcomes.some((o) => o.kind === "removed" && o.path === p)).toBe(true);
    expect(readFileSync(p, "utf-8")).not.toContain(SERVER_KEY);
  });

  test("all three files are cleaned in one run when all three hold an entry", () => {
    process.env.XDG_CONFIG_HOME = dir;
    mkdirSync(join(dir, "opencode"), { recursive: true });
    const paths = ["opencode.json", "opencode.jsonc", "config.json"].map((n) => {
      const p = join(dir, "opencode", n);
      writeFileSync(p, `{"mcp":{"other":{"command":["/o"]},"${SERVER_KEY}":{"command":["${BIN}"]}}}`);
      return p;
    });

    const outcomes = unregisterFromOpenCode();
    expect(outcomes.filter((o) => o.kind === "removed")).toHaveLength(3);
    for (const p of paths) {
      expect(readFileSync(p, "utf-8")).not.toContain(SERVER_KEY);
      expect(readFileSync(p, "utf-8")).toContain('"other"');
    }
  });
});

describe("unregisterFromOpenCode — on disk", () => {
  function writeConfig(name: string, contents: string): string {
    mkdirSync(join(dir, "opencode"), { recursive: true });
    const p = join(dir, "opencode", name);
    writeFileSync(p, contents);
    return p;
  }

  test("removes the entry and reports the file it came from", () => {
    const p = writeConfig("opencode.jsonc", written(`    "other": { "command": ["/o"] }`));
    const outcomes = unregisterFromOpenCode({ configPath: p });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.kind).toBe("removed");
    expect(readFileSync(p, "utf-8")).not.toContain(SERVER_KEY);
    expect(readFileSync(p, "utf-8")).toContain('"other"');
  });

  test("absent, not an error, when the file does not exist", () => {
    const outcomes = unregisterFromOpenCode({ configPath: join(dir, "nope.json") });
    expect(outcomes[0]!.kind).toBe("absent");
  });

  test("a malformed config is left byte-identical and reported as manual", () => {
    const broken = `{ "mcp": { "${SERVER_KEY}": `;
    const p = writeConfig("opencode.json", broken);
    const outcomes = unregisterFromOpenCode({ configPath: p });
    expect(outcomes[0]!.kind).toBe("manual");
    expect(readFileSync(p, "utf-8")).toBe(broken);
  });

  test("the manual message names the file, so it is actionable on its own", () => {
    const p = writeConfig("opencode.json", `{ "mcp": { "${SERVER_KEY}": `);
    const lines = describeUnregisterOutcome(unregisterFromOpenCode({ configPath: p })[0]!);
    expect(lines.join("\n")).toContain(p);
  });

  test("an unparseable config that never mentions cempala is absent, not a failure", () => {
    // Unregistration visits three files, two of which cempala never
    // writes. A malformed legacy config.json that cannot contain our entry
    // must not fail the whole uninstall — non-zero exit, binary kept,
    // --purge refused — over a file that was never ours.
    const p = writeConfig("config.json", `{ "theme": [[[ }`);
    const outcomes = unregisterFromOpenCode({ configPath: p });
    expect(outcomes[0]!.kind).toBe("absent");
  });

  test("a locked file reports THIS command as the remedy, not the antigravity one", () => {
    // The shared helper defaults to `cempala --register-antigravity`. Left
    // unparameterised, the one actionable line a half-failed uninstall
    // prints told the user to go and register.
    const p = writeConfig("opencode.jsonc", written());
    writeFileSync(`${p}.cempala-lock`, "someone-else");
    try {
      const outcome = unregisterFromOpenCode({ configPath: p })[0]!;
      expect(outcome.kind).toBe("manual");
      const text = describeUnregisterOutcome(outcome).join("\n");
      expect(text).toContain("--unregister-opencode");
      expect(text).not.toContain("--register-antigravity");
    } finally {
      rmSync(`${p}.cempala-lock`, { force: true });
    }
  });

  test("a symlinked config is written THROUGH, staying a symlink", () => {
    // Preserving symlinks is the stated reason for reusing
    // writeBackPreservingLinks; a config symlinked into a dotfiles repo is
    // the case that proves it.
    mkdirSync(join(dir, "dotfiles"), { recursive: true });
    mkdirSync(join(dir, "opencode"), { recursive: true });
    const real = join(dir, "dotfiles", "opencode.jsonc");
    const link = join(dir, "opencode", "opencode.jsonc");
    writeFileSync(real, written(`    "other": { "command": ["/o"] }`));
    symlinkSync(real, link);

    expect(unregisterFromOpenCode({ configPath: link })[0]!.kind).toBe("removed");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf-8")).not.toContain(SERVER_KEY);
    expect(readFileSync(real, "utf-8")).toContain('"other"');
  });

  test("running twice is safe — the second pass reports absent", () => {
    const p = writeConfig("opencode.jsonc", written());
    expect(unregisterFromOpenCode({ configPath: p })[0]!.kind).toBe("removed");
    expect(unregisterFromOpenCode({ configPath: p })[0]!.kind).toBe("absent");
  });
});
