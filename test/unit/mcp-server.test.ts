// test/unit/mcp-server.test.ts
//
// End-to-end test of the MCP server. Spawns the actual cempala binary
// (or, if --init hasn't been run, falls back to running via Bun) and
// speaks the JSON-RPC protocol to it over stdio. Verifies:
//   - initialize handshake
//   - tools/list returns the 8 expected tools
//   - tools/call for send_message works
//   - tools/call for approve_path rejects a denylisted path
//
// We use the runtime's entrypoint (`bun run src/index.ts`) instead of
// the compiled binary so this test doesn't depend on `bun build` having
// run. The integration tests in test/integration exercise the binary.

import { describe, test, expect } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ServerHandle {
  proc: Subprocess;
  send: (obj: unknown) => Promise<void>;
  readOne: () => Promise<JsonRpcResponse | null>;
  close: () => void;
}

async function startServer(env?: Record<string, string | undefined>): Promise<ServerHandle> {
  const proc = spawn({
    cmd: ["bun", "run", "src/index.ts"],
    cwd: process.cwd(),
    env: env ? { ...process.env, ...env } : undefined,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buf = "";
  const reader = proc.stdout.getReader();

  const send = async (obj: unknown) => {
    await proc.stdin.write(encoder.encode(JSON.stringify(obj) + "\n"));
  };

  // Drain stdout in the background, surface lines via a buffer.
  (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value);
    }
  })();

  const readOne = async (): Promise<JsonRpcResponse | null> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim().length === 0) continue;
        try {
          return JSON.parse(line) as JsonRpcResponse;
        } catch {
          // skip non-JSON lines (server stderr-like noise)
          continue;
        }
      }
      // No line yet — wait a bit and re-poll.
      await new Promise((r) => setTimeout(r, 25));
    }
    return null;
  };

  return {
    proc,
    send,
    readOne,
    close: () => {
      try { proc.kill(); } catch { /* ignore */ }
    },
  };
}

describe("version reporting", () => {
  // The binary cannot read package.json at runtime, so the version is
  // hard-coded — which means nothing but these tests stops the two from
  // drifting. A release built from a stale constant reports the wrong
  // version to every MCP client in the initialize handshake, and to anyone
  // running `cempala --version` to check what they installed.
  async function pkgVersion(): Promise<string> {
    return JSON.parse(await Bun.file(join(process.cwd(), "package.json")).text()).version;
  }

  test("`--version` prints the package.json version", async () => {
    // Run it as a PROCESS, not as an import. `--version` is handled during
    // module evaluation, so importing the module runs the file to
    // completion and then asserts — which cannot see an ordering fault in
    // the file itself. A `const` declared below this handler is in the
    // temporal dead zone when it fires, and that really did ship
    // "cempala undefined" for a moment; only spawning catches it.
    const proc = spawn({ cmd: ["bun", "run", "src/index.ts", "--version"], cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out.trim()).toBe(`cempala ${await pkgVersion()}`);
    expect(out).not.toContain("undefined");
  });

  test("the version advertised over MCP matches package.json", async () => {
    const s = await startServer();
    try {
      await s.send({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test-client", version: "0.1.0" } },
      });
      const r = await s.readOne();
      expect((r?.result as any)?.serverInfo?.version).toBe(await pkgVersion());
    } finally { s.close(); }
  });
});

describe("MCP server (end-to-end via stdio)", () => {
  test("initialize handshake returns server info", async () => {
    const s = await startServer();
    try {
      await s.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.1.0" },
        },
      });
      const r = await s.readOne();
      expect(r?.id).toBe(1);
      expect((r?.result as { serverInfo?: { name: string } })?.serverInfo?.name).toBe("cempala");
    } finally { s.close(); }
  });

  test("tools/list returns 8 tools (FR-1..FR-7a + dispatch)", async () => {
    const s = await startServer();
    try {
      // initialize
      await s.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.1.0" },
        },
      });
      await s.readOne();
      // tools/list
      await s.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const r = await s.readOne();
      expect(r?.id).toBe(2);
      const tools = (r?.result as { tools?: { name: string }[] })?.tools ?? [];
      expect(tools.length).toBe(8);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "approve_path",
        "check_messages",
        "check_task",
        "claim_task",
        "complete_task",
        "create_task",
        "dispatch",
        "send_message",
      ]);
    } finally { s.close(); }
  });

  test("the dispatch tool advertises every dispatchable agent", async () => {
    // The enum is what a calling agent reads to decide what it may ask
    // for. An agent cempala can spawn but does not advertise is one no
    // caller will ever choose; one it advertises but cannot spawn fails
    // at the end of a caller's turn. Both come from the enum and the
    // validator drifting apart, so this asserts the wire-visible half.
    const s = await startServer();
    try {
      await s.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.1.0" },
        },
      });
      await s.readOne();
      await s.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const r = await s.readOne();
      const tools = (r?.result as { tools?: { name: string; inputSchema?: any }[] })?.tools ?? [];
      const dispatchTool = tools.find((t) => t.name === "dispatch");
      const targets: string[] = dispatchTool?.inputSchema?.properties?.target_agent?.enum ?? [];
      expect([...targets].sort()).toEqual(["antigravity", "claude", "codex", "opencode"]);
    } finally { s.close(); }
  });

  test("send_message is callable and returns ok=true", async () => {
    const s = await startServer();
    try {
      await s.send({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      await s.readOne();
      await s.send({
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "send_message", arguments: { from_agent: "claude", to_agent: "codex", content: "hi" } },
      });
      const r = await s.readOne();
      expect(r?.id).toBe(3);
      const text = ((r?.result as { content?: { text: string }[] })?.content?.[0]?.text) ?? "";
      const inner = JSON.parse(text) as { ok: boolean; data?: { message_id: string } };
      expect(inner.ok).toBe(true);
      expect(inner.data?.message_id).toBeDefined();
    } finally { s.close(); }
  });

  test("approve_path rejects a denylisted path (AC-10 over MCP)", async () => {
    const s = await startServer();
    try {
      await s.send({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      await s.readOne();
      const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
      await s.send({
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: "approve_path", arguments: { agent_id: "claude", path: join(home, ".ssh") } },
      });
      const r = await s.readOne();
      expect(r?.id).toBe(4);
      const text = ((r?.result as { content?: { text: string }[] })?.content?.[0]?.text) ?? "";
      const inner = JSON.parse(text) as { ok: boolean; error?: string; code?: string };
      expect(inner.ok).toBe(false);
      expect(inner.code).toBe("denylist");
    } finally { s.close(); }
  });

  test("every MCP tool works together, including an OpenCode dispatch, and persists auditable state", async () => {
    // Give the spawned server a hermetic config, database, output directory
    // and trust root. The fake OpenCode executable speaks the real JSONL
    // event shape, so this is an end-to-end protocol test without spending
    // an external provider request in the unit suite.
    const root = mkdtempSync(join(tmpdir(), "cempala-mcp-all-"));
    const home = join(root, "home");
    const workspace = join(home, "workspace");
    const configDir = join(home, ".cempala");
    const dbPath = join(configDir, "cempala.db");
    const outputs = join(configDir, "outputs");
    const outside = join(root, "approved-outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outputs, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const fakeOpenCode = 'process.stdout.write(JSON.stringify({type:"text",part:{type:"text",text:"CEMPALA_OPENCODE_OK"}})+"\\n")';
    writeFileSync(join(configDir, "config.toml"), [
      "[server]",
      `db_path = ${JSON.stringify(dbPath)}`,
      `output_dir = ${JSON.stringify(outputs)}`,
      "[trust]",
      `home_root = ${JSON.stringify(home)}`,
      "denylist = []",
      "[agents.opencode]",
      `exec_command = ["bun", "-e", ${JSON.stringify(fakeOpenCode)}]`,
    ].join("\n"), "utf8");

    // node:os.homedir() resolves USERPROFILE on Windows, not HOME. Set both
    // so this test never reads a real user-level Cempala config or database.
    const s = await startServer({ HOME: home, USERPROFILE: home });
    let dispatchTaskId = "";
    try {
      let requestId = 0;
      const call = async (name: string, args: Record<string, unknown>) => {
        requestId += 1;
        await s.send({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: args } });
        const response = await s.readOne();
        expect(response?.id).toBe(requestId);
        const body = ((response?.result as { content?: { text: string }[] })?.content?.[0]?.text) ?? "";
        return JSON.parse(body) as { ok: boolean; data?: any };
      };

      await s.send({
        jsonrpc: "2.0", id: 100, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "all-tools", version: "0" } },
      });
      expect((await s.readOne())?.id).toBe(100);

      const sent = await call("send_message", { from_agent: "opencode", to_agent: "codex", content: "handoff ready" });
      expect(sent.ok).toBe(true);
      const messages = await call("check_messages", { agent_id: "codex" });
      expect(messages.ok).toBe(true);
      expect(messages.data[0].content).toBe("handoff ready");

      const created = await call("create_task", {
        description: "mailbox handoff", created_by: "opencode", assigned_to: "opencode", cwd: workspace,
      });
      expect(created.data.status).toBe("pending");
      const mailboxTaskId = created.data.task_id as string;
      expect((await call("claim_task", { task_id: mailboxTaskId, agent_id: "opencode" })).ok).toBe(true);
      expect((await call("complete_task", { task_id: mailboxTaskId, status: "completed", result: "done" })).ok).toBe(true);
      expect((await call("check_task", { task_id: mailboxTaskId })).data.status).toBe("completed");

      const approved = await call("approve_path", { agent_id: "opencode", path: outside });
      expect(approved.ok).toBe(true);

      const dispatched = await call("dispatch", {
        target_agent: "opencode",
        prompt: "reply with the test token", cwd: workspace, wait_seconds: 10,
        allow_network: false, created_by: "opencode",
      });
      expect(dispatched.ok).toBe(true);
      expect(dispatched.data.status).toBe("completed");
      expect(dispatched.data.result).toBe("CEMPALA_OPENCODE_OK");
      expect(dispatched.data.network_enforcement).toBe("tools_only");
      dispatchTaskId = dispatched.data.task_id as string;
    } finally {
      s.close();
      await s.proc.exited;
    }

    // This is deliberately outside the MCP surface: it verifies that the
    // calls above committed their database rows and that the dispatched
    // OpenCode JSONL log is both retained and parseable after the server
    // exits.
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).toEqual({ n: 8 });
      const dispatched = db.query("SELECT status, output_file FROM tasks WHERE id = ?").get(dispatchTaskId) as { status: string; output_file: string };
      expect(dispatched.status).toBe("completed");
      expect(readFileSync(dispatched.output_file, "utf8")).toContain("CEMPALA_OPENCODE_OK");
    } finally {
      db.close();
    }
  });
});
