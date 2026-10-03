/**
 * ULID 核心：48 位毫秒时间戳 + 80 位随机量，Crockford Base32 编码。
 * 全部按位字段自行实现，不使用任何现成 ULID 包。
 *
 * 布局：时间戳 10 个字符（48 位），随机量 16 个字符（80 位），共 26 字符。
 */

export const ULID_LENGTH = 26;
export const TIMESTAMP_PART_LENGTH = 10;
export const RANDOM_PART_LENGTH = 16;

/** 48 位时间戳最大值：2^48 - 1（毫秒，约公元 10889 年） */
export const MAX_TIMESTAMP_MS = (1n << 48n) - 1n;
/** 80 位随机量最大值：2^80 - 1 */
export const MAX_RANDOM = (1n << 80n) - 1n;

const ENCODE = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 解码表：-1=非法，-2=合法但在 ULID 中被排除（I/L/O/U） */
const DECODE = new Int8Array(256).fill(-1);
{
  for (let i = 0; i < ENCODE.length; i++) DECODE[ENCODE.charCodeAt(i)] = i;
  // Crockford 宽松解码中 I=L=1, O=0；本服务仅做严格字母表校验，不做宽松映射。
  for (const c of "ILOU") DECODE[c.charCodeAt(0)] = -2;
}

export type DecodedULID = {
  ulid: string;
  timestampMs: number;
  timestampISO: string;
  random: bigint;
  randomHex: string;
  timePart: string;
  randomPart: string;
};

/** 将一个值按指定位数（5 的倍数）编码为 Crockford Base32，高位在前 */
function encodeBase32(value: bigint, chars: number): string {
  let out = "";
  for (let i = chars - 1; i >= 0; i--) {
    const idx = Number((value >> BigInt(i * 5)) & 31n);
    out += ENCODE[idx]!;
  }
  return out;
}

/** 逐字符解码，-1 / -2 会抛出对应错误 */
function decodeBase32(text: string, errorPrefix: string): bigint {
  let value = 0n;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const v = code < 256 ? DECODE[code] : -1;
    if (v === -1) {
      throw new UlidError(
        "INVALID_CHARSET",
        `${errorPrefix}含非法字符 "${text[i]}"（仅允许 Crockford Base32：0-9A-Z，排除 I/L/O/U）`,
      );
    }
    if (v === -2) {
      throw new UlidError(
        "INVALID_CHARSET",
        `${errorPrefix}含被排除字符 "${text[i]}"（I/L/O/U 不属于 ULID 字母表）`,
      );
    }
    value = (value << 5n) | BigInt(v);
  }
  return value;
}

export class UlidError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UlidError";
    this.code = code;
  }
}

/**
 * 由时间戳与随机量编码出标准大写 ULID。
 * @param timestampMs 毫秒时间戳（0 .. 2^48-1）
 * @param random 80 位随机量（0 .. 2^80-1）
 */
export function encodeULID(timestampMs: number | bigint, random: bigint): string {
    const ts = BigInt(timestampMs);
    if (ts < 0n) throw new UlidError("TIMESTAMP_NEGATIVE", "时间戳不能为负");
    if (ts > MAX_TIMESTAMP_MS) {
      throw new UlidError("TIMESTAMP_OVERFLOW", "时间戳超过 48 位上界 2^48-1");
    }
    if (random < 0n) throw new UlidError("RANDOM_NEGATIVE", "随机量不能为负");
    if (random > MAX_RANDOM) {
      throw new UlidError("RANDOM_OVERFLOW", "随机量超过 80 位上界 2^80-1");
    }
    return encodeBase32(ts, TIMESTAMP_PART_LENGTH) + encodeBase32(random, RANDOM_PART_LENGTH);
  }

/**
 * 解码并严格校验 ULID：
 * - 必须恰好 26 字符
 * - 仅允许大写 Crockford 字母表（小写会被拒绝，调用 normalizeULID 先行规范化）
 * - 128 位上界：首字符必须 <= 7
 */
export function decodeULID(input: string): DecodedULID {
  if (typeof input !== "string") {
    throw new UlidError("INVALID_TYPE", "ULID 必须是字符串");
  }
  if (input.length !== ULID_LENGTH) {
    throw new UlidError(
      "INVALID_LENGTH",
      `ULID 长度必须为 ${ULID_LENGTH}，实际为 ${input.length}`,
    );
  }
  if (/[a-z]/.test(input)) {
    throw new UlidError(
      "NOT_CANONICAL",
      "ULID 必须为规范大写形式，请先做大小写规范化",
    );
  }

  const timePart = input.slice(0, TIMESTAMP_PART_LENGTH);
  const randomPart = input.slice(TIMESTAMP_PART_LENGTH);

  // 128 位上界：第 0 个字符承载最高 5 位，整个标识为 128 位时该字符 <= 7。
  const head = DECODE[input.charCodeAt(0)];
  if (head === -1 || head === -2) {
    // 交由逐字符解码产出精确错误
    decodeBase32(timePart, "时间戳部分");
  }
  if (head > 7) {
    throw new UlidError(
      "OVERFLOW_128BIT",
      `首字符 "${input[0]}" 超过 7，数值超出 128 位上界`,
    );
  }

  const ts = decodeBase32(timePart, "时间戳部分");
  const random = decodeBase32(randomPart, "随机部分");

  const timestampMs = Number(ts);
  return {
    ulid: input,
    timestampMs,
    timestampISO: new Date(timestampMs).toISOString(),
    random,
    randomHex: random.toString(16).toUpperCase().padStart(20, "0"),
    timePart,
    randomPart,
  };
}

/** 大小写规范化：仅允许小写形式的合法字母转大写（toUpperCase），其余原样交给严格校验 */
export function normalizeULID(input: string): string {
  if (typeof input !== "string") return input;
  return input.toUpperCase();
}

/**
 * 独立的逐字节实现，仅用于测试中交叉核对位字段：
 * 把时间戳和随机量拼成 16 字节，再每 5 位切片重新编码。
 */
export function encodeULIDViaBytes(timestampMs: number | bigint, random: bigint): string {
  const ts = BigInt(timestampMs);
  const whole = (ts << 80n) | random;
  let bits = whole;
  const chars: string[] = new Array(ULID_LENGTH);
  for (let i = ULID_LENGTH - 1; i >= 0; i--) {
    chars[i] = ENCODE[Number(bits & 31n)]!;
    bits >>= 5n;
  }
  return chars.join("");
}

/** 与 decodeULID 独立的逐字符 5 位重组实现，仅用于测试交叉验证 */
export function decodeULIDCharByChar(input: string): { timestampMs: number; random: bigint } {
  let bits = 0n;
  for (const ch of input) {
    const idx = ENCODE.indexOf(ch);
    if (idx < 0) throw new Error(`交叉解码遇到非法字符 ${ch}`);
    bits = (bits << 5n) | BigInt(idx);
  }
  return { timestampMs: Number(bits >> 80n), random: bits & MAX_RANDOM };
}

export const CROCKFORD_ALPHABET = ENCODE;
