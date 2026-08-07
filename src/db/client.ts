// src/db/client.ts
//
// Single shared bun:sqlite connection. SQLite's file-locking is the entire
// concurrency model for the multi-writer case (two MCP client processes
// spawning one server each) — bun:sqlite's default journal mode handles it
// at this scale.
//
// We expose a tiny typed wrapper that pre-prepares every statement once and
// hands back a query function per query. No ORM, no query builder — that
// complexity is not earned by five tables.

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL, COLUMN_MIGRATIONS } from "./schema.ts";

export type SqlParam = SQLQueryBindings | null | undefined;
export type SqlParams = SqlParam[];

export interface DB {
  raw: Database;
  // Generic helper: run a query and get rows back.
  all<T = unknown>(sql: string, params?: SqlParams): T[];
  get<T = unknown>(sql: string, params?: SqlParams): T | undefined;
  // Run a write — INSERT/UPDATE/DELETE — and return changes count.
  run(sql: string, params?: SqlParams): { changes: number; lastInsertRowid: number | bigint };
  // Run inside a deferred transaction (the SQLite default). The
  // callback throws → rollback.
  tx<T>(fn: () => T): T;
  // Run inside an immediate transaction. The write lock is acquired
  // at BEGIN rather than at the first write statement, which is
  // necessary for the read-claim pattern in check_messages
  // (otherwise two concurrent callers can both pass the SELECT
  // window before either UPDATE fires).
  txImmediate<T>(fn: () => T): T;
  // Close (used in tests; servers don't normally close).
  close(): void;
}

export function openDatabase(dbPath: string): DB {
  const parent = dirname(dbPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  const raw = new Database(dbPath, { create: true });
  // WAL: better concurrency for two-writer scenario, fine for our scale.
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec("PRAGMA synchronous = NORMAL;");
  // Two MCP server processes (Claude's + Codex's) share this DB. WAL
  // allows multiple readers but only one writer at a time; without
  // busy_timeout, the second writer fails immediately with "database
  // is locked" instead of waiting its turn. 5 seconds is a generous
  // bound — typical writes are sub-millisecond.
  raw.exec("PRAGMA busy_timeout = 5000;");
  raw.exec(SCHEMA_SQL);

  // Additive column migrations for DBs created by earlier builds. `CREATE
  // TABLE IF NOT EXISTS` above leaves an existing table untouched, so without
  // this an upgraded cempala would fail on every query naming a new column.
  for (const m of COLUMN_MIGRATIONS) {
    const cols = raw.prepare(`PRAGMA table_info(${m.table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === m.column)) raw.exec(m.ddl);
  }

  const db: DB = {
    raw,
    all: <T = unknown>(sql: string, params?: SqlParams) =>
      params ? raw.prepare(sql).all(...(params as SQLQueryBindings[])) as T[] : raw.prepare(sql).all() as T[],
    get: <T = unknown>(sql: string, params?: SqlParams) =>
      (params ? raw.prepare(sql).get(...(params as SQLQueryBindings[])) : raw.prepare(sql).get()) as T | undefined,
    run: (sql: string, params?: SqlParams) => {
      const stmt = raw.prepare(sql);
      const r = params ? stmt.run(...(params as SQLQueryBindings[])) : stmt.run();
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
    tx: <T,>(fn: () => T): T => raw.transaction(fn)(),
    txImmediate: <T,>(fn: () => T): T => raw.transaction(fn).immediate(),
    close: () => raw.close(),
  };
  return db;
}
