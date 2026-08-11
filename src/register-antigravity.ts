// src/register-antigravity.ts
//
// Registers cempala in Antigravity's global MCP config.
//
// Claude and Codex each ship an `mcp add` subcommand, so for those the
// installer just shells out and lets the CLI own its own config file.
// Antigravity has no such subcommand — `agy --help` lists agent, changelog,
// help, install, models, plugin and update, and nothing else; the docs say
// to "modify these files directly". So the merge has to happen somewhere,
// and this is it.
//
// It lives in the binary rather than in install.sh/install.ps1 for two
// reasons. A correct JSON merge in bash means depending on jq or python3,
// neither of which is guaranteed present on a machine that just downloaded
// a self-contained binary. And doing it twice — once in bash, once in
// PowerShell — means two implementations of one rule, which is the drift
// this codebase has already paid for elsewhere (see agent-output.ts).
//
// The one rule this file exists to keep: NEVER destroy a config we did not
// write. Anything unparseable, or not shaped the way we expect, is left
// exactly as it was found and reported back for the human to handle.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync,
  openSync, writeSync, closeSync, statSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { ANTIGRAVITY_MCP_CONFIG_PATH } from "./platform/paths.ts";

/** The key cempala registers itself under, inside `mcpServers`. */
export const SERVER_KEY = "cempala";

export type RegisterOutcome =
  /** The file already held exactly this registration. Nothing was written. */
  | { kind: "unchanged"; path: string }
  /** The config file did not exist; we created it. */
  | { kind: "created"; path: string }
  /** An existing config was updated, preserving every other server. */
  | { kind: "updated"; path: string }
  /**
   * We refused to touch the file. `snippet` is what the user should merge
   * by hand — printing the exact JSON is the difference between a usable
   * message and "something went wrong".
   */
  | { kind: "manual"; path: string; reason: string; snippet: string };

export interface RegisterOptions {
  /** Absolute path to the cempala executable to register. */
  binaryPath: string;
  /** Override the config location. Defaults to Antigravity's global path. */
  configPath?: string;
}

/** The server entry we write. stdio transport: a command, no args. */
function entryFor(binaryPath: string): Record<string, unknown> {
  return { command: binaryPath };
}

/**
 * Is the existing entry already the one we would write?
 *
 * Compared field by field against what we'd produce, rather than by
 * deep-equality against the whole stored object. A user may well have
 * added `disabledTools` or `env` of their own to cempala's entry, and
 * rewriting the file to strip those — reporting "updated" as if it were
 * an improvement — would be us discarding their configuration. We care
 * only that the fields we own say what they should.
 */
function entryMatches(existing: unknown, binaryPath: string): boolean {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return false;
  const e = existing as Record<string, unknown>;
  return e.command === binaryPath;
}

export function registerWithAntigravity(opts: RegisterOptions): RegisterOutcome {
  const path = opts.configPath ?? ANTIGRAVITY_MCP_CONFIG_PATH;
  const entry = entryFor(opts.binaryPath);
  const snippet = JSON.stringify({ mcpServers: { [SERVER_KEY]: entry } }, null, 2);

  // Serialize against another cempala doing the same thing. Everything
  // below is a read / modify / write, and two of them interleaving loses
  // whichever entry was written second-last: process A reads {X}, process
  // B adds {Y}, process A writes back its stale {X, cempala} and Y is
  // gone. Re-running the installer while one is already running is not
  // exotic, and this module's whole premise is that it does not destroy a
  // config it did not write.
  //
  // The lock only binds cempala to cempala — Antigravity itself will not
  // take it — which is why the write below ALSO verifies the file has not
  // changed since we read it. Between them, a lost update needs a foreign
  // writer landing inside a window a few milliseconds wide.
  const lock = acquireLock(path);
  if (!lock) {
    // Refuse rather than continue unlocked. Proceeding here would mean
    // abandoning serialization at precisely the moment it is needed: two
    // processes both pass the content check, and the second write erases
    // the first. A registration the user can re-run is a far better
    // outcome than a config entry that silently disappears.
    //
    // The two reasons get different messages because they need different
    // things from the user. Reporting "another process is registering"
    // for a directory we simply cannot write to would send someone
    // hunting for a second cempala that was never running.
    return {
      kind: "manual",
      path,
      reason: lockFailureReason(path),
      snippet,
    };
  }
  try {
    return registerLocked(path, entry, snippet, opts.binaryPath);
  } finally {
    lock.release();
  }
}

function registerLocked(
  path: string,
  entry: Record<string, unknown>,
  snippet: string,
  binaryPath: string,
): RegisterOutcome {
  // --- No file yet: create the whole thing. ---
  if (!existsSync(path)) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      // EXCLUSIVE create, not a plain write. `existsSync` answered a
      // question about the past: a foreign process (Antigravity's own
      // first run creates this file) can land between that check and this
      // line, and a truncating write would destroy a config that existed
      // for a few microseconds before ours. `wx` fails with EEXIST
      // instead, and we fall through to the merge path — which is the
      // correct handling for a file that turns out to exist after all.
      let fd: number | null = null;
      let weCreatedIt = false;
      try {
        fd = openSync(path, "wx");
        weCreatedIt = true;
        writeAllSync(fd, `${snippet}\n`);
        closeSync(fd);
        fd = null;
      } catch (err) {
        // CLOSE BEFORE UNLINK. Windows refuses to delete a file that is
        // still open, so cleaning up while holding the descriptor fails
        // silently and leaves exactly the abandoned partial file this
        // block exists to prevent.
        if (fd !== null) {
          try { closeSync(fd); } catch { /* best effort */ }
          fd = null;
        }
        // A file this call exclusively created, and then failed to fill,
        // is ours to remove. Leaving it would report `manual` while an
        // empty or half-written config sat on disk — and an empty
        // mcp_config.json is what this module reads as "absent", so the
        // damage would hide itself. On EEXIST nothing was created, so
        // nothing is removed.
        if (weCreatedIt) {
          try { unlinkSync(path); } catch { /* best effort */ }
        }
        throw err;
      } finally {
        if (fd !== null) {
          try { closeSync(fd); } catch { /* best effort */ }
        }
      }
      return { kind: "created", path };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
        return { kind: "manual", path, reason: `could not create the file (${errMsg(err)})`, snippet };
      }
      // It appeared under us. Fall through and merge into it.
    }
  }

  // --- A file exists. Read it before deciding anything. ---
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    return { kind: "manual", path, reason: `could not read the file (${errMsg(err)})`, snippet };
  }

  // An empty (or whitespace-only) file is not a config anyone wrote; a
  // half-finished download or a `touch` leaves one. Treat it as absent
  // rather than as unparseable, so the common case still registers.
  let parsed: unknown = {};
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      // This is the case the whole "manual" branch exists for. A config
      // we cannot parse is one we cannot safely rewrite: the user may
      // have a comment, a trailing comma, or an edit in progress, and
      // replacing it with our own two lines would destroy however many
      // other servers they had registered.
      return {
        kind: "manual",
        path,
        reason: `the existing file is not valid JSON (${errMsg(err)}); it was left untouched`,
        snippet,
      };
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      kind: "manual",
      path,
      reason: "the existing file is valid JSON but not an object; it was left untouched",
      snippet,
    };
  }

  const root = parsed as Record<string, unknown>;
  const servers = root.mcpServers;
  if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
    return {
      kind: "manual",
      path,
      reason: "the existing file has an `mcpServers` key that is not an object; it was left untouched",
      snippet,
    };
  }

  const existingServers = (servers ?? {}) as Record<string, unknown>;
  if (entryMatches(existingServers[SERVER_KEY], binaryPath)) {
    return { kind: "unchanged", path };
  }

  // Preserve every other key, at both levels: other servers, and any
  // top-level settings Antigravity may keep alongside `mcpServers`.
  const next: Record<string, unknown> = {
    ...root,
    mcpServers: { ...existingServers, [SERVER_KEY]: { ...(asObject(existingServers[SERVER_KEY]) ?? {}), ...entry } },
  };

  try {
    // `text` is what we parsed. If the file no longer holds it, someone
    // else wrote while we were deciding, and `next` is built on a stale
    // read — writing it would silently drop whatever they added. Bail to
    // the manual path rather than clobber: the lock above stops another
    // cempala, and this stops everyone else.
    writeBackPreservingLinks(path, `${JSON.stringify(next, null, 2)}\n`, text);
  } catch (err) {
    if (err instanceof ConcurrentModificationError) {
      return {
        kind: "manual",
        path,
        reason: "the file changed while cempala was updating it, so it was left alone rather than overwritten",
        snippet,
      };
    }
    if (err instanceof NoBackupError) {
      return {
        kind: "manual",
        path,
        reason: `could not create a recovery copy first (${err.message}), so the existing config was left untouched rather than risked`,
        snippet,
      };
    }
    if (err instanceof WriteFailedError) {
      // The one outcome where the user may have lost something. Naming the
      // retained backup is the difference between a recoverable situation
      // and a lost config.
      return {
        kind: "manual",
        path,
        reason: `the write failed (${err.message}) and the original could not be put back automatically. Your previous config is saved at ${err.backupPath}`,
        snippet,
      };
    }
    return { kind: "manual", path, reason: `could not write the file (${errMsg(err)})`, snippet };
  }
  return { kind: "updated", path };
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Replace a file's contents in place, keeping a backup for the duration of
 * the write.
 *
 * Deliberately NOT the usual write-temp-then-rename. A dotfile like this is
 * very often a symlink into a dotfiles repo, and renaming over it replaces
 * the link with a regular file — quietly detaching it from the repo the
 * user manages it in. Writing through the path preserves the link. This is
 * the same trade install.sh makes for shell rc files, and for the same
 * reason: the lost atomicity costs someone only if they are editing this
 * exact file during a window a few milliseconds wide, while the broken
 * symlink would cost them every upgrade.
 *
 * A backup is taken first so a write that THROWS after truncating can be
 * rolled back. It is not protection against the process being killed or
 * losing power mid-write: nothing runs then, and the half-written file
 * survives with the backup beside it.
 */
/** Thrown when the file changed between our read and our write. */
class ConcurrentModificationError extends Error {}

/**
 * Thrown when no recovery copy could be made. Registration stops rather
 * than truncating a config it could not first back up.
 */
class NoBackupError extends Error {}

/**
 * Thrown when the write failed AND the original could not be put back —
 * because someone else's valid config is now at the path, or the restore
 * itself failed. `backupPath` is retained on disk deliberately: it is the
 * user's only remaining copy of what was there, so the outcome names it
 * instead of quietly deleting it.
 */
class WriteFailedError extends Error {
  constructor(message: string, readonly backupPath: string) {
    super(message);
  }
}

function writeBackPreservingLinks(path: string, contents: string, expected: string): void {
  // VERIFY FIRST, before anything is copied or truncated.
  //
  // The ordering is the whole point. An earlier version did this check
  // inside the same try whose catch restores the backup — so detecting a
  // concurrent write made us copy our own stale snapshot over the other
  // writer's change and then report the file as "left alone". That turned
  // the safeguard into the exact data loss it exists to prevent. Nothing
  // has been written at this point, so there is nothing to roll back and
  // the restore path is simply not reachable from here.
  const current = readFileSync(path, "utf-8");
  if (current !== expected) {
    throw new ConcurrentModificationError("config changed between read and write");
  }

  // A UNIQUE backup name, not a fixed `.cempala-bak`.
  //
  // A shared name is a shared mutable file: two registrations running at
  // once would copy different versions of the config to the same path, and
  // then one could restore the other's snapshot on failure, or unlink the
  // backup the other still depends on. install.sh reaches for `mktemp`
  // when it backs up an rc file for exactly this reason — "a predictable
  // name is one the user might already be using" — and this is the same
  // rule applied to the same kind of file.
  const backup = backupPathFor(path);
  try {
    copyFileSync(path, backup);
  } catch (err) {
    // No recovery copy, so DO NOT truncate. `writeFileSync` truncates
    // first and can then fail — ENOSPC is the ordinary way — which would
    // leave an empty or half-written config and nothing to restore from.
    // An earlier comment here claimed the file would be "no worse off
    // either way"; that was simply wrong, and it was wrong in the
    // direction of destroying the user's config.
    throw new NoBackupError(errMsg(err));
  }
  let keepBackup = false;
  try {
    writeFileSync(path, contents, "utf-8");
  } catch (err) {
    // Reachable only from a genuinely failed WRITE. `writeFileSync`
    // truncates before it writes, so at this point WE have very likely
    // destroyed the user's config and our snapshot is the only copy left.
    //
    // Not restoring at all would be the simplest way to guarantee we never
    // overwrite a foreign writer — but it would leave the common case
    // (our write failed, nobody else was involved) with the config
    // destroyed and merely a note saying where the backup is. Trading a
    // frequent, certain loss for a rare, hypothetical one is the wrong
    // way round.
    //
    // So: restore, but only onto damage that is still exactly the damage
    // we observed. Re-reading immediately before the copy means a foreign
    // writer who landed a valid config in the meantime keeps it, and we
    // retain our backup and name it instead of overwriting them.
    let restored = false;
    try {
      const damaged = readFileSync(path, "utf-8");
      if (!isParseableJson(damaged) && readFileSync(path, "utf-8") === damaged) {
        copyFileSync(backup, path);
        restored = true;
      }
    } catch {
      // Cannot read it back — and a read failure is NOT evidence of
      // damage. A foreign writer can leave a perfectly valid config that
      // is momentarily unreadable to us (a permissions change, a
      // replaced inode), and overwriting on that guess would destroy it.
      // We restore only over damage we can positively observe; anything
      // we cannot compare is left alone, with the backup retained and
      // named below.
    }
    if (!restored) {
      // Either someone else's valid config is now there, or the restore
      // itself failed. Either way the backup is the user's only copy of
      // what was there before, so it must outlive this function.
      keepBackup = true;
      throw new WriteFailedError(errMsg(err), backup);
    }
    throw err;
  } finally {
    if (!keepBackup) {
      try { unlinkSync(backup); } catch { /* best effort */ }
    }
  }
}

/**
 * Why `acquireLock` gave up, decided after the fact from what is actually
 * on disk.
 *
 * `acquireLock` cannot tell contention from an unusable directory while it
 * runs — `openSync(…, "wx")` fails the same way for both — but afterwards
 * the difference is plain: a lock file that exists belongs to someone
 * else, and one that does not means we were never able to make it. The
 * distinction matters because it changes what the user should do.
 */
function lockFailureReason(path: string): string {
  const lockPath = `${path}.cempala-lock`;
  if (existsSync(lockPath)) {
    // Deliberately not "another process is registering right now". A lock
    // file proves a lock file exists, and nothing more: it may be a live
    // holder, a stale one in a directory we cannot delete from, or an
    // unrelated file at that name. Naming what was observed, and what to
    // do about it, beats asserting a live process we cannot see.
    return `a lock file at ${lockPath} is in the way — either another cempala is registering right now, or an interrupted one left it behind. Nothing was written; re-run \`cempala --register-antigravity\`, and delete that file if it persists`;
  }
  return `could not create a lock file next to ${path} (the directory may not be writable); nothing was written`;
}

/**
 * A unique backup path per invocation. Exported so the uniqueness itself
 * can be asserted — the property is invisible from outside otherwise,
 * since a successful registration always cleans its backup up.
 */
export function backupPathFor(path: string): string {
  return join(dirname(path), `.${basenameOf(path)}.cempala-bak.${randomBytes(6).toString("hex")}`);
}

/**
 * Write a string in full, or throw.
 *
 * `writeSync` is permitted to write fewer bytes than it was given, and its
 * return value is not advisory — ignoring it means a short write produces
 * a truncated config that the caller then reports as successfully created.
 * The loop is the only way to be sure the bytes actually landed.
 */
function writeAllSync(fd: number, text: string): void {
  const buf = Buffer.from(text, "utf-8");
  let written = 0;
  while (written < buf.length) {
    const n = writeSync(fd, buf, written, buf.length - written);
    if (n <= 0) {
      throw new Error(`short write: ${written} of ${buf.length} bytes written`);
    }
    written += n;
  }
}

function isParseableJson(text: string): boolean {
  if (!text.trim()) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** How long a lock file is honored before it is treated as abandoned. */
const LOCK_STALE_MS = 30_000;
/**
 * How long to wait for a lock another cempala is holding.
 *
 * A registration is a read, a merge and a write — single-digit
 * milliseconds. Two seconds is already a hundredfold margin over any
 * honest holder, and waiting longer only delays the moment we tell the
 * user to re-run.
 */
const LOCK_WAIT_MS = 2_000;
/** Gap between attempts while waiting. */
const LOCK_POLL_MS = 25;

export interface FileLock { release: () => void }

/**
 * An advisory inter-process lock, held via exclusive file creation
 * (`wx` fails if the path exists — the atomic primitive every lock of this
 * shape is built on).
 *
 * Three properties matter here, and each was a bug before it was a rule:
 *
 *  - CONTENTION WAITS. Returning "could not lock, carry on anyway" defeats
 *    the entire purpose, because the only time the lock matters is the
 *    only time it is contended. Two processes would sail past the content
 *    check together and the second write would erase the first. So we
 *    retry for LOCK_WAIT_MS and then give up — and giving up means the
 *    caller reports `manual`, never an unsynchronised write.
 *
 *  - OWNERSHIP IS CHECKED ON RELEASE. Each holder writes a random token.
 *    Without it, a holder whose lock had been stolen as stale would, on
 *    finishing, unlink the *replacement* holder's lock and let a third
 *    process in. Release only removes a lock that is still ours.
 *
 *  - PARTIAL ACQUISITION CLEANS UP. `openSync` can succeed and the write
 *    that follows still throw; an early version leaked both the descriptor
 *    and the lock file, leaving a phantom holder for the full stale
 *    window. The descriptor is closed in a `finally`, and a lock we failed
 *    to finish claiming is unlinked before we report failure.
 *
 * Stealing a lock older than LOCK_STALE_MS is deliberate: an installer
 * killed mid-write must not wedge every future run behind a file nobody
 * will delete. Registration takes milliseconds; 30s is far past any honest
 * holder.
 */
export function acquireLock(path: string): FileLock | null {
  const lockPath = `${path}.cempala-lock`;
  const token = randomBytes(12).toString("hex");

  const tryClaim = (): FileLock | null => {
    let fd: number;
    try {
      mkdirSync(dirname(path), { recursive: true });
      fd = openSync(lockPath, "wx");
    } catch {
      return null; // Someone holds it, or the directory is unwritable.
    }
    // From here the lock file EXISTS and is ours. Any failure has to undo
    // that, or we leave a phantom holder behind for the stale window.
    try {
      try {
        // The same full-write discipline the config path uses. A short
        // write here would leave a truncated token on disk: acquisition
        // reports success, then `release()` compares the complete token
        // against the partial one, decides the lock is not ours, and
        // refuses to remove it — wedging the path until it goes stale.
        writeAllSync(fd, token);
      } finally {
        closeSync(fd);
      }
    } catch {
      try { unlinkSync(lockPath); } catch { /* best effort */ }
      return null;
    }
    return {
      release: () => {
        try {
          // Only ours to remove. If it was stolen as stale and re-taken,
          // the token differs and the new holder keeps its lock.
          if (readFileSync(lockPath, "utf-8") === token) unlinkSync(lockPath);
        } catch { /* already gone */ }
      },
    };
  };

  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const held = tryClaim();
    if (held) return held;

    // Held by someone else — or not held at all and simply uncreatable.
    // `tryClaim` cannot tell those apart, and an earlier version treated
    // every stat failure as "released, retry immediately" with a bare
    // `continue`. In an unwritable directory there is no lock file to
    // stat, so that path never slept and never checked the deadline: a
    // permissions problem turned into an unbounded CPU spin. Every branch
    // below now falls through to the single deadline-and-sleep at the
    // bottom, which is what makes progress guaranteed.
    try {
      const seenAt = statSync(lockPath).mtimeMs;
      if (Date.now() - seenAt > LOCK_STALE_MS) {
        // Compare-and-delete rather than a blind unlink. Between deciding
        // a lock is stale and removing it, the holder can release and a
        // third process can take a fresh one — and deleting THAT would
        // hand the lock to two owners at once. Re-reading the token
        // immediately before the unlink shrinks the window to the gap
        // between these two lines.
        //
        // Honest limit: this is narrower, not closed. A file-based
        // advisory lock cannot be made atomic in userspace, which is why
        // the content check in writeBackPreservingLinks stands behind it
        // rather than relying on the lock alone.
        const token1 = readFileSync(lockPath, "utf-8");
        const token2 = readFileSync(lockPath, "utf-8");
        if (token1 === token2 && statSync(lockPath).mtimeMs === seenAt) {
          try { unlinkSync(lockPath); } catch { /* someone beat us to it */ }
        }
      }
    } catch {
      // No lock file to inspect. Either it was released as we looked, or
      // the directory is unwritable and never had one. Both fall through.
    }

    if (Date.now() >= deadline) return null;
    Bun.sleepSync(LOCK_POLL_MS);
  }
}

function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || "mcp_config.json";
}

/**
 * Human-readable lines for the installer to print. Kept here so install.sh
 * and install.ps1 print the same thing without either one restating the
 * outcomes.
 */
export function describeOutcome(o: RegisterOutcome): string[] {
  switch (o.kind) {
    case "created":
      return [`  ✓ registered cempala in ${o.path}`];
    case "updated":
      return [`  ✓ registered cempala in ${o.path} (existing servers preserved)`];
    case "unchanged":
      return [`  ✓ cempala already registered in ${o.path}`];
    case "manual":
      return [
        `  ! could not register cempala automatically: ${o.reason}`,
        `    Add this to ${o.path} yourself:`,
        ...o.snippet.split("\n").map((l) => `      ${l}`),
      ];
  }
}
