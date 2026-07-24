// test/unit/paths.test.ts
//
// AC-11: approved-root containment. With D:\clients\acme approved: a task in
// D:\clients\acme\src succeeds without re-approval, and a task in
// D:\clients\acme2 returns needs_approval — the sibling-prefix case must
// not be treated as inside the approved root.
//
// AC-12: symlink can't escape the denylist. A symlink at ~/projects/x/keys
// pointing to ~/.ssh is rejected as a denylist hit, because canonicalization
// resolves it before matching.

import { describe, test, expect } from "bun:test";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { platform } from "node:process";
import { canonicalize, isInside } from "../../src/security/paths.ts";
import { effectivePathDenylist, matchPathDenylist } from "../../src/security/denylist.ts";

describe("security/paths.ts — canonicalize", () => {
  test("collapses . and ..", () => {
    const a = canonicalize(join(homedir(), "foo", "..", "bar"));
    const b = canonicalize(join(homedir(), "bar"));
    expect(a).toBe(b);
  });

  test("is idempotent", () => {
    const a = canonicalize(join(homedir(), ".", "foo", "..", "bar"));
    const b = canonicalize(join(homedir(), "bar"));
    expect(canonicalize(a)).toBe(b);
  });
});

describe("security/paths.ts — isInside (AC-11)", () => {
  test("exact match is inside", () => {
    const root = join(homedir(), "clients", "acme");
    expect(isInside(root, root)).toBe(true);
  });

  test("nested directory is inside", () => {
    const root = join(homedir(), "clients", "acme");
    const nested = join(homedir(), "clients", "acme", "src", "deep");
    expect(isInside(nested, root)).toBe(true);
  });

  test("sibling with shared prefix is NOT inside (the bug this catches)", () => {
    const root = join(homedir(), "clients", "acme");
    const sibling = join(homedir(), "clients", "acme2");
    expect(isInside(sibling, root)).toBe(false);
  });

  test("unrelated directory is NOT inside", () => {
    const root = join(homedir(), "clients", "acme");
    const other = join(homedir(), "work", "personal");
    expect(isInside(other, root)).toBe(false);
  });

  test("platform-specific separator is respected", () => {
    const root = join(homedir(), "clients", "acme");
    const nested = `${root}${sep}src`;
    expect(isInside(nested, root)).toBe(true);
  });

  test("filesystem-root containment (P2 fix)", () => {
    // When the root is a filesystem root like "/" (POSIX) or "D:\\" (Windows),
    // canonicalize() leaves the trailing separator. The isInside check must
    // not double-append the separator — that would yield "D:\\" or "//",
    // which no path starts with, and the approval would silently fail.
    const isWindows = process.platform === "win32";
    const root = isWindows ? "C:\\" : "/";
    // A path directly under the root: must be inside.
    const child = isWindows ? "C:\\clients" : "/clients";
    expect(isInside(child, root)).toBe(true);
    // The root itself: trivially inside.
    expect(isInside(root, root)).toBe(true);
    // A path outside: not inside.
    const outside = isWindows ? "D:\\clients" : "/tmp";
    expect(isInside(outside, root)).toBe(false);
  });
});

describe("security/paths.ts — tilde expansion in canonicalize (P2 fix)", () => {
  test("'~/.ssh' canonicalizes to the same path as the absolute form", () => {
    const a = canonicalize("~/.ssh");
    const b = canonicalize(join(homedir(), ".ssh"));
    expect(a).toBe(b);
  });

  test("'~' alone canonicalizes to the home dir", () => {
    const a = canonicalize("~");
    const b = canonicalize(homedir());
    expect(a).toBe(b);
  });
});

describe("security/denylist.ts — matchPathDenylist (AC-3, AC-10)", () => {
  test("AC-3: ~/.ssh is on the baseline denylist", () => {
    const baseline = effectivePathDenylist([]);
    const hit = matchPathDenylist(join(homedir(), ".ssh"), baseline);
    expect(hit).toContain(".ssh");
  });

  test("AC-10: ~/.ssh subpath is on the baseline denylist", () => {
    const baseline = effectivePathDenylist([]);
    const hit = matchPathDenylist(join(homedir(), ".ssh", "id_rsa"), baseline);
    expect(hit).toContain(".ssh");
  });

  test("unrelated home-dir paths are not on the baseline", () => {
    const baseline = effectivePathDenylist([]);
    const hit = matchPathDenylist(join(homedir(), "projects", "myproj"), baseline);
    expect(hit).toBeNull();
  });

  test("AC-12: a symlink resolving into a denylisted root is still a denylist hit", () => {
    // Create a real symlink ~/cempala-test-symlink → ~/.ssh
    const linkPath = join(homedir(), `cempala-test-symlink-${Date.now()}`);
    const target = join(homedir(), ".ssh");
    // Skip if symlink creation is not permitted (Windows non-dev-mode).
    let created = false;
    try {
      // Bun has no symlinkSync in std; node:fs does.
      const { symlinkSync, unlinkSync } = require("node:fs");
      try {
        symlinkSync(target, linkPath, "dir");
        created = true;
      } catch (e) {
        console.warn("SKIP AC-12: cannot create symlink (Windows + no dev mode?):", (e as Error).message);
        return; // soft-skip
      }
      try {
        const baseline = effectivePathDenylist([]);
        const hit = matchPathDenylist(linkPath, baseline);
        expect(hit).toContain(".ssh");
      } finally {
        try { unlinkSync(linkPath); } catch { /* ignore */ }
      }
    } catch (e) {
      if (!created) return;
      throw e;
    }
  });
});
