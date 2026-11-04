export enum ErrorCode {
  /** The request did not match the contract (bad JSON, missing or invalid fields). */
  InvalidPayload = 'invalid_payload',
  /** The database could not be reached or the query failed. */
  DatabaseUnavailable = 'database_unavailable',
  /** Anything unexpected. Details are logged by the service, not returned. */
  Internal = 'internal',
}

export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export const isErrorResponse = (value: unknown): value is ErrorResponse =>
  typeof value === 'object' && value !== null && 'error' in value;
