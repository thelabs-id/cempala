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
});
