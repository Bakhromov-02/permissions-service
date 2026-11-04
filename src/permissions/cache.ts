import { KV } from 'nats';

import { Permission } from '../contracts';
import { keyId } from '../shared/hash';
import { Logger } from '../shared/logger';
import { ServiceMetrics } from './metrics';

/** Result of a cache read. `revision` identifies the entry that was seen, for a later `fill`. */
export type CacheLookup = { permissions: Permission[] | null; revision: number };

export interface PermissionCache {
  get(keyHash: string): Promise<CacheLookup>;
  /** Stores a list loaded after a miss — only if the entry hasn't changed since `lookup.revision`. */
  fill(keyHash: string, permissions: Permission[], revision: number): Promise<void>;
  invalidate(keyHash: string): Promise<void>;
}

/**
 * Cache-aside store for the permission list of one API key, in a NATS JetStream KV bucket.
 *
 * Writes invalidate the entry (a delete marker with a new revision). Reads that miss load from
 * PostgreSQL and fill the entry with a compare-and-set on the revision they saw, so a read that raced
 * with a grant/revoke can never put a stale list back into the cache.
 * See docs/incidents/2026-11-04-stale-cache-after-revoke.md
 *
 * Cache errors never fail a request: the service falls back to the database.
 */
export class KvPermissionCache implements PermissionCache {
  constructor(
    private readonly kv: KV,
    private readonly logger: Logger,
    private readonly metrics: ServiceMetrics,
  ) {}

  async get(keyHash: string): Promise<CacheLookup> {
    try {
      const entry = await this.kv.get(keyHash);
      // Deleted keys come back as entries with a DEL/PURGE operation; their revision still matters.
      const value = entry && entry.operation === 'PUT' && entry.length > 0 ? entry.json<unknown>() : null;
      const permissions = Array.isArray(value) ? (value as Permission[]) : null;
      this.metrics.cacheLookups.inc({ result: permissions ? 'hit' : 'miss' });
      return { permissions, revision: entry?.revision ?? 0 };
    } catch (error) {
      this.metrics.cacheLookups.inc({ result: 'error' });
      this.logger.warn('cache_read_failed', { key: keyId(keyHash), error: String(error) });
      return { permissions: null, revision: -1 };
    }
  }

  async fill(keyHash: string, permissions: Permission[], revision: number): Promise<void> {
    if (revision < 0) return; // the read failed; don't try to write either
    try {
      // Compare-and-set: the server rejects the write if the key's last revision is no longer `revision`.
      // revision 0 means "the key had no entry at all" (kv.update() refuses 0, so use put + previousSeq).
      await this.kv.put(keyHash, JSON.stringify(permissions), { previousSeq: revision });
    } catch (error) {
      if (isWrongRevision(error)) {
        // A grant/revoke invalidated the key while we were reading PostgreSQL: our list may be stale.
        this.metrics.cacheFillConflicts.inc();
        return;
      }
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

const isWrongRevision = (error: unknown) =>
  error instanceof Error && /wrong last sequence/i.test(error.message);

/** Used when CACHE_ENABLED=false: every read goes to PostgreSQL. */
export class DisabledPermissionCache implements PermissionCache {
  constructor(private readonly metrics: ServiceMetrics) {}

  async get(): Promise<CacheLookup> {
    this.metrics.cacheLookups.inc({ result: 'miss' });
    return { permissions: null, revision: -1 };
  }

  async fill(): Promise<void> {}

  async invalidate(): Promise<void> {}
}
