// test/unit/trust-boundary.test.ts
//
// FR-10..FR-11c: the only place that decides allowed vs needs_approval vs
// denied. Verifies the order of evaluation:
//   1. denylist hit → denied (wins over approved roots)
//   2. inside approved_paths → allowed
//   3. inside home_root → allowed
//   4. otherwise → needs_approval

import { describe, test, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { evaluateTrustBoundary, canApprove } from "../../src/security/trust-boundary.ts";
import { effectivePathDenylist } from "../../src/security/denylist.ts";

const HOME = homedir();
const PATH_DENYLIST = effectivePathDenylist([]);

describe("evaluateTrustBoundary", () => {
  test("a path under home is allowed (default trust boundary)", () => {
    const v = evaluateTrustBoundary({
      cwd: join(HOME, "projects", "foo"),
      pathDenylist: PATH_DENYLIST,
      approvedRoots: [],
    });
    expect(v.kind).toBe("allowed");
    if (v.kind === "allowed") expect(v.reason).toBe("home");
  });

  test("a path outside home and not approved returns needs_approval", () => {
    const v = evaluateTrustBoundary({
      cwd: join(HOME, "..", "outside", "foo"),
      pathDenylist: PATH_DENYLIST,
      approvedRoots: [],
    });
    expect(v.kind).toBe("needs_approval");
  });

  test("a path under an approved root is allowed (with reason=approved)", () => {
    const approved = join(HOME, "..", "clients", "acme");
    const v = evaluateTrustBoundary({
      cwd: join(approved, "src", "deep"),
      pathDenylist: PATH_DENYLIST,
      approvedRoots: [approved],
    });
    expect(v.kind).toBe("allowed");
    if (v.kind === "allowed") expect(v.reason).toBe("approved");
  });

  test("AC-11: a sibling-prefix path is NOT inside the approved root", () => {
    const approved = join(HOME, "..", "clients", "acme");
    const sibling = join(HOME, "..", "clients", "acme2");
    const v = evaluateTrustBoundary({
      cwd: sibling,
      pathDenylist: PATH_DENYLIST,
      approvedRoots: [approved],
    });
    // Sibling is outside the approved root, but the parent may or may not
    // be in the trust boundary. Make sure it's NOT classified as approved.
    if (v.kind === "allowed") expect(v.reason).not.toBe("approved");
  });

  test("AC-3: a denylist hit denies even when the root is approved (denylist wins)", () => {
    const sshRoot = join(HOME, ".ssh");
    const v = evaluateTrustBoundary({
      cwd: sshRoot,
      pathDenylist: PATH_DENYLIST,
      approvedRoots: [HOME], // whole home is "approved" — denylist still wins
    });
    expect(v.kind).toBe("denied");
  });

  test("denylist matching is against the canonical path, not the raw input", () => {
    // A path that contains . and .. but ends up in ~/.ssh should still deny.
    const v = evaluateTrustBoundary({
      cwd: join(HOME, ".ssh", "..", ".ssh", "keys"),
      pathDenylist: PATH_DENYLIST,
      approvedRoots: [],
    });
    expect(v.kind).toBe("denied");
  });

  test("P1: cwd=~ (home) is needs_approval because it is a strict ancestor of a denylist root", () => {
    // Without the ancestor check, cwd=~ would be classified as
    // `allowed (reason: home)` even though it contains ~/.ssh as a
    // subpath. With the fix, the trust boundary asks the human to
    // confirm the broad scope rather than silently allowing the child
    // to access ~/.ssh.
    const v = evaluateTrustBoundary({
      cwd: HOME,
      pathDenylist: PATH_DENYLIST,
      approvedRoots: [],
    });
    expect(v.kind).toBe("needs_approval");
    if (v.kind === "needs_approval") {
      expect(v.reason).toBe("ancestor_of_denylist");
    }
  });

  test("P1: cwd=~ with HOME approved still needs_approval (denylist wins, ancestor check wins over approved)", () => {
    // Even if the user has approved `~`, the ancestor-of-denylist
    // check fires BEFORE the approved-root check. The user must
    // narrow their cwd to a subdirectory, not approve home wholesale.
    const v = evaluateTrustBoundary({
      cwd: HOME,
      pathDenylist: PATH_DENYLIST,
      approvedRoots: [HOME],
    });
    expect(v.kind).toBe("needs_approval");
    if (v.kind === "needs_approval") {
      expect(v.reason).toBe("ancestor_of_denylist");
    }
  });

  test("P1: a subpath of home that does NOT contain a denylist root is still allowed (no regression)", () => {
    const v = evaluateTrustBoundary({
      cwd: join(HOME, "projects", "myapp"),
      pathDenylist: PATH_DENYLIST,
      approvedRoots: [],
    });
    expect(v.kind).toBe("allowed");
    if (v.kind === "allowed") expect(v.reason).toBe("home");
  });
});

describe("canApprove (FR-7a / AC-10)", () => {
  test("a non-denylisted path can be approved", () => {
    const v = canApprove(join(HOME, "..", "clients", "acme"), PATH_DENYLIST);
    expect(v.ok).toBe(true);
  });

  test("AC-10: a denylisted path cannot be approved, even by explicit request", () => {
    const v = canApprove(join(HOME, ".ssh"), PATH_DENYLIST);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("denylist");
  });

  test("AC-10: a subpath of a denylisted path cannot be approved", () => {
    const v = canApprove(join(HOME, ".ssh", "id_rsa"), PATH_DENYLIST);
    expect(v.ok).toBe(false);
  });

  test("P1: an ancestor of a denylist root cannot be approved (symmetric to evaluateTrustBoundary)", () => {
    // `HOME` is not on the denylist itself, but it contains
    // `~/.ssh` as a subpath. Approving HOME would let a future
    // dispatch with `cwd: ~` slip past the denylist. Symmetric to
    // the ancestor check in `evaluateTrustBoundary`.
    const v = canApprove(HOME, PATH_DENYLIST);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("contains_denylist");
  });
});
