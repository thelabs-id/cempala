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
import { loadConfig, initConfigIfMissing, type AppConfig } from "./config.ts";
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

if (ARGS.includes("--version") || ARGS.includes("-v")) {
  process.stdout.write(`cempala ${pkgVersion()}\n`);
  process.exit(0);
}

if (ARGS.includes("--help") || ARGS.includes("-h")) {
  process.stdout.write(usage());
  process.exit(0);
}

function pkgVersion(): string {
  // Hard-coded; package.json version is the source. Avoid reading fs
  // at runtime since the binary is compiled.
  return "0.1.0";
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
    version: "0.1.0",
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
      thread_id: { type: "string" },
    },
    required: ["from_agent", "to_agent", "content"],
  }),
  tool("check_messages", "Return unread messages addressed to the agent and mark them read.", {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      since: { type: "number", description: "Unix ms; when set, return all messages >= this timestamp" },
      thread_id: { type: "string" },
    },
    required: ["agent_id"],
  }),
  tool("create_task", "Create a mailbox task row; validates cwd against the trust boundary.", {
    type: "object",
    properties: {
      description: { type: "string" },
      created_by: { type: "string" },
      assigned_to: { type: "string" },
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
      target_agent: { type: "string", enum: ["codex", "claude"] },
      prompt: { type: "string" },
      cwd: { type: "string" },
      wait_seconds: { type: "number", description: "Max wait time; capped at 600 (config.dispatch.max_wait_seconds)" },
      allowed_tools: { type: "array", items: { type: "string" } },
      allow_network: { type: "boolean" },
      created_by: { type: "string" },
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
  return {
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
