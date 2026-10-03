import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ApiError } from '../src/errors.js';
import { inspectUlids } from '../src/inspect.js';
import { UlidStore } from '../src/store.js';
import {
  MAX_RANDOM,
  MAX_TIMESTAMP,
  encodeBase32,
  encodeUlid,
  decodeBase32,
  decodeUlid,
  nextMonotonic,
  randomToBytes,
  timestampToBytes,
  bytesToBigInt
} from '../src/ulid.js';

function tempDatabase(): { path: string; cleanup: () => void } {
  const parent = join(process.cwd(), '.test-tmp', `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(parent, { recursive: true });
  return {
    path: join(parent, 'test.sqlite'),
    cleanup: () => undefined
  };
}

function fixedRandom(value: bigint): () => Uint8Array {
  return () => randomToBytes(value);
}

test('已知编码向量、零值和最大时间戳', () => {
  assert.equal(encodeBase32(0n, 10), '0000000000');
  assert.equal(encodeBase32(0n, 16), '0000000000000000');
  assert.equal(encodeUlid(0n, 0n), '00000000000000000000000000');
  assert.equal(
    encodeUlid(MAX_TIMESTAMP, 0n),
    '7ZZZZZZZZZ0000000000000000'
  );
  assert.equal(
    encodeUlid(1n, 1n),
    '00000000010000000000000001'
  );
  assert.equal(decodeBase32('7ZZZZZZZZZ', 'ts'), MAX_TIMESTAMP);
});

test('解码规范化大小写并展示 UTC、毫秒和字节字段', () => {
  const lower = '0123456789abcdefghjkmnpqrs';
  const upper = '0123456789ABCDEFGHJKMNPQRS';
  const decoded = decodeUlid(lower);
  assert.equal(decoded.ulid, upper);
  assert.match(decoded.utcTime, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  const bytes = Buffer.from(decoded.bytes, 'hex');
  assert.equal(bytes.length, 16);
  assert.equal(bytesToBigInt(bytes.subarray(0, 6)), BigInt(decoded.timestampMs));
  assert.equal(bytesToBigInt(bytes.subarray(6)), BigInt(decoded.random));
});

test('逐字符解码与独立字节拼接一致', () => {
  const value = encodeUlid(123_456_789n, 0x123456789abcdef0123n);
  const decoded = decodeUlid(value);
  const rejoined = new Uint8Array([
    ...timestampToBytes(BigInt(decoded.timestampMs)),
    ...randomToBytes(BigInt(decoded.random))
  ]);
  assert.equal(Buffer.from(rejoined).toString('hex'), decoded.bytes);
});

test('同毫秒递增、时间回退保留时间戳，前进后刷新随机量', () => {
  let now = 1000n;
  const first = nextMonotonic(now, fixedRandom(100n)(), null);
  const second = nextMonotonic(now, fixedRandom(999n)(), first);
  const rolledBack = nextMonotonic(999n, fixedRandom(999n)(), second);
  const advanced = nextMonotonic(1001n, fixedRandom(7n)(), rolledBack);

  assert.equal(second.random, 101n);
  assert.equal(second.timestamp, 1000n);
  assert.equal(rolledBack.random, 102n);
  assert.equal(rolledBack.timestamp, 1000n);
  assert.equal(advanced.timestamp, 1001n);
  assert.equal(advanced.random, 7n);
  assert.ok(first.ulid < second.ulid);
  assert.ok(second.ulid < rolledBack.ulid);
  assert.ok(rolledBack.ulid < advanced.ulid);
});

test('随机部分进位且达到最大值时拒绝而不回绕', () => {
  const previous = { timestamp: 1n, random: MAX_RANDOM - 1n };
  const incremented = nextMonotonic(1n, fixedRandom(0n)(), previous);
  assert.equal(incremented.random, MAX_RANDOM);
  assert.throws(
    () => nextMonotonic(1n, fixedRandom(0n)(), { timestamp: 1n, random: MAX_RANDOM }),
    (error: unknown) => error instanceof ApiError && error.code === 'RANDOM_OVERFLOW'
  );
});

test('拒绝非法字符、错误长度和 128 位溢出', () => {
  assert.throws(() => decodeUlid('0000000000000000000000000'), /26/);
  assert.throws(
    () => decodeUlid('0000000000000000000000000U'),
    (error: unknown) => error instanceof ApiError && error.code === 'INVALID_ULID'
  );
  assert.throws(
    () => decodeUlid('80000000000000000000000000'),
    (error: unknown) => error instanceof ApiError && error.code === 'INVALID_ULID'
  );
});

test('检查重复和顺序', () => {
  const first = encodeUlid(10n, 1n);
  const duplicate = first.toLowerCase();
  const greater = encodeUlid(10n, 2n);
  const smaller = encodeUlid(9n, MAX_RANDOM);
  assert.equal(inspectUlids([first, duplicate]).duplicates.length, 1);
  assert.equal(inspectUlids([first, greater]).strictlyOrdered, true);
  assert.equal(inspectUlids([greater, smaller]).strictlyOrdered, false);
});

test('批次超限抛错并整体回滚，重启后继续递增', () => {
  const database = tempDatabase();
  try {
    let store = new UlidStore(database.path);
    store.createGenerator('batch');
    const initial = store.issue('batch', () => 5n, fixedRandom(MAX_RANDOM - 2n), { count: 2 });
    assert.equal(initial.length, 2);
    assert.throws(() =>
      store.issue(
        'batch',
        () => 5n,
        fixedRandom(0n),
        { count: 2 }
      )
    );
    const generator = store.getGenerator('batch');
    assert.equal(generator.issuedCount, 2);
    assert.equal(generator.lastRandom, (MAX_RANDOM - 1n).toString());
    store.close();

    store = new UlidStore(database.path);
    const afterRestart = store.issue('batch', () => 5n, fixedRandom(999n), { count: 1 });
    assert.equal(afterRestart[0]!.random, MAX_RANDOM.toString());
    store.close();
  } finally {
    database.cleanup();
  }
});

test('两个数据库连接并发发放仍唯一且持久化状态正确', async () => {
  const database = tempDatabase();
  try {
    const first = new UlidStore(database.path);
    const second = new UlidStore(database.path);
    first.createGenerator('concurrent');

    let now = 1000n;
    const task = (store: UlidStore) =>
      Promise.all([
        Promise.resolve().then(() => store.issue('concurrent', () => now, () => randomToBytes(0n), { count: 50 })),
        Promise.resolve().then(() => store.issue('concurrent', () => now, () => randomToBytes(0n), { count: 50 }))
      ]);
    const results = await Promise.all([task(first), task(second)]);
    const values = results.flat(2).map((record) => record.ulid);
    assert.equal(new Set(values).size, 200);
    assert.equal(values.length, 200);
    assert.deepEqual([...new Set(values)].sort(), [...values].sort());
    first.close();
    second.close();

    const sqlite = new DatabaseSync(database.path);
    const count = sqlite.prepare('SELECT COUNT(*) AS total FROM issued_ulids').get() as { total: number };
    const state = sqlite
      .prepare('SELECT timestamp_ms, random_value FROM generator_state WHERE generator_name = ?')
      .get('concurrent') as { timestamp_ms: string; random_value: string };
    assert.equal(count.total, 200);
    assert.equal(state.timestamp_ms, '1000');
    assert.equal(state.random_value, '199');
    sqlite.close();
  } finally {
    database.cleanup();
  }
});

test('不同生成器拥有独立单调状态', () => {
  const database = tempDatabase();
  try {
    const store = new UlidStore(database.path);
    store.createGenerator('a');
    store.createGenerator('b');
    const a = store.issue('a', () => 1n, fixedRandom(1n), { count: 2 });
    const b = store.issue('b', () => 1n, fixedRandom(1n), { count: 2 });
    assert.deepEqual(a.map((item) => item.ulid), b.map((item) => item.ulid));
    store.close();
  } finally {
    database.cleanup();
  }
});
