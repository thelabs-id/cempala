// test/unit/uninstall-path-block.test.ts
//
// The removal rule for install.sh's PATH block, tested directly.
//
// The first test is the important one: it reads install.sh and asserts the
// constants here are exactly what that script writes. The block is WRITTEN
// in bash and REMOVED in TypeScript — unavoidable, because install.sh is
// piped from curl into bash and cannot share a library — so the two are
// only kept in step by this assertion. Without it, an edit to the installer
// would silently leave every future uninstall unable to find its own block.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  removePathBlock,
  RC_MARKER,
  RC_BODY_CURRENT,
  RC_BODY_LEGACY,
} from "../../src/uninstall-path-block.ts";

const INSTALL_SH = readFileSync(join(process.cwd(), "scripts", "install.sh"), "utf-8");

const CURRENT_BLOCK = [RC_MARKER, ...RC_BODY_CURRENT].join("\n");
const LEGACY_BLOCK = [RC_MARKER, ...RC_BODY_LEGACY].join("\n");

describe("constants match what install.sh actually writes", () => {
  test("the marker comment is the one install.sh writes", () => {
    expect(INSTALL_SH).toContain(`rc_marker='${RC_MARKER}'`);
  });

  test("every line of the current body appears in install.sh", () => {
    // install.sh holds them as single-quoted array elements, so each line
    // is findable verbatim.
    for (const line of RC_BODY_CURRENT) {
      expect(INSTALL_SH).toContain(`'${line}'`);
    }
  });

  test("the legacy body is still the one install.sh knows about", () => {
    for (const line of RC_BODY_LEGACY) {
      expect(INSTALL_SH).toContain(`'${line}'`);
    }
  });
});

describe("removePathBlock", () => {
  test("removes a current block, with the blank line above it", () => {
    const before = `export EDITOR=vim\n\n${CURRENT_BLOCK}\n`;
    const { text, removed } = removePathBlock(before);
    expect(removed).toBe(1);
    expect(text).toBe("export EDITOR=vim\n");
  });

  test("removes a legacy block left by an older installer", () => {
    // Someone uninstalling is very often someone who installed long ago.
    const before = `${LEGACY_BLOCK}\nexport EDITOR=vim\n`;
    const { text, removed } = removePathBlock(before);
    expect(removed).toBe(1);
    expect(text).toBe("export EDITOR=vim\n");
  });

  test("removes every block when a file somehow has two", () => {
    const before = `a\n\n${CURRENT_BLOCK}\nb\n\n${LEGACY_BLOCK}\nc\n`;
    const { text, removed } = removePathBlock(before);
    expect(removed).toBe(2);
    expect(text).toBe("a\nb\nc\n");
  });

  test("leaves a file with no block byte-identical", () => {
    const before = 'export EDITOR=vim\nalias ll="ls -la"\n';
    const { text, removed } = removePathBlock(before);
    expect(removed).toBe(0);
    expect(text).toBe(before);
  });
});

describe("removePathBlock — what it refuses to touch", () => {
  test("a body with NO marker above it is left alone", () => {
    // These are ordinary lines of shell. Identical text can appear because
    // someone wrote the same export themselves, and deleting it would
    // corrupt a file this project does not own. The marker is what makes a
    // match evidence rather than a guess.
    const before = `${RC_BODY_CURRENT.join("\n")}\n`;
    const { text, removed } = removePathBlock(before);
    expect(removed).toBe(0);
    expect(text).toBe(before);
  });

  test("a marker followed by something unrecognised is left alone", () => {
    // Someone edited the block by hand. Guessing at its new shape is how
    // an uninstaller destroys a shell config.
    const before = `${RC_MARKER}\nexport PATH="$HOME/somewhere/else:$PATH"\n`;
    const { text, removed } = removePathBlock(before);
    expect(removed).toBe(0);
    expect(text).toBe(before);
  });

  test("a commented-out copy is left alone", () => {
    const before = `# ${RC_BODY_CURRENT[0]}\n`;
    const { text, removed } = removePathBlock(before);
    expect(removed).toBe(0);
    expect(text).toBe(before);
  });

  test("a file merely MENTIONING the path is left alone", () => {
    const before = 'echo "cempala lives in $HOME/.cempala/bin"\n';
    const { text, removed } = removePathBlock(before);
    expect(removed).toBe(0);
    expect(text).toBe(before);
  });
});

describe("removePathBlock — file shape is preserved", () => {
  test("a file with no final newline still has none afterwards", () => {
    // Rewriting a file to remove our block should change our block and
    // nothing else, down to the last byte.
    const before = `${CURRENT_BLOCK}\nexport EDITOR=vim`;
    const { text } = removePathBlock(before);
    expect(text).toBe("export EDITOR=vim");
    expect(text.endsWith("\n")).toBe(false);
  });

  test("a file ending in a newline keeps it", () => {
    const { text } = removePathBlock(`${CURRENT_BLOCK}\nexport EDITOR=vim\n`);
    expect(text).toBe("export EDITOR=vim\n");
  });

  test("CRLF line endings are recognised and the survivors keep theirs", () => {
    // A file that has been through a Windows editor must still match, and
    // the lines we leave behind must keep the endings they had.
    const before = `export EDITOR=vim\r\n${CURRENT_BLOCK.split("\n").join("\r\n")}\r\nalias ll="ls -la"\r\n`;
    const { text, removed } = removePathBlock(before);
    expect(removed).toBe(1);
    expect(text).toBe('export EDITOR=vim\r\nalias ll="ls -la"\r\n');
  });

  test("content below a removed block survives intact", () => {
    const before = `${CURRENT_BLOCK}\n\nexport A=1\nexport B=2\n`;
    const { text } = removePathBlock(before);
    expect(text).toContain("export A=1");
    expect(text).toContain("export B=2");
  });

  test("an empty file is returned unchanged", () => {
    expect(removePathBlock("")).toEqual({ text: "", removed: 0 });
  });

  test("install then uninstall returns the file to its original bytes", () => {
    // The round trip that matters, using the exact block install.sh appends
    // (a blank line, the marker, then the body).
    const original = 'export EDITOR=vim\nalias ll="ls -la"\n';
    const installed = `${original}\n${CURRENT_BLOCK}\n`;
    const { text } = removePathBlock(installed);
    expect(text).toBe(original);
  });
});
