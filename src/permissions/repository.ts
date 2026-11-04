import { Pool } from 'pg';

import { Permission } from '../contracts';
import { ServiceMetrics } from './metrics';

/** Raised for any database failure so callers can answer with `database_unavailable`. */
export class DatabaseError extends Error {
  constructor(cause: unknown) {
    super('Database query failed', { cause });
    this.name = 'DatabaseError';
  }
}

export class PermissionsRepository {
  constructor(
    private readonly pool: Pool,
    private readonly metrics: ServiceMetrics,
  ) {}

  async grant(keyHash: string, { module, action }: Permission): Promise<void> {
    await this.query('grant', () =>
      this.pool.query(
        `INSERT INTO permissions (key_hash, module, action) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [keyHash, module, action],
      ),
    );
  }

  /** Returns whether a permission was actually removed. */
  async revoke(keyHash: string, { module, action }: Permission): Promise<boolean> {
    const result = await this.query('revoke', () =>
      this.pool.query(`DELETE FROM permissions WHERE key_hash = $1 AND module = $2 AND action = $3`, [
        keyHash,
        module,
        action,
      ]),
    );
    return (result.rowCount ?? 0) > 0;
  }

  async list(keyHash: string): Promise<Permission[]> {
    const result = await this.query('list', () =>
      this.pool.query<Permission>(
        `SELECT module, action FROM permissions WHERE key_hash = $1 ORDER BY module, action`,
        [keyHash],
      ),
    );
    return result.rows;
  }

  private async query<T>(operation: string, run: () => Promise<T>): Promise<T> {
    const stop = this.metrics.dbQueryDuration.startTimer({ operation });
    try {
      const result = await run();
      stop({ outcome: 'ok' });
      return result;
    } catch (error) {
      stop({ outcome: 'error' });
      throw new DatabaseError(error);
    }
  }
}
