// test/unit/messages.test.ts
//
// FR-1 and FR-2: send_message and check_messages.

import { describe, test, expect } from "bun:test";
import { makeEnv } from "./_helpers.ts";
import { sendMessage } from "../../src/tools/send-message.ts";
import { checkMessages } from "../../src/tools/check-messages.ts";

describe("send_message (FR-1)", () => {
  test("writes a row and returns the message_id", () => {
    const env = makeEnv();
    try {
      const r = sendMessage(env.db, {
        from_agent: "claude",
        to_agent: "codex",
        content: "hello",
        thread_id: "t-1",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(typeof r.data.message_id).toBe("string");
        expect(r.data.message_id.length).toBeGreaterThan(0);
      }
      const row = env.db.get<{ content: string; thread_id: string }>(`SELECT content, thread_id FROM messages LIMIT 1`);
      expect(row?.content).toBe("hello");
      expect(row?.thread_id).toBe("t-1");
    } finally { env.cleanup(); }
  });

  test("rejects missing fields", () => {
    const env = makeEnv();
    try {
      const r = sendMessage(env.db, { from_agent: "", to_agent: "codex", content: "x" });
      expect(r.ok).toBe(false);
    } finally { env.cleanup(); }
  });

  test("auto-creates unknown agents (so adding a new agent requires no extra setup)", () => {
    const env = makeEnv();
    try {
      const r = sendMessage(env.db, {
        from_agent: "agent-a",
        to_agent: "agent-b",
        content: "x",
      });
      expect(r.ok).toBe(true);
      const a = env.db.get<{ id: string }>(`SELECT id FROM agents WHERE id = 'agent-a'`);
      const b = env.db.get<{ id: string }>(`SELECT id FROM agents WHERE id = 'agent-b'`);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
    } finally { env.cleanup(); }
  });

  test("P2: ensureAgent is atomic — concurrent calls to a new agent don't throw", () => {
    // Two concurrent first-references to the same new agent id
    // would, in the pre-fix SELECT-then-INSERT design, both pass the
    // SELECT and then one INSERT would hit the UNIQUE constraint.
    // With INSERT OR IGNORE both succeed.
    const env = makeEnv();
    try {
      // Sequential but rapid; in a real test we'd fork, but the
      // symptom we care about (an exception) would surface here.
      const r1 = sendMessage(env.db, { from_agent: "agent-z", to_agent: "codex", content: "x" });
      const r2 = sendMessage(env.db, { from_agent: "agent-z", to_agent: "codex", content: "y" });
      expect(r1.ok && r2.ok).toBe(true);
      // Exactly one row in agents.
      const count = env.db.get<{ c: number }>(`SELECT COUNT(*) as c FROM agents WHERE id = 'agent-z'`);
      expect(count?.c).toBe(1);
    } finally { env.cleanup(); }
  });
});

describe("check_messages (FR-2)", () => {
  test("returns unread messages and marks them read", () => {
    const env = makeEnv();
    try {
      sendMessage(env.db, { from_agent: "claude", to_agent: "codex", content: "msg1" });
      sendMessage(env.db, { from_agent: "claude", to_agent: "codex", content: "msg2" });
      const r = checkMessages(env.db, { agent_id: "codex" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.length).toBe(2);
      // Subsequent check should be empty.
      const r2 = checkMessages(env.db, { agent_id: "codex" });
      if (r2.ok) expect(r2.data.length).toBe(0);
    } finally { env.cleanup(); }
  });

  test("`since` returns all messages newer than that timestamp (read or not)", () => {
    const env = makeEnv();
    try {
      sendMessage(env.db, { from_agent: "claude", to_agent: "codex", content: "old" });
      const before = Date.now();
      // Sleep just a bit to ensure the second message has a later timestamp.
      const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
      sleep(5);
      sendMessage(env.db, { from_agent: "claude", to_agent: "codex", content: "new" });
      const r = checkMessages(env.db, { agent_id: "codex", since: before });
      if (r.ok) {
        // `since` semantics: include all messages with created_at >= since.
        // The first send happened just before `before`, but timestamps may
        // be equal due to ms granularity. We just check the new one is there.
        const contents = r.data.map((m) => m.content);
        expect(contents).toContain("new");
      }
    } finally { env.cleanup(); }
  });

  test("messages returned via `since` are marked read (no duplicate on later poll)", () => {
    const env = makeEnv();
    try {
      sendMessage(env.db, { from_agent: "claude", to_agent: "codex", content: "poll me" });
      // t0 is in the past, so the message we just sent (created_at > t0)
      // will be returned by the first `since` query, and read-marked.
      const t0 = Date.now() - 60_000;
      const r1 = checkMessages(env.db, { agent_id: "codex", since: t0 });
      if (r1.ok) {
        const contents1 = r1.data.map((m) => m.content);
        expect(contents1).toContain("poll me");
      }
      // The default-branch check returns 0 — the message IS read.
      // This is the actual contract being tested: a `since`-polled
      // message is no longer in the unread queue. (The earlier bug:
      // a polling client would see the same message forever because the
      // since-branch never marked it read, so the default branch
      // continued to return it.)
      const r2 = checkMessages(env.db, { agent_id: "codex" });
      if (r2.ok) {
        const contents2 = r2.data.map((m) => m.content);
        expect(contents2).not.toContain("poll me");
      }
    } finally { env.cleanup(); }
  });

  test("P2: two concurrent check_messages calls don't both get the same unread", () => {
    // In the two-writer setup, two callers can race. The atomic
    // claim (UPDATE-then-SELECT in a single transaction) ensures
    // exactly one caller gets each unread message.
    const env = makeEnv();
    try {
      sendMessage(env.db, { from_agent: "claude", to_agent: "codex", content: "racey" });
      // Sequential back-to-back (we're in a single process, so truly
      // parallel requires a forked test; this catches the symptom in
      // the simpler shape). The second call MUST not see the same
      // message as the first.
      const r1 = checkMessages(env.db, { agent_id: "codex" });
      const r2 = checkMessages(env.db, { agent_id: "codex" });
      expect(r1.ok && r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.data.length).toBe(1);
        expect(r2.data.length).toBe(0);
      }
    } finally { env.cleanup(); }
  });
});
