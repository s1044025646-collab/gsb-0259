/**
 * SQLite 持久层：生成器最后状态 + 发放记录。
 * 状态推进与记录写入在同一个事务内完成；整库写串行化（BEGIN IMMEDIATE），
 * 保证多个连接并发申请不会拿到相同标识或覆盖已推进状态。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type GeneratorRow = {
  name: string;
  last_timestamp_ms: number;
  last_random: string;
  last_ulid: string | null;
  created_at: string;
  updated_at: string;
};

export type IssueRow = {
  id: number;
  generator: string;
  ulid: string;
  timestamp_ms: number;
  random: string;
  issued_at: string;
};

export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS generators (
      name              TEXT PRIMARY KEY,
      last_timestamp_ms INTEGER NOT NULL,
      last_random       TEXT    NOT NULL,
      last_ulid         TEXT,
      created_at        TEXT    NOT NULL,
      updated_at        TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS issues (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      generator   TEXT    NOT NULL REFERENCES generators(name),
      ulid        TEXT    NOT NULL UNIQUE,
      timestamp_ms INTEGER NOT NULL,
      random      TEXT    NOT NULL,
      issued_at   TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_issues_gen ON issues(generator, id);
  `);
  return db;
}

export function getGenerator(db: DatabaseSync, name: string): GeneratorRow | undefined {
  return db
    .prepare("SELECT * FROM generators WHERE name = ?")
    .get(name) as GeneratorRow | undefined;
}

export function listGenerators(db: DatabaseSync): GeneratorRow[] {
  return db.prepare("SELECT * FROM generators ORDER BY name").all() as GeneratorRow[];
}

export function insertGenerator(
  db: DatabaseSync,
  name: string,
  now: string,
): void {
  db.prepare(
    `INSERT INTO generators (name, last_timestamp_ms, last_random, last_ulid, created_at, updated_at)
     VALUES (?, -1, '0', NULL, ?, ?)`,
  ).run(name, now, now);
}

export type PersistedIssue = {
  ulid: string;
  timestampMs: number;
  random: bigint;
};

/**
 * 在单个 IMMEDIATE 事务内：读取最新状态 -> 由 advance 推进 -> 写状态 + 写发放记录。
 * advance 必须是纯函数式计算，所有写入集中在事务内，失败整体回滚。
 */
export function commitBatch(
  db: DatabaseSync,
  name: string,
  issued: PersistedIssue[],
): void {
  const last = issued[issued.length - 1]!;
  db.exec("BEGIN IMMEDIATE");
  try {
    const now = new Date().toISOString();
    const update = db.prepare(
      `UPDATE generators
       SET last_timestamp_ms = ?, last_random = ?, last_ulid = ?, updated_at = ?
       WHERE name = ?`,
    );
    update.run(last.timestampMs, last.random.toString(), last.ulid, now, name);
    const insert = db.prepare(
      `INSERT INTO issues (generator, ulid, timestamp_ms, random, issued_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const item of issued) {
      insert.run(name, item.ulid, item.timestampMs, item.random.toString(), now);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function queryHistory(
  db: DatabaseSync,
  generator: string,
  limit: number,
  offset: number,
): IssueRow[] {
  return db
    .prepare(
      `SELECT * FROM issues WHERE generator = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(generator, limit, offset) as IssueRow[];
}

export function countHistory(db: DatabaseSync, generator: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM issues WHERE generator = ?")
    .get(generator) as { n: number };
  return Number(row.n);
}

export function findUlids(db: DatabaseSync, ulids: string[]): Set<string> {
  if (ulids.length === 0) return new Set();
  const placeholders = ulids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT ulid FROM issues WHERE ulid IN (${placeholders})`)
    .all(...ulids) as { ulid: string }[];
  return new Set(rows.map((r) => r.ulid));
}
