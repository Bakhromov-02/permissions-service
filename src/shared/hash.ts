import { createHash } from 'crypto';

/**
 * API keys are never stored or cached in plain text: the database and the NATS KV cache only see this
 * SHA-256 hash. It is also always a valid KV key (raw API keys may contain characters KV rejects).
 */
export const hashApiKey = (apiKey: string): string => createHash('sha256').update(apiKey).digest('hex');

/** Short, non-reversible identifier that is safe to put in logs. */
export const keyId = (keyHash: string): string => keyHash.slice(0, 12);
