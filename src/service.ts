/**
 * 生成器服务：单调状态推进 + 持久化事务 + 解码/核验/历史。
 *
 * 单调规则（仅限同一个命名生成器内部）：
 * - 当前时间 > 上次时间：使用当前时间，随机量取新的安全随机值；
 * - 当前时间 = 上次时间（同毫秒）：时间不变，随机量 + 1；
 * - 当前时间 < 上次时间（时钟回退）：保留上次（更大）时间戳，随机量 + 1；
 * - 随机量达到 2^80-1 仍需进位：拒绝本次生成，不回绕、不忙等、不伪造未来时间。
 */
import type { DatabaseSync } from "node:sqlite";
import {
  commitBatch,
  countHistory,
  findUlids,
  getGenerator,
  insertGenerator,
  listGenerators,
  queryHistory,
  type GeneratorRow,
} from "./store.ts";
import {
  decodeULID,
  encodeULID,
  normalizeULID,
  MAX_RANDOM,
  UlidError,
  type DecodedULID,
} from "./ulid.ts";
import { secureRandom80, systemClock, type Clock, type RandomSource } from "./rng.ts";

export const MAX_BATCH_SIZE = 1024;
export const MAX_NAME_LENGTH = 128;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class ServiceError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.status = status;
  }
}

export type GenerateOptions = {
  clock?: Clock;
  random?: RandomSource;
};

export function validateName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new ServiceError(
      "INVALID_NAME",
      "生成器名称须为 1-128 字符，仅含字母、数字、点、下划线、中划线，且以字母或数字开头",
    );
  }
}

export class UlidService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly defaultClock: Clock = systemClock,
    private readonly defaultRandom: RandomSource = secureRandom80,
  ) {}

  createGenerator(name: string, nowIso?: string): GeneratorRow {
    validateName(name);
    if (getGenerator(this.db, name)) {
      throw new ServiceError("GENERATOR_EXISTS", `生成器 "${name}" 已存在`, 409);
    }
    insertGenerator(this.db, name, nowIso ?? new Date().toISOString());
    return getGenerator(this.db, name)!;
  }

  listGenerators() {
    return listGenerators(this.db).map((row) => this.describe(row));
  }

  getGenerator(name: string): GeneratorRow {
    validateName(name);
    const row = getGenerator(this.db, name);
    if (!row) throw new ServiceError("GENERATOR_NOT_FOUND", `生成器 "${name}" 不存在`, 404);
    return row;
  }

  private describe(row: GeneratorRow) {
    return {
      name: row.name,
      lastTimestampMs: row.last_timestamp_ms,
      lastTimestampISO:
        row.last_timestamp_ms >= 0 ? new Date(row.last_timestamp_ms).toISOString() : null,
      lastRandom: row.last_random,
      lastUlid: row.last_ulid,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 批量发放。要么全部成功提交，要么整体回滚并抛出错误——不会留下半批。
   * 整个批次在一个 IMMEDIATE 事务内，与其他连接的申请互斥。
   */
  generate(name: string, count = 1, opts: GenerateOptions = {}): string[] {
    validateName(name);
    if (!Number.isInteger(count) || count < 1) {
      throw new ServiceError("INVALID_COUNT", "数量必须是 >= 1 的整数");
    }
    if (count > MAX_BATCH_SIZE) {
      throw new ServiceError("BATCH_TOO_LARGE", `单次批量上限为 ${MAX_BATCH_SIZE}`);
    }
    const row = this.getGenerator(name);
    const clock = opts.clock ?? this.defaultClock;
    const random = opts.random ?? this.defaultRandom;

    let lastTs = row.last_timestamp_ms;
    let lastRandom = BigInt(row.last_random);

    const issued: { ulid: string; timestampMs: number; random: bigint }[] = [];
    try {
      for (let i = 0; i < count; i++) {
        const now = clock();
        if (!Number.isInteger(now) || now < 0) {
          throw new ServiceError("CLOCK_INVALID", "时钟返回值必须是非负整数毫秒");
        }
        let ts: number;
        let rnd: bigint;
        if (now > lastTs) {
          ts = now;
          rnd = random();
        } else {
          // 同毫秒 或 时钟回退：保留上次时间戳，随机量加一。
          if (lastTs < 0) {
            // 首次发放即遇到非正时钟（理论上 now>=0 不会触发），直接用当前时间。
            ts = now;
            rnd = random();
          } else {
            ts = lastTs;
            if (lastRandom >= MAX_RANDOM) {
              throw new UlidError(
                "MONOTONIC_OVERFLOW",
                "随机量在该毫秒内已达 2^80-1，拒绝本次生成（不回绕、不等待、不伪造时间）",
              );
            }
            rnd = lastRandom + 1n;
          }
        }
        const ulid = encodeULID(ts, rnd);
        issued.push({ ulid, timestampMs: ts, random: rnd });
        lastTs = ts;
        lastRandom = rnd;
      }
    } catch (err) {
      // 计算阶段任何失败：不落库，直接整体失败（无半批）。
      if (err instanceof ServiceError) throw err;
      throw err;
    }

    commitBatch(this.db, name, issued);
    return issued.map((x) => x.ulid);
  }

  decode(input: string): DecodedULID & { canonical: string } {
    if (typeof input !== "string" || input.length === 0) {
      throw new ServiceError("INVALID_ULID", "待解码内容必须是非空字符串");
    }
    // 先规范化为大写再做严格校验（仅大小写差异时给出 canonical）。
    const canonical = normalizeULID(input);
    const decoded = decodeULID(canonical);
    return { ...decoded, canonical };
  }

  /**
   * 检查一组标识：重复（组内 + 库内）、格式合法性、时间戳顺序。
   * 不宣称不同生成器之间存在全局单调性。
   */
  check(inputs: string[]) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new ServiceError("INVALID_BATCH", "检查列表必须是非空字符串数组");
    }
    if (inputs.length > MAX_BATCH_SIZE) {
      throw new ServiceError("BATCH_TOO_LARGE", `单次检查上限为 ${MAX_BATCH_SIZE}`);
    }

    const items = inputs.map((raw, index) => {
      const canonical = normalizeULID(raw);
      let decoded: DecodedULID | null = null;
      let error: { code: string; message: string } | null = null;
      try {
        decoded = decodeULID(canonical);
      } catch (err) {
        if (err instanceof UlidError) error = { code: err.code, message: err.message };
        else throw err;
      }
      return { index, input: raw, canonical, decoded, error };
    });

    // 组内重复
    const seen = new Map<string, number>();
    const internalDuplicates: { index: number; firstIndex: number; ulid: string }[] = [];
    for (const item of items) {
      if (item.error) continue;
      const prev = seen.get(item.canonical);
      if (prev === undefined) seen.set(item.canonical, item.index);
      else internalDuplicates.push({ index: item.index, firstIndex: prev, ulid: item.canonical });
    }

    // 库内重复（跨历史记录）
    const validCanonicals = items.filter((i) => !i.error).map((i) => i.canonical);
    const known = findUlids(this.db, validCanonicals);
    const persistedDuplicates = validCanonicals.filter((u) => known.has(u));

    // 时间戳与字典序顺序检查（仅对合法项，按输入顺序）
    const order: {
      timestampsNonDecreasing: boolean;
      lexicographicallyStrictlyIncreasing: boolean;
      violations: { from: number; to: number; reason: string }[];
    } = {
      timestampsNonDecreasing: true,
      lexicographicallyStrictlyIncreasing: true,
      violations: [],
    };
    const valid = items.filter((i) => !i.error);
    for (let i = 1; i < valid.length; i++) {
      const a = valid[i - 1]!;
      const b = valid[i]!;
      if (b.decoded!.timestampMs < a.decoded!.timestampMs) {
        order.timestampsNonDecreasing = false;
        order.violations.push({
          from: a.index,
          to: b.index,
          reason: "时间戳倒退",
        });
      }
      if (b.canonical <= a.canonical) {
        order.lexicographicallyStrictlyIncreasing = false;
        order.violations.push({
          from: a.index,
          to: b.index,
          reason: b.canonical === a.canonical ? "字典序相等（重复）" : "字典序倒退",
        });
      }
    }

    return {
      count: inputs.length,
      validCount: valid.length,
      allValid: items.every((i) => !i.error),
      items: items.map((i) => ({
        index: i.index,
        input: i.input,
        canonical: i.canonical,
        valid: !i.error,
        error: i.error,
        decoded: i.decoded
          ? {
              timestampMs: i.decoded.timestampMs,
              timestampISO: i.decoded.timestampISO,
              random: i.decoded.random.toString(),
              randomHex: i.decoded.randomHex,
              timePart: i.decoded.timePart,
              randomPart: i.decoded.randomPart,
            }
          : null,
      })),
      internalDuplicates,
      persistedDuplicates,
      order,
    };
  }

  history(name: string, limit = 50, offset = 0) {
    validateName(name);
    this.getGenerator(name);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
      throw new ServiceError("INVALID_LIMIT", `limit 须为 1..${MAX_BATCH_SIZE} 的整数`);
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ServiceError("INVALID_OFFSET", "offset 须为 >= 0 的整数");
    }
    const rows = queryHistory(this.db, name, limit, offset);
    return {
      generator: name,
      total: countHistory(this.db, name),
      limit,
      offset,
      records: rows.map((r) => ({
        id: r.id,
        ulid: r.ulid,
        timestampMs: r.timestamp_ms,
        timestampISO: new Date(r.timestamp_ms).toISOString(),
        random: r.random,
        issuedAt: r.issued_at,
      })),
    };
  }

  /** 导出某生成器全部发放记录（按发放顺序升序） */
  export(name: string) {
    validateName(name);
    this.getGenerator(name);
    const rows = this.db
      .prepare(
        "SELECT id, ulid, timestamp_ms, random, issued_at FROM issues WHERE generator = ? ORDER BY id ASC",
      )
      .all(name) as {
      id: number;
      ulid: string;
      timestamp_ms: number;
      random: string;
      issued_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      generator: name,
      ulid: r.ulid,
      timestampMs: r.timestamp_ms,
      timestampISO: new Date(r.timestamp_ms).toISOString(),
      random: r.random,
      issuedAt: r.issued_at,
    }));
  }
}
