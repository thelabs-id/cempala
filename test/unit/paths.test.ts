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
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
    // Something OUTSIDE the root is not inside it.
    //
    // Windows and POSIX genuinely differ here, and the previous version of
    // this test asserted `isInside("/tmp", "/") === false` on POSIX — which is
    // false in the ordinary sense: /tmp really is inside /. Windows has
    // multiple filesystem roots, so D:\ is outside C:\; POSIX has exactly one,
    // and nothing is outside it. The test never caught this because it only
    // ever ran on Windows. Assert the property each platform can actually
    // express, exercising the same containment logic either way.
    if (isWindows) {
      expect(isInside("D:\\clients", root)).toBe(false);
    } else {
      expect(isInside("/tmp", "/var")).toBe(false);
      // ...and confirm the root really does contain everything, rather than
      // quietly skipping the negative case here.
      expect(isInside("/tmp", "/")).toBe(true);
    }
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
        // Only meaningful when ~/.ssh actually exists: canonicalize() resolves
        // symlinks, and a DANGLING link cannot resolve, so there is nothing to
        // catch. A fresh CI runner has no ~/.ssh, which made this assertion
        // fail for a reason that had nothing to do with the security property
        // — and it went unnoticed because the whole test skips on Windows for
        // lack of symlink privilege. The hermetic case below is the one that
        // always runs.
        if (existsSync(target)) {
          expect(hit).toContain(".ssh");
        }
      } finally {
        try { unlinkSync(linkPath); } catch { /* ignore */ }
      }
    } catch (e) {
      if (!created) return;
      throw e;
    }
  });

  test("AC-12 (hermetic): a symlink into any denylisted root is a hit", () => {
    // The property AC-12 is really about — canonicalization resolves a
    // symlink BEFORE the containment check, so a link cannot be used to reach
    // a denylisted directory by another name.
    //
    // Built entirely inside a temp directory rather than against ~/.ssh, so it
    // does not depend on the developer's home layout: the variant above is
    // silently meaningless on a machine with no ~/.ssh, which is exactly what
    // a fresh CI runner is.
    const base = mkdtempSync(join(tmpdir(), "cempala-dl-"));
    try {
      const secrets = join(base, "secrets");
      const link = join(base, "looks-innocent");
      mkdirSync(secrets);
      try {
        symlinkSync(secrets, link, "dir");
      } catch (e) {
        // Windows without Developer Mode / elevation. Skip loudly rather than
        // passing silently.
        console.warn("SKIP AC-12 (hermetic): cannot create symlink:", (e as Error).message);
        return;
      }

      const denylist = effectivePathDenylist([secrets]);

      // The symlink itself resolves into the denylisted root.
      expect(matchPathDenylist(link, denylist)).not.toBeNull();
      // ...and so does a path reached THROUGH it.
      expect(matchPathDenylist(join(link, "id_rsa"), denylist)).not.toBeNull();
      // A sibling that merely shares a prefix must NOT be a hit — the
      // `…/secrets` vs `…/secrets2` case AC-11 cares about.
      const sibling = join(base, "secrets2");
      mkdirSync(sibling);
      expect(matchPathDenylist(sibling, denylist)).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
