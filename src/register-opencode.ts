// src/register-opencode.ts
//
// Removes cempala from OpenCode's global MCP config.
//
// Note what is NOT here: registration. OpenCode ships `opencode mcp add`,
// it is non-interactive, it is idempotent, and it preserves the comments
// and formatting of the file it edits — so the installers shell out to it
// exactly as they do for `claude mcp add` and `codex mcp add`, and the CLI
// owns its own config format. That is always the better deal when the
// subcommand exists.
//
// What OpenCode does not ship is the inverse. `opencode mcp --help` lists
// add, list, auth, logout and debug; `mcp remove` and `mcp rm` are not
// commands, they just print the help. So removal has to happen here, for
// the same reason the Antigravity merge does — and it is not optional. An
// installer that registers automatically and an uninstaller that cannot
// unregister is precisely the failure uninstall.sh exists to prevent: a
// live entry pointing at a deleted binary, and OpenCode reporting cempala
// as a failed server on every launch until the user finds the file.
//
// THE EDIT IS SURGICAL, NOT A REWRITE. The obvious implementation — parse,
// delete the key, re-serialise — would work and would also hand back a
// config with the user's comments stripped and every line reformatted.
// OpenCode's default config is `opencode.jsonc`, comments are the point of
// the format, and `opencode mcp add` is careful to keep them. An
// uninstaller has no business being less careful than the installer: it
// cuts out the bytes of one member and copies the rest through untouched.
// This is the same standard uninstall.sh holds for shell rc files, where
// install-then-uninstall returns the file to its original bytes.

import { existsSync, readFileSync } from "node:fs";
import { openCodeConfigCandidates, openCodeConfigDir } from "./platform/paths.ts";
import { acquireLock, lockFailureReason, writeBackPreservingLinks } from "./register-antigravity.ts";

/** The key cempala registers itself under, inside `mcp`. */
export const SERVER_KEY = "cempala";

export type UnregisterOutcome =
  /** The entry was there and is now gone. */
  | { kind: "removed"; path: string }
  /** Nothing to do: no config file, or no cempala entry in it. */
  | { kind: "absent"; path: string }
  /** We declined to touch the file. `reason` says why. */
  | { kind: "manual"; path: string; reason: string; snippet: string };

/**
 * Remove cempala from every OpenCode config that holds it.
 *
 * Returns one outcome per config file considered, because there can
 * genuinely be two: `opencode mcp add` writes to `opencode.json` when that
 * file already exists and creates `opencode.jsonc` otherwise, so a user who
 * added the `.json` after we registered has our entry in the `.jsonc` and
 * their config in the other. Removing from only the file we would write
 * today would leave the other one live — the exact outcome this file
 * exists to prevent, reintroduced one directory over.
 */
export function unregisterFromOpenCode(opts: { configPath?: string } = {}): UnregisterOutcome[] {
  const candidates = opts.configPath ? [opts.configPath] : openCodeConfigCandidates();
  const present = candidates.filter((p) => existsSync(p));

  // Nothing on disk at all. Reported against the directory rather than an
  // arbitrary one of two filenames we did not find.
  if (present.length === 0) {
    return [{ kind: "absent", path: opts.configPath ?? openCodeConfigDir() }];
  }

  return present.map((path) => unregisterFromFile(path));
}

function unregisterFromFile(path: string): UnregisterOutcome {
  const snippet = `Remove the "${SERVER_KEY}" entry from "mcp" in ${path}`;

  const lock = acquireLock(path);
  if (!lock) {
    // The remedy named here is THIS command. The shared helper defaults to
    // the Antigravity one, which would tell a stuck uninstall to register.
    return {
      kind: "manual",
      path,
      reason: lockFailureReason(path, "cempala --unregister-opencode"),
      snippet,
    };
  }

  try {
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch (err) {
      return { kind: "manual", path, reason: `could not read the file (${errMsg(err)})`, snippet };
    }

    const result = removeServerEntry(text, SERVER_KEY);
    if (result.kind === "absent") return { kind: "absent", path };
    if (result.kind === "unparseable") {
      // A file we cannot scan AND that never mentions our key holds no
      // registration of ours, so there is nothing here to fail over.
      //
      // This matters more than it did for Antigravity, which owns one
      // file. Unregistration now visits three, two of which cempala never
      // writes — so someone's malformed legacy `config.json`, which could
      // not possibly contain our entry, would otherwise fail the whole
      // uninstall: non-zero exit, binary kept, `--purge` refused.
      if (!text.includes(`"${SERVER_KEY}"`)) return { kind: "absent", path };
      // Otherwise the same rule as the Antigravity merge: a config we
      // cannot read confidently is a config we do not write. Being wrong
      // here means corrupting a file that is not ours, and the cost of
      // declining is one line the user deletes by hand.
      return { kind: "manual", path, reason: result.reason, snippet };
    }

    try {
      // `text` doubles as the expected-content check: if the file changed
      // between our read and this write, the edit is abandoned rather than
      // applied to bytes we never saw. `isScannableJsonc` replaces the
      // strict-JSON default, which would read every commented config as
      // damaged.
      writeBackPreservingLinks(path, result.text, text, isScannableJsonc);
    } catch (err) {
      return { kind: "manual", path, reason: `could not write the file (${errMsg(err)})`, snippet };
    }
    return { kind: "removed", path };
  } finally {
    lock.release();
  }
}

/**
 * Human-readable lines for the uninstaller to print, so uninstall.sh and
 * uninstall.ps1 say the same thing without either restating the outcomes.
 */
export function describeUnregisterOutcome(o: UnregisterOutcome): string[] {
  switch (o.kind) {
    case "removed":
      return [`  ✓ removed cempala from ${o.path} (comments and other servers preserved)`];
    case "absent":
      return [`  ✓ cempala was not registered in ${o.path}`];
    case "manual":
      return [
        `  ! could not remove the registration automatically: ${o.reason}`,
        `    ${o.snippet}`,
        `    File: ${o.path}`,
      ];
  }
}

// --- The edit itself --------------------------------------------------------

export type EditResult =
  /** `text` is the file with the member cut out; every other byte is as found. */
  | { kind: "removed"; text: string }
  /** No `mcp` object, or no such server in it. The file is fine, just not ours. */
  | { kind: "absent" }
  /** We could not make sense of the file and refuse to guess. */
  | { kind: "unparseable"; reason: string };

/**
 * Is this text a JSONC document we can walk from end to end?
 *
 * Used to tell a config that is fine from one a failed write truncated,
 * and it has to understand comments: judging OpenCode's format with
 * `JSON.parse` marks every commented config as damaged. Deliberately the
 * same scanner the removal uses, so the two answers cannot disagree about
 * what "readable" means.
 */
export function isScannableJsonc(text: string): boolean {
  // An empty file is damage, not a valid document — a truncated write
  // lands here, and restoring the backup over it is exactly right.
  if (!text.trim()) return false;
  try {
    const start = skipTrivia(text, text.charCodeAt(0) === 0xfeff ? 1 : 0);
    if (text[start] !== "{") return false;
    const root = objectMembers(text, start);
    return skipTrivia(text, root.closeIdx + 1) >= text.length;
  } catch {
    return false;
  }
}

/**
 * Cut `mcp.<key>` out of a JSONC document, preserving every other byte.
 *
 * Deliberately narrow: it removes one member of one object and leaves an
 * emptied `"mcp": {}` behind rather than tidying it away. That empty object
 * is OpenCode's, the same as any other setting in the file, and an
 * uninstaller that starts removing keys it did not write has stopped being
 * an uninstaller.
 */
export function removeServerEntry(text: string, key: string): EditResult {
  try {
    // A UTF-8 BOM is a legal way to start the file and is not whitespace,
    // so it has to be stepped over explicitly. Without this a config saved
    // by a Windows editor looks like "the top level is not an object" and
    // the uninstall reports a failure over a file it could have handled.
    const rootStart = skipTrivia(text, text.charCodeAt(0) === 0xfeff ? 1 : 0);

    // An empty or whitespace-only file holds no registration, which is
    // `absent` — the same answer as a config full of other people's
    // servers. Calling it unparseable would raise a partial-uninstall
    // alarm about nothing.
    if (rootStart >= text.length) return { kind: "absent" };
    if (text[rootStart] !== "{") {
      return { kind: "unparseable", reason: "the top level of the file is not a JSON object" };
    }

    const root = objectMembers(text, rootStart);

    // Nothing but trivia may follow the root object. Anything else means
    // the file is not one JSON document, and scanning only as far as the
    // first closing brace would let us edit and write back something we
    // never actually read to the end — the one thing this file promises
    // not to do. Cheap to check and, unlike validating every literal, it
    // cannot reject a file OpenCode would have accepted.
    if (skipTrivia(text, root.closeIdx + 1) < text.length) {
      return { kind: "unparseable", reason: "there is content after the top-level object" };
    }

    const mcps = root.members.filter((m) => m.key === "mcp");
    // Duplicate keys are legal JSON to write and ambiguous to act on: the
    // parsers that accept them generally take the LAST, so removing from
    // the first would delete a config OpenCode is not using while leaving
    // the live registration in place. Refusing is the only answer that
    // cannot silently do the wrong one.
    if (mcps.length > 1) {
      return { kind: "unparseable", reason: `the file has more than one "mcp" key` };
    }
    const mcp = mcps[0];
    if (!mcp) return { kind: "absent" };
    if (text[mcp.valueStart] !== "{") {
      return { kind: "unparseable", reason: `"mcp" is not an object` };
    }

    const inner = objectMembers(text, mcp.valueStart);
    const matches = inner.members.filter((m) => m.key === key);
    if (matches.length > 1) {
      return { kind: "unparseable", reason: `"mcp" has more than one "${key}" key` };
    }
    const idx = inner.members.findIndex((m) => m.key === key);
    if (idx === -1) return { kind: "absent" };
    const target = inner.members[idx]!;

    // Which bytes to cut depends only on which comma holds this member to
    // its neighbours. Usually that is one range; the last-member case needs
    // two, and the reason is comments.
    const cuts: Array<[number, number]> = [];
    if (target.commaPos !== null) {
      // Followed by a comma: take the member and that comma. What remains
      // still separates cleanly from whatever came before.
      cuts.push(expandToWholeLines(text, target.keyStart, target.commaPos + 1));
    } else if (idx > 0) {
      // Last member of several. The comma that must go is the one BEFORE
      // us, which the previous member owns — but the bytes BETWEEN that
      // comma and our key are not ours to take. A trailing comment there
      // (`"other": {}, /* about other */`) documents the previous member,
      // and cutting the whole span from comma to value swallowed it. So
      // the comma and the member are removed as two separate ranges, and
      // whatever sits between them stays.
      const prevComma = inner.members[idx - 1]!.commaPos!;
      cuts.push([prevComma, prevComma + 1]);
      cuts.push(expandToWholeLines(text, target.keyStart, target.valueEnd));
    } else {
      // The only member. No comma exists in either direction.
      cuts.push(expandToWholeLines(text, target.keyStart, target.valueEnd));
    }

    // Applied last-first so that each cut's indices are still valid when
    // it is made.
    let out = text;
    for (const [start, end] of [...cuts].reverse()) {
      out = out.slice(0, start) + out.slice(end);
    }
    return { kind: "removed", text: out };
  } catch (err) {
    if (err instanceof JsoncError) return { kind: "unparseable", reason: err.message };
    // A document nested deeply enough to exhaust the stack is not worth a
    // crash in the middle of an uninstall. `unparseable` is the same safe
    // refusal every other unreadable file gets.
    if (err instanceof RangeError) {
      return { kind: "unparseable", reason: "the file is nested too deeply to scan safely" };
    }
    throw err;
  }
}

/**
 * Widen a cut to whole lines when — and only when — it already occupies
 * them, so removing a member does not leave a blank line where it stood.
 *
 * The both-sides condition is what makes this safe rather than tidy. When
 * the cut starts mid-line (the last-member case starts at the previous
 * member's comma, with that member's value to its left) widening the end
 * alone would pull the next line up onto it and glue two lines of the
 * user's file together. If either side has real content on it, nothing is
 * widened and the cut stays exactly as computed.
 */
function expandToWholeLines(text: string, start: number, end: number): [number, number] {
  let lineStart = start;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--;
  if (!/^[ \t]*$/.test(text.slice(lineStart, start))) return [start, end];

  let lineEnd = end;
  while (lineEnd < text.length && text[lineEnd] !== "\n") lineEnd++;
  // A `\r` before the newline is trailing whitespace like any other; it is
  // inside this slice, so CRLF files widen exactly as LF ones do.
  if (!/^[ \t\r]*$/.test(text.slice(end, lineEnd))) return [start, end];

  // Take the newline too. At EOF there is none, and lineEnd is already the
  // end of the text.
  if (lineEnd < text.length) lineEnd++;
  return [lineStart, lineEnd];
}

/** Raised for anything we will not interpret. Always becomes `unparseable`. */
class JsoncError extends Error {}

interface Member {
  /** Index of the opening quote of the key. */
  keyStart: number;
  /** The decoded key, so `cempala` matches too. */
  key: string;
  /** Index of the first byte of the value. */
  valueStart: number;
  /** Index one past the last byte of the value. */
  valueEnd: number;
  /** Index of the comma after this member, if it has one. */
  commaPos: number | null;
}

/**
 * The members of the object opening at `openIdx`, with the positions the
 * edit needs.
 *
 * This is a scanner, not a parser: it records where things are and decodes
 * nothing but the keys. Values are walked to find where they end, which is
 * why a value containing `}` inside a string, or a comment between the key
 * and the colon, causes no trouble.
 */
function objectMembers(text: string, openIdx: number): { members: Member[]; closeIdx: number } {
  const members: Member[] = [];
  let i = openIdx + 1;

  for (;;) {
    i = skipTrivia(text, i);
    if (i >= text.length) throw new JsoncError("unterminated object");
    // Also the trailing-comma case: `{"a": 1,}` arrives here after the
    // comma and finds the brace, which JSONC permits and we accept.
    if (text[i] === "}") return { members, closeIdx: i };
    if (text[i] !== '"') throw new JsoncError("an object key is not a quoted string");

    const keyStart = i;
    const keyEnd = scanString(text, i);
    let key: string;
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    } catch {
      throw new JsoncError("an object key is not a valid JSON string");
    }

    i = skipTrivia(text, keyEnd);
    if (text[i] !== ":") throw new JsoncError(`missing ":" after the key ${JSON.stringify(key)}`);
    i = skipTrivia(text, i + 1);

    const valueStart = i;
    const valueEnd = scanValue(text, i);
    i = skipTrivia(text, valueEnd);

    let commaPos: number | null = null;
    if (text[i] === ",") {
      commaPos = i;
      i++;
    }
    members.push({ keyStart, key, valueStart, valueEnd, commaPos });

    if (commaPos === null) {
      i = skipTrivia(text, i);
      if (text[i] !== "}") throw new JsoncError(`expected "," or "}" after a member`);
      return { members, closeIdx: i };
    }
  }
}

/** Skip whitespace, `//` line comments and `/* *\/` block comments. */
function skipTrivia(text: string, i: number): number {
  for (;;) {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
    if (text[i] === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) throw new JsoncError("unterminated block comment");
      i = close + 2;
      continue;
    }
    return i;
  }
}

/** `text[i]` is the opening quote; returns the index one past the closing one. */
function scanString(text: string, i: number): number {
  i++;
  while (i < text.length) {
    const c = text[i];
    // A backslash escapes whatever follows, `\"` and `\\` included, so
    // skipping both bytes is all that is needed to find the true end.
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    if (c === "\n") throw new JsoncError("unterminated string");
    i++;
  }
  throw new JsoncError("unterminated string");
}

/** Returns the index one past the end of the value starting at `i`. */
function scanValue(text: string, i: number): number {
  const c = text[i];
  if (c === '"') return scanString(text, i);
  if (c === "{" || c === "[") return scanContainer(text, i);

  // A number, true, false or null. Not validated — this scanner's job is
  // to find where the value ends, and rejecting a literal it merely
  // dislikes would mean refusing to uninstall over a file OpenCode reads
  // perfectly well.
  const start = i;
  while (
    i < text.length &&
    !",}]".includes(text[i]!) &&
    !" \t\n\r".includes(text[i]!) &&
    !(text[i] === "/" && (text[i + 1] === "/" || text[i + 1] === "*"))
  ) i++;
  if (i === start) {
    throw new JsoncError(`unexpected character ${JSON.stringify(text[i] ?? "end of file")}`);
  }
  return i;
}

/** Walk a `{…}` or `[…]`, returning the index one past its closing bracket. */
function scanContainer(text: string, i: number): number {
  const open = text[i];
  const close = open === "{" ? "}" : "]";
  i++;

  for (;;) {
    i = skipTrivia(text, i);
    if (i >= text.length) throw new JsoncError(`unterminated ${open}`);
    if (text[i] === close) return i + 1;

    if (open === "{") {
      if (text[i] !== '"') throw new JsoncError("an object key is not a quoted string");
      i = scanString(text, i);
      i = skipTrivia(text, i);
      if (text[i] !== ":") throw new JsoncError(`missing ":" after an object key`);
      i = skipTrivia(text, i + 1);
    }

    i = scanValue(text, i);
    i = skipTrivia(text, i);
    if (text[i] === ",") {
      i++;
      continue;
    }
    if (text[i] === close) return i + 1;
    throw new JsoncError(`expected "," or "${close}"`);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
