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

async function startServer(): Promise<ServerHandle> {
  const proc = spawn({
    cmd: ["bun", "run", "src/index.ts"],
    cwd: process.cwd(),
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
      expect([...targets].sort()).toEqual(["antigravity", "claude", "codex"]);
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
});
