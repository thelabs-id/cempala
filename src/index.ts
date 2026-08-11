#!/usr/bin/env bun
// src/index.ts
//
// MCP server entrypoint. Two modes:
//   1. `cempala --init`  — write a default config if absent (FR-20).
//   2. (default)         — start the stdio MCP server.
//
// Every tool call is wrapped by `withAudit` to record the audit row (FR-8)
// and the reaper (FR-17) is invoked before returning.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, initConfigIfMissing, AGENT_IDS, type AppConfig } from "./config.ts";
import { openDatabase, type DB } from "./db/client.ts";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { sendMessage } from "./tools/send-message.ts";
import { checkMessages } from "./tools/check-messages.ts";
import { createTask } from "./tools/create-task.ts";
import { claimTask } from "./tools/claim-task.ts";
import { completeTask } from "./tools/complete-task.ts";
import { dispatch } from "./tools/dispatch.ts";
import { checkTask } from "./tools/check-task.ts";
import { approvePath } from "./tools/approve-path.ts";
import { sweepStaleTasks } from "./reaper.ts";
import { appendAudit } from "./audit.ts";

/**
 * The version cempala reports, to `--version` and to every MCP client in
 * the `initialize` handshake.
 *
 * Hard-coded rather than read from package.json: the shipped artifact is a
 * compiled binary with no package.json beside it, so a runtime read would
 * work in development and fail in the one place it matters.
 *
 * It therefore has to be kept in step with package.json BY HAND. There
 * were previously three copies of this string — here, in the Server
 * constructor below, and in package.json — and two of them were free to
 * drift without anything noticing. One constant now feeds both call sites,
 * and test/unit/mcp-server.test.ts asserts it matches package.json, so the
 * remaining pair cannot silently disagree.
 *
 * DECLARED HERE, above the argument handling, and not beside the function
 * that returns it. A `const` is in the temporal dead zone until execution
 * reaches it, and `--version` is handled a few lines below: declared lower
 * down, `cempala --version` printed "cempala undefined". The bug is
 * invisible to a test that imports this module, because an import runs the
 * file to completion before asserting anything.
 */
export const CEMPALA_VERSION = "0.2.0";

const ARGS = process.argv.slice(2);

if (ARGS.includes("--init")) {
  const path = await import("./platform/paths.ts").then((m) => m.DEFAULT_CONFIG_PATH);
  const wrote = initConfigIfMissing(path);
  if (wrote) {
    process.stdout.write(`wrote default config to ${path}\n`);
  } else {
    process.stdout.write(`config already exists at ${path}; not overwriting\n`);
  }
  process.exit(0);
}

// `--register-antigravity [path-to-binary]` — used by the installers.
//
// Claude and Codex are registered by shelling out to their own `mcp add`;
// Antigravity has no such subcommand, so the JSON merge lives here instead
// of being written twice, in bash and in PowerShell, against a jq that may
// not be installed. See src/register-antigravity.ts.
if (ARGS.includes("--register-antigravity")) {
  const { registerWithAntigravity, describeOutcome } = await import("./register-antigravity.ts");
  const flagIdx = ARGS.indexOf("--register-antigravity");
  const next = ARGS[flagIdx + 1];
  // Default to this executable's own path. process.execPath is the
  // compiled binary itself, which is exactly what a client needs to
  // launch — and registering an absolute path rather than the bare name
  // `cempala` is what makes the registration work in an editor whose
  // PATH predates the install (the same reasoning as install.sh).
  const binaryPath = next && !next.startsWith("-") ? next : process.execPath;
  const outcome = registerWithAntigravity({ binaryPath });
  process.stdout.write(`${describeOutcome(outcome).join("\n")}\n`);
  // Exit 0 even for `manual`: a config we declined to rewrite is a
  // situation the user must resolve, not a failed install, and failing
  // here would abort an installer that has otherwise fully succeeded.
  process.exit(0);
}

// `--unregister-antigravity` — the inverse of the flag above, used by the
// uninstaller. Removes only cempala's own entry, leaving every other
// server and top-level key alone, and never deletes the file.
if (ARGS.includes("--unregister-antigravity")) {
  const { unregisterFromAntigravity, describeUnregisterOutcome } = await import("./register-antigravity.ts");
  const outcome = unregisterFromAntigravity();
  process.stdout.write(`${describeUnregisterOutcome(outcome).join("\n")}\n`);
  // Exit 0 even for `manual`, as registration does: a config we declined
  // to rewrite is for the user to resolve, not a failed uninstall.
  process.exit(0);
}

// `--remove-path-block <rc-file>...` — used by the uninstaller.
//
// The removal rule lives in the binary rather than in uninstall.sh because
// install.sh must stay self-contained for `curl | bash` and so cannot share
// a library with it; see src/uninstall-path-block.ts for the full reasoning.
if (ARGS.includes("--remove-path-block")) {
  const { removePathBlock } = await import("./uninstall-path-block.ts");
  const { readFileSync: read, writeFileSync: write, existsSync: exists } = await import("node:fs");
  const files = ARGS.slice(ARGS.indexOf("--remove-path-block") + 1).filter((a) => !a.startsWith("-"));
  if (files.length === 0) {
    process.stdout.write("  ! --remove-path-block needs at least one file path\n");
    process.exit(0);
  }
  for (const f of files) {
    if (!exists(f)) continue;
    try {
      const before = read(f, "utf-8");
      const { text, removed } = removePathBlock(before);
      if (removed === 0) continue;
      // Written through the path, not renamed onto it: an rc file is very
      // often a symlink into a dotfiles repo, and replacing the link with
      // a regular file would detach it. Same choice install.sh makes.
      write(f, text, "utf-8");
      process.stdout.write(`  ✓ removed the PATH export from ${f}\n`);
    } catch (err) {
      process.stdout.write(`  ! could not edit ${f} (${err instanceof Error ? err.message : String(err)}); left untouched\n`);
    }
  }
  process.exit(0);
}

if (ARGS.includes("--version") || ARGS.includes("-v")) {
  process.stdout.write(`cempala ${pkgVersion()}\n`);
  process.exit(0);
}

if (ARGS.includes("--help") || ARGS.includes("-h")) {
  process.stdout.write(usage());
  process.exit(0);
}

function pkgVersion(): string {
  return CEMPALA_VERSION;
}

function usage(): string {
  return [
    "cempala — local MCP server for cross-agent task handoff",
    "",
    "Usage:",
    "  cempala           start the stdio MCP server (default)",
    "  cempala --init    write a default config if absent",
    "  cempala --version print version and exit",
    "  cempala --help    print this message",
    "",
    "  cempala --register-antigravity [binary-path]",
    "                    add cempala to Antigravity's global MCP config",
    "                    (~/.gemini/config/mcp_config.json), preserving any",
    "                    servers already there. Defaults to registering this",
    "                    executable. Used by the installer; safe to re-run.",
    "",
    "  cempala --unregister-antigravity",
    "                    remove only cempala's entry from that file, leaving",
    "                    every other server and setting untouched.",
    "",
    "  cempala --remove-path-block <rc-file>...",
    "                    strip the PATH export the installer added to a shell",
    "                    startup file. Only removes a block still carrying the",
    "                    installer's marker comment.",
    "",
    "To uninstall completely, use scripts/uninstall.sh (or uninstall.ps1),",
    "which also unregisters cempala from Claude Code and Codex.",
    "",
  ].join("\n");
}

// ----- MCP server mode -----

const cfg: AppConfig = loadConfig();
if (!existsSync(dirname(cfg.server.db_path))) mkdirSync(dirname(cfg.server.db_path), { recursive: true });
if (!existsSync(cfg.server.output_dir)) mkdirSync(cfg.server.output_dir, { recursive: true });
const db: DB = openDatabase(cfg.server.db_path);

const server = new Server(
  {
    name: "cempala",
    version: CEMPALA_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

const TOOL_DEFS = [
  tool("send_message", "Write a row to the messages table. No side effects beyond storage.", {
    type: "object",
    properties: {
      from_agent: { type: "string" },
      to_agent: { type: "string" },
      content: { type: "string" },
      // Accept null for fields that handlers treat as "not set"; the
      // MCP wire format does not enforce type strictness, but some
      // clients reject properties whose schema does not list "null"
      // as an allowed type. Mirroring the handler's accept-null
      // behavior in the schema is the documented interop fix.
      thread_id: { type: ["string", "null"] },
    },
    required: ["from_agent", "to_agent", "content"],
  }),
  tool("check_messages", "Return unread messages addressed to the agent and mark them read.", {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      since: { type: ["number", "null"], description: "Unix ms; when set, return all messages >= this timestamp" },
      thread_id: { type: ["string", "null"] },
    },
    required: ["agent_id"],
  }),
  tool("create_task", "Create a mailbox task row; validates cwd against the trust boundary.", {
    type: "object",
    properties: {
      description: { type: "string" },
      created_by: { type: "string" },
      assigned_to: { type: ["string", "null"] },
      cwd: { type: "string" },
    },
    required: ["description", "created_by", "cwd"],
  }),
  tool("claim_task", "Claim a pending task; fails for non-pending states.", {
    type: "object",
    properties: {
      task_id: { type: "string" },
      agent_id: { type: "string" },
    },
    required: ["task_id", "agent_id"],
  }),
  tool("complete_task", "Mark a claimed/running task as completed or failed.", {
    type: "object",
    properties: {
      task_id: { type: "string" },
      result: { type: "string", description: "Required per FR-5. Use a non-empty string; 'no output' or similar is fine when the agent returned nothing." },
      status: { type: "string", enum: ["completed", "failed"] },
    },
    required: ["task_id", "result", "status"],
  }),
  tool("dispatch", "Synchronously run a prompt in the target agent; returns the result or a 'running' status if it times out.", {
    type: "object",
    properties: {
      // Read from AGENT_IDS so the advertised enum and the validator in
      // dispatch.ts cannot disagree about what is dispatchable.
      target_agent: { type: "string", enum: [...AGENT_IDS] },
      prompt: { type: "string" },
      cwd: { type: "string" },
      wait_seconds: { type: ["number", "null"], description: "Max wait time; capped at 600 (config.dispatch.max_wait_seconds)" },
      allowed_tools: { type: ["array", "null"], items: { type: "string" }, description: "Narrows Claude's built-in tools by intersection. No-op for codex and antigravity, which have no argv-level tool allowlist." },
      allow_network: { type: ["boolean", "null"], description: "Whether the spawned agent may reach the network. The result's network_enforcement says what was actually applied; for antigravity a false value reports 'not_enforceable', because agy exposes no argv-level network switch." },
      created_by: { type: ["string", "null"] },
    },
    required: ["target_agent", "prompt", "cwd"],
  }),
  tool("check_task", "Read a task's current status; reconciles 'running' tasks whose process has exited.", {
    type: "object",
    properties: {
      task_id: { type: "string" },
    },
    required: ["task_id"],
  }),
  tool("approve_path", "Persist a path outside the home directory into the approved_paths table. Denylisted paths cannot be approved.", {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      path: { type: "string" },
    },
    required: ["agent_id", "path"],
  }),
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const t0 = Date.now();
  let result: unknown;
  let summary = "ok";
  let ok = true;
  try {
    result = await dispatchCall(name, args ?? {}, db, cfg);
    if (result && typeof result === "object" && "ok" in result && (result as { ok: boolean }).ok === false) {
      ok = false;
      summary = `error: ${(result as { error?: string }).error ?? "unknown"}`;
    } else if (result && typeof result === "object" && "data" in result) {
      const data = (result as { data: unknown }).data;
      if (data && typeof data === "object" && "status" in data) {
        summary = `status=${(data as { status: unknown }).status}`;
      }
    }
  } catch (err) {
    ok = false;
    summary = `exception: ${err instanceof Error ? err.message : String(err)}`;
    result = { ok: false, error: summary, code: "exception" };
  }
  // Run the reaper (FR-17) on every tool call.
  try { sweepStaleTasks(db); } catch { /* never fail a tool on reaper errors */ }
  appendAudit(db, {
    tool: name,
    args: args ?? {},
    agent_id: extractAgent(args),
    result_summary: summary,
    duration_ms: Date.now() - t0,
    timestamp: t0,
  });
  // The MCP `tools/call` response distinguishes success from failure with
  // the top-level `isError` flag. Clients are not required to inspect the
  // `content[*].text` JSON to discover that `ok: false` — the spec
  // lets a client surface the error message from `isError=true` directly
  // and skip parsing the body. Without this flag, denylist hits and
  // invalid-state errors are indistinguishable from successful results
  // to a strict client. We keep the structured JSON body intact so
  // non-strict clients (and our own tests) can still consume it.
  return {
    isError: !ok,
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
});

async function dispatchCall(name: string, args: Record<string, unknown>, db: DB, cfg: AppConfig): Promise<unknown> {
  switch (name) {
    case "send_message":
      return sendMessage(db, args as unknown as Parameters<typeof sendMessage>[1]);
    case "check_messages":
      return checkMessages(db, args as unknown as Parameters<typeof checkMessages>[1]);
    case "create_task":
      return createTask(db, cfg, args as unknown as Parameters<typeof createTask>[2]);
    case "claim_task":
      return claimTask(db, args as unknown as Parameters<typeof claimTask>[1]);
    case "complete_task":
      return completeTask(db, args as unknown as Parameters<typeof completeTask>[1]);
    case "dispatch":
      return dispatch(db, cfg, args as unknown as Parameters<typeof dispatch>[2]);
    case "check_task":
      return checkTask(db, args as unknown as Parameters<typeof checkTask>[1]);
    case "approve_path":
      return approvePath(db, cfg, args as unknown as Parameters<typeof approvePath>[2]);
    default:
      return { ok: false, error: `unknown tool: ${name}`, code: "unknown_tool" };
  }
}

function extractAgent(args: unknown): string | null {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    for (const k of ["agent_id", "from_agent", "created_by"]) {
      if (typeof a[k] === "string") return a[k] as string;
    }
  }
  return null;
}

function tool(name: string, description: string, inputSchema: Record<string, unknown>) {
  return { name, description, inputSchema };
}

const transport = new StdioServerTransport();
await server.connect(transport);
