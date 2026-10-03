import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UlidStore } from './store.js';
import { decodeUlid } from './ulid.js';

const directory = mkdtempSync(join(tmpdir(), 'monotonic-ulid-'));
const databasePath = join(directory, 'demo.sqlite');

try {
  let currentTime = 1_764_859_200_123n;
  let nextRandom = 0x010203040506070809n;
  const clock = () => currentTime;
  const random = () => {
    const value = nextRandom;
    nextRandom += 0x100000000n;
    return unsigned10Bytes(value);
  };

  let store = new UlidStore(databasePath);
  store.createGenerator('orders');

  console.log('固定毫秒连续生成：');
  const first = store.issue('orders', clock, random, { count: 3 });
  for (const record of first) console.log(formatRecord(record));

  currentTime -= 5n;
  console.log('\n时钟向后跳 5 毫秒后继续生成：');
  const afterRollback = store.issue('orders', clock, random, { count: 2 });
  for (const record of afterRollback) console.log(formatRecord(record));

  currentTime += 10n;
  console.log('\n时间前进后使用新随机量：');
  const afterAdvance = store.issue('orders', clock, random, { count: 1 });
  console.log(formatRecord(afterAdvance[0]!));
  store.close();

  store = new UlidStore(databasePath);
  console.log('\n重启后读取状态并继续：');
  console.log(JSON.stringify(store.getGenerator('orders'), null, 2));
  const afterRestart = store.issue('orders', clock, random, { count: 1 });
  console.log(formatRecord(afterRestart[0]!));
  console.log('\n解码最后一条：');
  console.log(JSON.stringify(decodeUlid(afterRestart[0]!.ulid), null, 2));
  store.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

function unsigned10Bytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(10);
  let remaining = value;
  for (let index = 9; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function formatRecord(record: {
  ulid: string;
  timestampMs: string;
  random: string;
  randomSource: string;
  retainedTimestamp: boolean;
}): string {
  return `${record.ulid}  ts=${record.timestampMs} random=${record.random} ${
    record.retainedTimestamp ? '保留时间戳并随机量+1' : record.randomSource
  }`;
}
