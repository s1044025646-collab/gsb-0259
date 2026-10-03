import { ApiError } from './errors.js';
import { decodeUlid, type DecodedUlid } from './ulid.js';

export interface InspectResult {
  duplicates: string[];
  strictlyOrdered: boolean;
  items: Array<DecodedUlid & { index: number }>;
}

export function inspectUlids(values: unknown): InspectResult {
  if (!Array.isArray(values) || values.length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'ulids 必须是非空数组');
  }
  if (values.length > 500) {
    throw new ApiError('VALIDATION_ERROR', '一次最多检查 500 个 ULID');
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const items = values.map((value, index) => {
    if (typeof value !== 'string') {
      throw new ApiError('VALIDATION_ERROR', `第 ${index + 1} 项不是字符串`);
    }
    const decoded = decodeUlid(value);
    if (seen.has(decoded.ulid)) duplicates.add(decoded.ulid);
    seen.add(decoded.ulid);
    return { index, ...decoded };
  });

  let strictlyOrdered = duplicates.size === 0;
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1]!;
    const current = items[index]!;
    const previousValue = BigInt(previous.timestampMs) * (1n << 80n) + BigInt(previous.random);
    const currentValue = BigInt(current.timestampMs) * (1n << 80n) + BigInt(current.random);
    if (currentValue <= previousValue) {
      strictlyOrdered = false;
      break;
    }
  }

  return {
    duplicates: [...duplicates],
    strictlyOrdered,
    items
  };
}

export function explainStrictOrder(
  values: string[]
): { ordered: boolean; firstProblem?: { index: number; code: string; message: string } } {
  const result = inspectUlids(values);
  if (result.duplicates.length > 0) {
    return {
      ordered: false,
      firstProblem: {
        index: values.findIndex((value) => decodeUlid(value).ulid === result.duplicates[0]),
        code: 'DUPLICATE_ULID',
        message: `发现重复 ULID：${result.duplicates[0]}`
      }
    };
  }
  if (!result.strictlyOrdered) {
    return {
      ordered: false,
      firstProblem: {
        index: findFirstDecrease(result.items),
        code: 'SEQUENCE_DECREASED',
        message: '标识未按字典序严格递增'
      }
    };
  }
  return { ordered: true };
}

function findFirstDecrease(items: InspectResult['items']): number {
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1]!;
    const current = items[index]!;
    const previousValue = BigInt(previous.timestampMs) * (1n << 80n) + BigInt(previous.random);
    const currentValue = BigInt(current.timestampMs) * (1n << 80n) + BigInt(current.random);
    if (currentValue <= previousValue) return index;
  }
  return -1;
}
