import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ApiError } from './errors.js';
import {
  MAX_BATCH_SIZE,
  type Clock,
  type IssuedParts,
  type RandomBytes,
  nextMonotonic
} from './ulid.js';

export interface GeneratorRecord {
  name: string;
  createdAt: string;
  updatedAt: string;
  lastTimestampMs: string | null;
  lastRandom: string | null;
  lastUlid: string | null;
  issuedCount: number;
}

export interface IssuedRecord {
  sequence: number;
  generator: string;
  ulid: string;
  timestampMs: string;
  random: string;
  randomSource: 'new' | 'incremented';
  retainedTimestamp: boolean;
  issuedAt: string;
}

export interface IssueOptions {
  count?: number;
}

interface StateRow {
  generator_name: string;
  timestamp_ms: string | null;
  random_value: string | null;
}

interface CountRow {
  total: number | bigint;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class UlidStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path, { timeout: 10_000 });
    this.database.exec('PRAGMA journal_mode = WAL;');
    this.database.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  createGenerator(name: string): GeneratorRecord {
    validateGeneratorName(name);
    const now = new Date().toISOString();
    try {
      this.database
        .prepare(
          `INSERT INTO generators (generator_name, created_at, updated_at)
           VALUES (?, ?, ?)`
        )
        .run(name, now, now);
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new ApiError('CONFLICT', `生成器 ${name} 已存在`, 409);
      }
      throw mapDatabaseError(error);
    }
    return this.getGenerator(name);
  }

  getGenerator(name: string): GeneratorRecord {
    validateGeneratorName(name);
    const row = this.database
      .prepare(
        `SELECT g.generator_name, g.created_at, g.updated_at, s.timestamp_ms, s.random_value, s.last_ulid,
                COALESCE((SELECT COUNT(*) FROM issued_ulids i WHERE i.generator_name = g.generator_name), 0) AS issued_count
         FROM generators g
         LEFT JOIN generator_state s ON s.generator_name = g.generator_name
         WHERE g.generator_name = ?`
      )
      .get(name) as GeneratorJoinRow | undefined;
    if (!row) throw new ApiError('NOT_FOUND', `生成器 ${name} 不存在`, 404);
    return mapGenerator(row);
  }

  listGenerators(): GeneratorRecord[] {
    const rows = this.database
      .prepare(
        `SELECT g.generator_name, g.created_at, g.updated_at, s.timestamp_ms, s.random_value, s.last_ulid,
                (SELECT COUNT(*) FROM issued_ulids i WHERE i.generator_name = g.generator_name) AS issued_count
         FROM generators g
         LEFT JOIN generator_state s ON s.generator_name = g.generator_name
         ORDER BY g.created_at ASC, g.generator_name ASC`
      )
      .all() as unknown as GeneratorJoinRow[];
    return rows.map(mapGenerator);
  }

  issue(
    name: string,
    clock: Clock,
    randomBytes: RandomBytes,
    options: IssueOptions = {}
  ): IssuedRecord[] {
    const count = normalizeCount(options.count);
    this.requireGenerator(name);
    const issuedAt = new Date().toISOString();

    try {
      this.database.exec('BEGIN IMMEDIATE');
      const state = this.getStateRow(name);
      let previous = state
        ? { timestamp: BigInt(state.timestamp_ms!), random: BigInt(state.random_value!) }
        : null;
      const issued: IssuedRecord[] = [];

      for (let index = 0; index < count; index += 1) {
        const now = clock();
        const part: IssuedParts = nextMonotonic(now, randomBytes(10), previous);
        previous = { timestamp: part.timestamp, random: part.random };
        const result = this.database
          .prepare(
            `INSERT INTO issued_ulids
               (generator_name, ulid, timestamp_ms, random_value, random_source, retained_timestamp, issued_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            name,
            part.ulid,
            part.timestamp.toString(),
            part.random.toString(),
            part.randomSource,
            part.retainedTimestamp ? 1 : 0,
            issuedAt
          );
        issued.push({
          sequence: Number(result.lastInsertRowid),
          generator: name,
          ulid: part.ulid,
          timestampMs: part.timestamp.toString(),
          random: part.random.toString(),
          randomSource: part.randomSource,
          retainedTimestamp: part.retainedTimestamp,
          issuedAt
        });
      }

      const last = issued[issued.length - 1]!;
      this.database
        .prepare(
          `INSERT INTO generator_state (generator_name, timestamp_ms, random_value, last_ulid, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(generator_name) DO UPDATE SET
             timestamp_ms = excluded.timestamp_ms,
             random_value = excluded.random_value,
             last_ulid = excluded.last_ulid,
             updated_at = excluded.updated_at`
        )
        .run(name, last.timestampMs, last.random, last.ulid, issuedAt);
      this.database.exec('COMMIT');
      return issued;
    } catch (error) {
      this.safeRollback();
      throw mapDatabaseError(error);
    }
  }

  history(name: string, limit = 50, beforeSequence?: number): IssuedRecord[] {
    this.requireGenerator(name);
    const normalizedLimit = normalizeLimit(limit, 200);
    if (beforeSequence !== undefined && (!Number.isInteger(beforeSequence) || beforeSequence < 1)) {
      throw new ApiError('VALIDATION_ERROR', 'beforeSequence 必须是正整数');
    }
    const rows = beforeSequence
      ? this.database
          .prepare(
            `SELECT id, generator_name, ulid, timestamp_ms, random_value, random_source, retained_timestamp, issued_at
             FROM issued_ulids WHERE generator_name = ? AND id < ? ORDER BY id DESC LIMIT ?`
          )
          .all(name, beforeSequence, normalizedLimit)
      : this.database
          .prepare(
            `SELECT id, generator_name, ulid, timestamp_ms, random_value, random_source, retained_timestamp, issued_at
             FROM issued_ulids WHERE generator_name = ? ORDER BY id DESC LIMIT ?`
          )
          .all(name, normalizedLimit);
    return (rows as unknown as IssuedRow[]).map(mapIssued).reverse();
  }

  exportRecords(name: string, limit = 1000): IssuedRecord[] {
    this.requireGenerator(name);
    const normalizedLimit = normalizeLimit(limit, 10_000);
    const rows = this.database
      .prepare(
        `SELECT id, generator_name, ulid, timestamp_ms, random_value, random_source, retained_timestamp, issued_at
         FROM issued_ulids WHERE generator_name = ? ORDER BY id ASC LIMIT ?`
      )
      .all(name, normalizedLimit);
    return (rows as unknown as IssuedRow[]).map(mapIssued);
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS generators (
        generator_name TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS generator_state (
        generator_name TEXT PRIMARY KEY,
        timestamp_ms TEXT NOT NULL,
        random_value TEXT NOT NULL,
        last_ulid TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (generator_name) REFERENCES generators(generator_name) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS issued_ulids (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        generator_name TEXT NOT NULL,
        ulid TEXT NOT NULL,
        timestamp_ms TEXT NOT NULL,
        random_value TEXT NOT NULL,
        random_source TEXT NOT NULL CHECK (random_source IN ('new', 'incremented')),
        retained_timestamp INTEGER NOT NULL CHECK (retained_timestamp IN (0, 1)),
        issued_at TEXT NOT NULL,
        UNIQUE(generator_name, ulid),
        FOREIGN KEY (generator_name) REFERENCES generators(generator_name) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_issued_generator_id ON issued_ulids(generator_name, id);
    `);
  }

  private requireGenerator(name: string): void {
    validateGeneratorName(name);
    const row = this.database
      .prepare('SELECT 1 FROM generators WHERE generator_name = ?')
      .get(name);
    if (!row) throw new ApiError('NOT_FOUND', `生成器 ${name} 不存在`, 404);
  }

  private getStateRow(name: string): StateRow | null {
    const row = this.database
      .prepare(
        'SELECT generator_name, timestamp_ms, random_value FROM generator_state WHERE generator_name = ?'
      )
      .get(name) as StateRow | undefined;
    return row ?? null;
  }

  private safeRollback(): void {
    try {
      this.database.exec('ROLLBACK');
    } catch {
      // The transaction may already have been rolled back by SQLite.
    }
  }
}

interface GeneratorJoinRow {
  generator_name: string;
  created_at: string;
  updated_at: string;
  timestamp_ms: string | null;
  random_value: string | null;
  last_ulid: string | null;
  issued_count: number | bigint;
}

interface IssuedRow {
  id: number | bigint;
  generator_name: string;
  ulid: string;
  timestamp_ms: string;
  random_value: string;
  random_source: 'new' | 'incremented';
  retained_timestamp: number | bigint;
  issued_at: string;
}

function mapGenerator(row: GeneratorJoinRow): GeneratorRecord {
  return {
    name: row.generator_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTimestampMs: row.timestamp_ms,
    lastRandom: row.random_value,
    lastUlid: row.last_ulid,
    issuedCount: Number(row.issued_count)
  };
}

function mapIssued(row: IssuedRow): IssuedRecord {
  return {
    sequence: Number(row.id),
    generator: row.generator_name,
    ulid: row.ulid,
    timestampMs: row.timestamp_ms,
    random: row.random_value,
    randomSource: row.random_source,
    retainedTimestamp: Number(row.retained_timestamp) === 1,
    issuedAt: row.issued_at
  };
}

function validateGeneratorName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new ApiError(
      'VALIDATION_ERROR',
      '生成器名称必须为 1-64 位字母、数字、点、下划线或连字符，且以字母或数字开头'
    );
  }
}

function normalizeCount(count: unknown): number {
  if (count === undefined) return 1;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
    throw new ApiError('VALIDATION_ERROR', 'count 必须是介于 1 和 100 之间的整数');
  }
  if (count > MAX_BATCH_SIZE) {
    throw new ApiError('BATCH_TOO_LARGE', `每批最多请求 ${MAX_BATCH_SIZE} 条`);
  }
  return count;
}

function normalizeLimit(limit: unknown, maximum: number): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new ApiError('VALIDATION_ERROR', `limit 必须是介于 1 和 ${maximum} 之间的整数`);
  }
  return limit;
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /SQLITE_CONSTRAINT_(PRIMARYKEY|UNIQUE)/.test(error.message);
}

function mapDatabaseError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (error instanceof Error && /SQLITE_BUSY|SQLITE_LOCKED/.test(error.message)) {
    return new ApiError('DATABASE_BUSY', '数据库暂时被其他连接锁定，请重试', 503);
  }
  return error;
}
