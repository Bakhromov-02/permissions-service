import { KV } from 'nats';

import { Permission } from '../contracts';
import { keyId } from '../shared/hash';
import { Logger } from '../shared/logger';

/**
 * Cache-aside store for the permission list of one API key, in a NATS JetStream KV bucket.
 * Every entry has the same shape (the full list), and writes invalidate the entry instead of
 * rewriting it. Cache errors never fail a request: the service falls back to the database.
 */
export class PermissionCache {
  constructor(
    private readonly kv: KV,
    private readonly logger: Logger,
  ) {}

  async get(keyHash: string): Promise<Permission[] | null> {
    try {
      const entry = await this.kv.get(keyHash);
      // Deleted/purged keys come back as entries with an empty value.
      if (!entry || entry.operation !== 'PUT' || entry.length === 0) return null;
      const value = entry.json<unknown>();
      return Array.isArray(value) ? (value as Permission[]) : null;
    } catch (error) {
      this.logger.warn('cache_read_failed', { key: keyId(keyHash), error: String(error) });
      return null;
    }
  }

  async set(keyHash: string, permissions: Permission[]): Promise<void> {
    try {
      await this.kv.put(keyHash, JSON.stringify(permissions));
    } catch (error) {
      this.logger.warn('cache_write_failed', { key: keyId(keyHash), error: String(error) });
    }
  }

  async invalidate(keyHash: string): Promise<void> {
    try {
      await this.kv.delete(keyHash);
    } catch (error) {
      // Bounded by the bucket TTL, so a missed invalidation can only serve stale data briefly.
      this.logger.warn('cache_invalidate_failed', { key: keyId(keyHash), error: String(error) });
    }
  }
}
