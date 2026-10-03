import { ApiError } from './errors.js';

export const ULID_LENGTH = 26;
export const TIMESTAMP_LENGTH = 10;
export const RANDOM_LENGTH = 16;
export const TIMESTAMP_BITS = 48n;
export const RANDOM_BITS = 80n;
export const TOTAL_BITS = 128n;
export const MAX_TIMESTAMP = (1n << TIMESTAMP_BITS) - 1n;
export const MAX_RANDOM = (1n << RANDOM_BITS) - 1n;
export const MAX_ULID = (1n << TOTAL_BITS) - 1n;
export const MAX_BATCH_SIZE = 100;

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DECODE_VALUES = new Map<string, bigint>();

for (let index = 0; index < ALPHABET.length; index += 1) {
  const character = ALPHABET[index]!;
  const value = BigInt(index);
  DECODE_VALUES.set(character, value);
  DECODE_VALUES.set(character.toLowerCase(), value);
}

export type Clock = () => bigint;
export type RandomBytes = (length: number) => Uint8Array;

export interface MonotonicState {
  timestamp: bigint;
  random: bigint;
}

export interface IssuedParts extends MonotonicState {
  ulid: string;
  randomSource: 'new' | 'incremented';
  retainedTimestamp: boolean;
}

export interface DecodedUlid {
  ulid: string;
  timestampMs: string;
  random: string;
  utcTime: string;
  bytes: string;
}

export function systemClock(): Clock {
  return () => BigInt(Date.now());
}

export function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function encodeBase32(value: bigint, length: number): string {
  if (value < 0n) throw new ApiError('VALIDATION_ERROR', '不能编码负整数');
  const characters: string[] = new Array(length);
  let remaining = value;
  for (let position = length - 1; position >= 0; position -= 1) {
    characters[position] = ALPHABET[Number(remaining % 32n)]!;
    remaining /= 32n;
  }
  if (remaining !== 0n) {
    throw new ApiError('VALIDATION_ERROR', `数值超出 ${length} 个 Base32 字符容量`);
  }
  return characters.join('');
}

export function decodeBase32(text: string, fieldName: string): bigint {
  let value = 0n;
  for (const character of text) {
    const digit = DECODE_VALUES.get(character);
    if (digit === undefined) {
      throw new ApiError('INVALID_ULID', `${fieldName}包含非法 Crockford Base32 字符：${character}`);
    }
    value = value * 32n + digit;
  }
  return value;
}

export function timestampToBytes(value: bigint): Uint8Array {
  return unsignedToBytes(value, 6);
}

export function randomToBytes(value: bigint): Uint8Array {
  return unsignedToBytes(value, 10);
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

export function unsignedToBytes(value: bigint, length: number): Uint8Array {
  if (value < 0n) throw new ApiError('VALIDATION_ERROR', '不能将负数写入字节数组');
  const bytes = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new ApiError('VALIDATION_ERROR', '数值超出指定字节长度');
  return bytes;
}

export function encodeUlid(timestamp: bigint, random: bigint): string {
  validateTimestamp(timestamp);
  validateRandom(random);
  return encodeBase32(timestamp, TIMESTAMP_LENGTH) + encodeBase32(random, RANDOM_LENGTH);
}

export function decodeUlid(input: string): DecodedUlid {
  if (typeof input !== 'string' || input.length !== ULID_LENGTH) {
    throw new ApiError('INVALID_ULID', `ULID 必须恰好为 ${ULID_LENGTH} 个字符`);
  }
  if (!DECODE_VALUES.has(input[0]!)) {
    throw new ApiError('INVALID_ULID', 'ULID 首字符非法');
  }
  if (DECODE_VALUES.get(input[0]!)! > 7n) {
    throw new ApiError('INVALID_ULID', 'ULID 首字符不能大于 7，否则数值超过 128 位上界');
  }

  const timestampText = input.slice(0, TIMESTAMP_LENGTH);
  const randomText = input.slice(TIMESTAMP_LENGTH);
  const timestamp = decodeBase32(timestampText, '时间戳部分');
  const random = decodeBase32(randomText, '随机部分');
  validateTimestamp(timestamp);
  validateRandom(random);

  const timestampBytes = timestampToBytes(timestamp);
  const randomBytes = randomToBytes(random);
  const joinedBytes = new Uint8Array(timestampBytes.length + randomBytes.length);
  joinedBytes.set(timestampBytes, 0);
  joinedBytes.set(randomBytes, timestampBytes.length);

  let perCharacterValue = 0n;
  for (const character of input) {
    const digit = DECODE_VALUES.get(character);
    if (digit === undefined) throw new ApiError('INVALID_ULID', `非法字符：${character}`);
    perCharacterValue = perCharacterValue * 32n + digit;
  }
  if (bytesToBigInt(joinedBytes) !== perCharacterValue) {
    throw new ApiError('INVALID_ULID', '独立字节拼接与逐字符解码结果不一致');
  }

  const canonical = encodeUlid(timestamp, random);
  return {
    ulid: canonical,
    timestampMs: timestamp.toString(),
    random: random.toString(),
    utcTime: new Date(Number(timestamp)).toISOString(),
    bytes: Buffer.from(joinedBytes).toString('hex')
  };
}

export function validateTimestamp(timestamp: bigint): void {
  if (timestamp < 0n || timestamp > MAX_TIMESTAMP) {
    throw new ApiError('CLOCK_INVALID', '毫秒时间戳必须位于无符号 48 位范围内');
  }
}

export function validateRandom(random: bigint): void {
  if (random < 0n || random > MAX_RANDOM) {
    throw new ApiError('VALIDATION_ERROR', '随机量必须位于无符号 80 位范围内');
  }
}

export function nextMonotonic(
  now: bigint,
  randomBytesInput: Uint8Array,
  previous: MonotonicState | null
): IssuedParts {
  validateTimestamp(now);
  if (randomBytesInput.length !== 10) {
    throw new ApiError('VALIDATION_ERROR', '随机源必须恰好返回 10 个字节');
  }
  const freshRandom = bytesToBigInt(randomBytesInput);
  validateRandom(freshRandom);

  if (previous === null || now > previous.timestamp) {
    return {
      timestamp: now,
      random: freshRandom,
      ulid: encodeUlid(now, freshRandom),
      randomSource: 'new',
      retainedTimestamp: false
    };
  }

  if (previous.random >= MAX_RANDOM) {
    throw new ApiError(
      'RANDOM_OVERFLOW',
      '同一保留毫秒内 80 位随机量已达最大值；本次生成被拒绝，不会回绕或等待'
    );
  }

  const random = previous.random + 1n;
  return {
    timestamp: previous.timestamp,
    random,
    ulid: encodeUlid(previous.timestamp, random),
    randomSource: 'incremented',
    retainedTimestamp: true
  };
}

export function compareBigInt(left: bigint, right: bigint): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}
