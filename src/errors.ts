export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_ULID'
  | 'RANDOM_OVERFLOW'
  | 'CLOCK_INVALID'
  | 'BATCH_TOO_LARGE'
  | 'SEQUENCE_GAP'
  | 'SEQUENCE_DECREASED'
  | 'DUPLICATE_ULID'
  | 'MIXED_GENERATORS'
  | 'DATABASE_BUSY'
  | 'INTERNAL_ERROR';

export function errorBody(error: ApiError) {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details })
    }
  };
}
