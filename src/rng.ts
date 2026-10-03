import { randomBytes } from "node:crypto";
import { MAX_RANDOM } from "./ulid.ts";

export type RandomSource = () => bigint;

/** 默认安全随机源：crypto.randomBytes 取 10 字节（80 位） */
export const secureRandom80: RandomSource = () => {
  const bytes = randomBytes(10);
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  return value & MAX_RANDOM;
};

export type Clock = () => number;

/** 默认时钟：本机 UTC 毫秒 */
export const systemClock: Clock = () => Date.now();
