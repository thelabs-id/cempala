// test/unit/register-antigravity.test.ts
//
// Antigravity has no `mcp add`, so the installer merges cempala into
// ~/.gemini/config/mcp_config.json itself. That file belongs to the user
// and may already list servers they depend on, so the tests that matter
// most here are the ones about what we DON'T write: other servers survive,
// other top-level keys survive, and a config we cannot parse is left
// exactly as it was rather than replaced with our own two lines.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, utimesSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWithAntigravity, unregisterFromAntigravity, describeOutcome, describeUnregisterOutcome, SERVER_KEY, backupPathFor, acquireLock } from "../../src/register-antigravity.ts";

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

describe("registerWithAntigravity — failure leaves nothing broken behind", () => {
  test.skipIf(process.platform === "win32")(
    "a create that cannot be completed does not leave an empty file behind",
    () => {
      // openSync("wx") succeeds the moment the file exists, before a single
      // byte is written. If filling it then fails, reporting `manual` while
      // leaving a zero-byte config on disk would hand Antigravity a file
      // cempala created and abandoned — and an empty mcp_config.json is
      // exactly what this module treats as "absent", so the damage hides
      // itself.
      //
      // A directory that permits creation but not writing is the honest
      // way to reach that path.
      const d = join(dir, "config");
      mkdirSync(d, { recursive: true });
      const target = join(d, "mcp_config.json");

      // Pre-create the parent as read-only AFTER ensuring it exists, so
      // openSync itself fails rather than the write. This asserts the
      // weaker but reliable property: no partial file is left.
      chmodSync(d, 0o500);
      try {
        const o = registerWithAntigravity({ binaryPath: BIN, configPath: target });
        expect(o.kind).toBe("manual");
        expect(existsSync(target)).toBe(false);
      } finally {
        chmodSync(d, 0o700);
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "an unwritable directory leaves the config untouched and says why honestly",
    () => {
      // An unwritable directory blocks the LOCK first, before any of the
      // backup or write logic is reached. The outcome must still be safe —
      // and the reason must not claim a cause it cannot know. Reporting
      // "another process is registering" here would send someone hunting
      // for a second cempala that was never running.
      write(JSON.stringify({ mcpServers: { precious: { command: "keepme" } } }));
      const original = readFileSync(cfgPath, "utf-8");
      const d = join(dir, "config");
      chmodSync(d, 0o500);
      try {
        const o = registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath });
        expect(o.kind).toBe("manual");
        if (o.kind === "manual") {
          expect(o.reason).toContain("not be writable");
          expect(o.reason).not.toContain("another process");
        }
        // And the config is exactly as it was.
        expect(readFileSync(cfgPath, "utf-8")).toBe(original);
      } finally {
        chmodSync(d, 0o700);
      }
    },
  );

  test("a live foreign lock still reports contention, not a permissions problem", () => {
    write(JSON.stringify({ mcpServers: {} }));
    writeFileSync(`${cfgPath}.cempala-lock`, "someone-else", "utf-8");
    const o = registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath });
    expect(o.kind).toBe("manual");
    if (o.kind === "manual") {
      // Names what was actually observed — a lock file in the way — and
      // does not assert a live process it cannot see.
      expect(o.reason).toContain("lock file");
      expect(o.reason).not.toContain("not be writable");
    }
  }, { timeout: 15_000 });
});

describe("registerWithAntigravity — locking and concurrent writers", () => {
  test("each registration merges onto the CURRENT file, never a remembered snapshot", () => {
    // The lost-update shape, at the granularity this test can observe
    // deterministically: a foreign writer changes the config between two
    // registrations, and the second must build on what is there now. A
    // run that merged onto anything it had cached earlier would delete B.
    //
    // (The narrower in-flight window — a foreign write landing between one
    // call's own read and its write — is closed by the content check in
    // writeBackPreservingLinks, which refuses rather than overwrites.
    // Racing that deterministically would need a filesystem hook, and a
    // timing-dependent test here would be flakier than the code is risky.)
    write(JSON.stringify({ mcpServers: { A: { command: "a" } } }));

    expect(registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath }).kind).toBe("updated");

    // A foreign writer (Antigravity itself, or a hand edit) adds B.
    writeFileSync(cfgPath, JSON.stringify({
      mcpServers: { A: { command: "a" }, B: { command: "b" }, [SERVER_KEY]: { command: BIN } },
    }), "utf-8");

    const o = registerWithAntigravity({ binaryPath: "/new/path/cempala", configPath: cfgPath });
    expect(o.kind).toBe("updated");

    const after = read();
    expect(after.mcpServers.B?.command).toBe("b"); // survived
    expect(after.mcpServers.A?.command).toBe("a");
    expect(after.mcpServers[SERVER_KEY].command).toBe("/new/path/cempala");
  });

  test("backup file names are unique per invocation, never a shared fixed name", () => {
    // A fixed `.cempala-bak` is a shared mutable file: two registrations at
    // once copy different versions of the config to the same path, and one
    // can then restore the other's snapshot on failure or unlink the backup
    // it still needs. install.sh uses mktemp for rc-file backups for exactly
    // this reason.
    //
    // Asserted on the generator, because a successful registration always
    // cleans its backup up — the uniqueness is invisible from the outside.
    const names = new Set(Array.from({ length: 50 }, () => backupPathFor(cfgPath)));
    expect(names.size).toBe(50);
    for (const n of names) expect(n).toContain("cempala-bak");
  });

  test("no backup file survives a successful registration", () => {
    write(JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    for (let i = 0; i < 3; i++) {
      registerWithAntigravity({ binaryPath: `/bin/cempala-${i}`, configPath: cfgPath });
    }
    expect(readdirSync(join(dir, "config")).filter((f) => f.includes("cempala-bak"))).toEqual([]);
    const after = read();
    expect(after.mcpServers.other.command).toBe("x");
    expect(after.mcpServers[SERVER_KEY].command).toBe("/bin/cempala-2");
  });

  test("a stale lock file left by a killed installer does not block registration forever", () => {
    // An installer killed mid-write must not wedge every future run behind
    // a lock nobody will delete.
    write(JSON.stringify({ mcpServers: {} }));
    const lockPath = `${cfgPath}.cempala-lock`;
    writeFileSync(lockPath, "99999", "utf-8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const o = registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath });
    expect(o.kind).toBe("updated");
    expect(read().mcpServers[SERVER_KEY].command).toBe(BIN);
  });

  test("the lock file is released, not left behind", () => {
    registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath });
    expect(existsSync(`${cfgPath}.cempala-lock`)).toBe(false);
  });

  test("a live lock held by another process makes us REFUSE, never write unlocked", () => {
    // The lock is only load-bearing when contended. Carrying on unlocked
    // there would let two processes both pass the content check and have
    // the second write erase the first — abandoning serialization at
    // exactly the moment it matters.
    write(JSON.stringify({ mcpServers: { keepme: { command: "x" } } }));
    const original = readFileSync(cfgPath, "utf-8");
    const lockPath = `${cfgPath}.cempala-lock`;
    writeFileSync(lockPath, "someone-elses-token", "utf-8"); // fresh → not stale

    const o = registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath });
    expect(o.kind).toBe("manual");
    if (o.kind === "manual") expect(o.reason).toContain("lock file");
    // Nothing written, and the other process's lock is still theirs —
    // release must not remove a lock we never owned.
    expect(readFileSync(cfgPath, "utf-8")).toBe(original);
    expect(readFileSync(lockPath, "utf-8")).toBe("someone-elses-token");
  }, { timeout: 15_000 }); // it deliberately waits out LOCK_WAIT_MS first

  test("release does NOT remove a lock that was stolen and re-taken by someone else", () => {
    // Without an ownership token, a holder whose lock had been stolen as
    // stale would, on finishing, unlink the REPLACEMENT holder's lock and
    // let a third writer in. Driven directly against acquireLock so the
    // replacement actually happens before release, which the previous
    // version of this test only claimed to do.
    mkdirSync(join(dir, "config"), { recursive: true });
    const target = join(dir, "config", "locktest.json");
    const lockPath = `${target}.cempala-lock`;

    const mine = acquireLock(target);
    expect(mine).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);

    // A third party replaces the lock with one of its own.
    writeFileSync(lockPath, "somebody-elses-token", "utf-8");

    mine!.release();

    // Theirs must survive — releasing is only ever ours to do.
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe("somebody-elses-token");
  });

  test("release removes the lock when it is still ours", () => {
    mkdirSync(join(dir, "config"), { recursive: true });
    const target = join(dir, "config", "locktest2.json");
    const mine = acquireLock(target);
    expect(mine).not.toBeNull();
    mine!.release();
    expect(existsSync(`${target}.cempala-lock`)).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "acquireLock terminates instead of spinning when the lock cannot be created",
    () => {
      // tryClaim cannot distinguish "held by someone" from "the directory
      // is unwritable". An earlier version treated every stat failure as
      // "released, retry now" with a bare `continue`, and in an unwritable
      // directory there is no lock file to stat — so that path never slept
      // and never checked the deadline. A permissions problem became an
      // unbounded CPU spin.
      //
      // A read-only directory is the honest reproduction: mkdirSync
      // succeeds on any path it is allowed to create, so a merely deep
      // path proves nothing.
      const locked = join(dir, "readonly");
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o500); // r-x: cannot create entries
      try {
        const started = Date.now();
        const lock = acquireLock(join(locked, "x.json"));
        const elapsed = Date.now() - started;
        expect(lock).toBeNull();
        // Bounded by LOCK_WAIT_MS rather than looping forever.
        expect(elapsed).toBeLessThan(10_000);
      } finally {
        chmodSync(locked, 0o700); // so afterEach can clean up
      }
    },
    { timeout: 20_000 },
  );

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

describe("unregisterFromAntigravity — removing only what we put there", () => {
  test("removes cempala and leaves every other server untouched", () => {
    write(JSON.stringify({
      mcpServers: {
        "sqlite-explorer": { command: "node", args: ["/x.js"] },
        [SERVER_KEY]: { command: BIN },
        "my-remote": { serverUrl: "https://api.example.com/mcp/" },
      },
      someOtherSetting: { deep: [1, 2, 3] },
    }, null, 2));

    const o = unregisterFromAntigravity({ configPath: cfgPath });
    expect(o.kind).toBe("removed");

    const after = read();
    expect(after.mcpServers[SERVER_KEY]).toBeUndefined();
    expect(after.mcpServers["sqlite-explorer"].args).toEqual(["/x.js"]);
    expect(after.mcpServers["my-remote"].serverUrl).toBe("https://api.example.com/mcp/");
    expect(after.someOtherSetting).toEqual({ deep: [1, 2, 3] });
  });

  test("leaves an empty mcpServers object rather than tidying it away", () => {
    // An empty `mcpServers` is what Antigravity itself creates on first
    // run. Removing it would be us editing a file we were asked to
    // withdraw from.
    write(JSON.stringify({ mcpServers: { [SERVER_KEY]: { command: BIN } } }));
    expect(unregisterFromAntigravity({ configPath: cfgPath }).kind).toBe("removed");
    expect(read().mcpServers).toEqual({});
  });

  test("never deletes the file — it is Antigravity's, not ours", () => {
    write(JSON.stringify({ mcpServers: { [SERVER_KEY]: { command: BIN } } }));
    unregisterFromAntigravity({ configPath: cfgPath });
    expect(existsSync(cfgPath)).toBe(true);
  });

  test("a missing config is `absent`, not an error", () => {
    expect(unregisterFromAntigravity({ configPath: cfgPath }).kind).toBe("absent");
  });

  test("a config without a cempala entry is `absent` and is not rewritten", () => {
    const original = JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2);
    write(original);
    expect(unregisterFromAntigravity({ configPath: cfgPath }).kind).toBe("absent");
    expect(readFileSync(cfgPath, "utf-8")).toBe(original);
  });

  test("an empty file is `absent`", () => {
    write("   \n");
    expect(unregisterFromAntigravity({ configPath: cfgPath }).kind).toBe("absent");
  });

  test("unparseable JSON is left byte-for-byte untouched", () => {
    // Same refusal as registration: removing our entry by text surgery
    // could corrupt however many others the user has.
    const original = '{"mcpServers": {"important": {"command": "keepme"},}}';
    write(original);
    const o = unregisterFromAntigravity({ configPath: cfgPath });
    expect(o.kind).toBe("manual");
    expect(readFileSync(cfgPath, "utf-8")).toBe(original);
    if (o.kind === "manual") expect(o.snippet).toContain(SERVER_KEY);
  });

  test("a live foreign lock makes us refuse rather than write", () => {
    write(JSON.stringify({ mcpServers: { [SERVER_KEY]: { command: BIN } } }));
    const original = readFileSync(cfgPath, "utf-8");
    writeFileSync(`${cfgPath}.cempala-lock`, "someone-else", "utf-8");
    const o = unregisterFromAntigravity({ configPath: cfgPath });
    expect(o.kind).toBe("manual");
    expect(readFileSync(cfgPath, "utf-8")).toBe(original);
  }, { timeout: 15_000 });

  test("register then unregister returns the config to its original shape", () => {
    const original = JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2) + "\n";
    write(original);
    expect(registerWithAntigravity({ binaryPath: BIN, configPath: cfgPath }).kind).toBe("updated");
    expect(read().mcpServers[SERVER_KEY].command).toBe(BIN);
    expect(unregisterFromAntigravity({ configPath: cfgPath }).kind).toBe("removed");
    expect(readFileSync(cfgPath, "utf-8")).toBe(original);
  });

  test("leaves no lock or backup file behind", () => {
    write(JSON.stringify({ mcpServers: { [SERVER_KEY]: { command: BIN } } }));
    unregisterFromAntigravity({ configPath: cfgPath });
    const junk = readdirSync(join(dir, "config")).filter((f) => f.includes("cempala-bak") || f.includes("cempala-lock"));
    expect(junk).toEqual([]);
  });

  test("describeUnregisterOutcome always names the path", () => {
    for (const o of [
      { kind: "removed" as const, path: cfgPath },
      { kind: "absent" as const, path: cfgPath },
      { kind: "manual" as const, path: cfgPath, reason: "because", snippet: "do it yourself" },
    ]) {
      expect(describeUnregisterOutcome(o).join("\n")).toContain(cfgPath);
    }
  });
});
