/**
 * Test D1 adapter backed by node:sqlite.
 *
 * These are real integration tests: every file in `migrations/` is applied in
 * order, real SQL runs, and the real Hono app handles real Request objects.
 * Only the transport to SQLite is substituted, so route logic, middleware,
 * repository SQL, constraints and triggers are all genuinely exercised.
 *
 * The surface implemented here is exactly the D1 API the worker uses:
 *   db.prepare(sql).bind(...).first<T>() / .all<T>() / .run()
 *   db.batch([...])
 *   db.exec(sql)
 * A prepared statement is reusable with different bindings, which
 * bulkInsertRosterEntries relies on.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { D1Database } from '@cloudflare/workers-types';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, '../../migrations');

type Row = Record<string, unknown>;

function normalizeBindings(values: unknown[]): unknown[] {
  // node:sqlite rejects booleans and undefined; D1 accepts them.
  return values.map((v) => {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v === undefined) return null;
    return v;
  });
}

class TestStatement {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly bindings: unknown[];
  private readonly log: string[];
  private readonly readLog: string[];

  constructor(
    db: DatabaseSync,
    sql: string,
    bindings: unknown[] = [],
    log: string[] = [],
    readLog: string[] = []
  ) {
    this.db = db;
    this.sql = sql;
    this.bindings = bindings;
    this.log = log;
    this.readLog = readLog;
  }

  bind(...values: unknown[]): TestStatement {
    // Returns a NEW statement so the same prepared statement can be reused with
    // different bindings, matching D1 semantics.
    return new TestStatement(this.db, this.sql, normalizeBindings(values), this.log, this.readLog);
  }

  async first<T = Row>(colName?: string): Promise<T | null> {
    this.readLog.push(this.sql);
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...(this.bindings as never[])) as Row | undefined;
    if (row === undefined) return null;
    if (colName) return (row[colName] ?? null) as T;
    return row as T;
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    this.readLog.push(this.sql);
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...(this.bindings as never[])) as Row[];
    return { results: rows as T[], success: true, meta: {} };
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number; changes: number } }> {
    this.log.push(this.sql);
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...(this.bindings as never[]));
    return {
      success: true,
      meta: {
        last_row_id: Number(info.lastInsertRowid ?? 0),
        changes: Number(info.changes ?? 0),
      },
    };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const { results } = await this.all<Row>();
    return results.map((r) => Object.values(r)) as T[];
  }
}

class TestD1 {
  readonly sqlite: DatabaseSync;
  /**
   * Every write statement actually executed, in order. This lets a test assert
   * that a supposed no-op genuinely touched nothing, which a timestamp
   * comparison cannot prove: the schema has AFTER UPDATE triggers that rewrite
   * `updated_at`, and second-granularity timestamps can collide anyway.
   */
  readonly executedWrites: string[] = [];
  /**
   * Every read statement actually executed, in order. D1 allows 50 queries per
   * invocation on the free plan, so "does this scale with headcount?" is a
   * correctness question, not a tuning one - and counting reads is the only way
   * to answer it that a passing assertion cannot fake.
   */
  readonly executedReads: string[] = [];

  constructor(sqlite: DatabaseSync) {
    this.sqlite = sqlite;
  }

  prepare(sql: string): TestStatement {
    return new TestStatement(this.sqlite, sql, [], this.executedWrites, this.executedReads);
  }

  async batch<T = Row>(statements: TestStatement[]): Promise<Array<{ results: T[]; success: boolean; meta: Record<string, unknown> }>> {
    // D1 batches are transactional: all statements commit, or none do.
    this.sqlite.exec('BEGIN');
    try {
      const out = [];
      for (const stmt of statements) {
        const result = await stmt.run();
        out.push({ results: [] as T[], success: true, meta: result.meta as Record<string, unknown> });
      }
      this.sqlite.exec('COMMIT');
      return out;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('dump() is not supported by the test D1 adapter');
  }

  withSession(): never {
    throw new Error('withSession() is not supported by the test D1 adapter');
  }
}

/**
 * Create a fresh in-memory database with the real schema applied.
 */
export type TestD1Database = D1Database & {
  sqlite: DatabaseSync;
  executedWrites: string[];
  executedReads: string[];
};

export function createTestDb(): TestD1Database {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');

  // Apply every migration in filename order, exactly as `wrangler d1 migrations
  // apply` does. Reading the directory rather than naming one file means a new
  // migration is picked up automatically and the tests can never silently run
  // against a stale schema.
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    sqlite.exec(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }

  return new TestD1(sqlite) as unknown as TestD1Database;
}
