// src/uninstall-path-block.ts
//
// Removes the PATH export that install.sh writes into a shell startup file.
//
// Why this lives in the binary rather than in uninstall.sh:
//
// install.sh has to stay self-contained — it is piped straight from
// `curl` into bash, so it cannot source a shared library beside it. That
// rules out the obvious fix of extracting its rc-file logic for both
// scripts to use. The remaining choices were to copy its ~90-line awk
// matcher into uninstall.sh, or to implement removal once here and have
// both uninstallers call it. Copying is the drift this codebase has
// already paid for elsewhere (see agent-output.ts), and it would put the
// copy in the script that runs when the user is least able to check the
// result. So: one implementation, in a language with a test suite, and
// install.sh's proven writer left untouched.
//
// The constants below MUST match the ones install.sh writes.
// test/unit/uninstall-path-block.test.ts reads install.sh and asserts they
// do, so the two cannot drift apart silently.
//
// The removal rule is deliberately narrow, and it is the same rule
// install.sh applies when it replaces its own block:
//
//   - A body is only ever removed together with the marker line above it.
//     These are ordinary lines of shell; identical text can appear inside
//     a heredoc, a quoted string, or because someone wrote the same export
//     themselves. The marker is a comment only this installer writes, and
//     requiring it is what makes a match evidence rather than a guess.
//   - One blank line directly above a removed block goes too, so repeated
//     install/uninstall cycles do not accumulate blank lines.
//   - A marker followed by something unrecognised is LEFT ALONE. So is a
//     body with no marker above it. Both are someone's own edit.
//   - Line endings are preserved, and a file that ended without a final
//     newline still ends without one.

/** The comment line install.sh writes above its PATH block. */
export const RC_MARKER = "# cempala installer — added by install.sh";

/** The block install.sh writes today. */
export const RC_BODY_CURRENT = [
  'case ":$PATH:" in',
  '  *":$HOME/.cempala/bin:"*) ;;',
  '  *) PATH="$HOME/.cempala/bin${PATH:+:$PATH}"; export PATH ;;',
  "esac",
];

/**
 * What older versions wrote. Kept so uninstalling removes a block left by
 * whatever version happened to install it — someone uninstalling is very
 * often someone who installed long ago.
 */
export const RC_BODY_LEGACY = ['export PATH="$HOME/.cempala/bin:$PATH"'];

export interface RemovePathBlockResult {
  /** The file contents after removal. */
  text: string;
  /** How many blocks were removed (blank-line trimming not counted). */
  removed: number;
}

/** Strip a trailing CR so a file edited on Windows still matches. */
function bare(line: string): string {
  return line.replace(/\r$/, "");
}

function matchesAt(lines: string[], start: number, body: string[]): boolean {
  if (start + body.length > lines.length) return false;
  for (let i = 0; i < body.length; i++) {
    if (bare(lines[start + i]!) !== body[i]) return false;
  }
  return true;
}

/**
 * Return `text` with every cempala PATH block removed.
 *
 * Pure: no filesystem access, so the rule can be tested directly against
 * the awkward inputs that matter — CRLF files, a missing final newline, a
 * marker whose body someone has edited.
 */
export function removePathBlock(text: string): RemovePathBlockResult {
  if (!text) return { text, removed: 0 };

  const endsWithNewline = /\n$/.test(text);
  // `split` on a trailing newline yields a final empty element; drop it so
  // it cannot be mistaken for a blank line in the file, and restore the
  // newline at the end instead.
  const lines = text.split("\n");
  if (endsWithNewline) lines.pop();

  const out: string[] = [];
  let removed = 0;

  for (let i = 0; i < lines.length; i++) {
    if (bare(lines[i]!) === RC_MARKER) {
      let bodyLen = 0;
      if (matchesAt(lines, i + 1, RC_BODY_CURRENT)) bodyLen = RC_BODY_CURRENT.length;
      else if (matchesAt(lines, i + 1, RC_BODY_LEGACY)) bodyLen = RC_BODY_LEGACY.length;

      if (bodyLen > 0) {
        // Take one blank line immediately above the block with it, so
        // install/uninstall cycles do not leave a growing gap behind.
        if (out.length > 0 && bare(out[out.length - 1]!) === "") out.pop();
        i += bodyLen; // skip the body; the loop's i++ skips the marker
        removed++;
        continue;
      }
      // Marker with an unrecognised body: someone edited it. Leave it.
    }
    out.push(lines[i]!);
  }

  if (removed === 0) return { text, removed: 0 };
  return { text: out.join("\n") + (endsWithNewline ? "\n" : ""), removed };
}
