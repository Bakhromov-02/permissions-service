import { Pool } from 'pg';

import { Permission } from '../contracts';

/** Raised for any database failure so callers can answer with `database_unavailable`. */
export class DatabaseError extends Error {
  constructor(cause: unknown) {
    super('Database query failed', { cause });
    this.name = 'DatabaseError';
  }
}

const query = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw new DatabaseError(error);
  }
};

export class PermissionsRepository {
  constructor(private readonly pool: Pool) {}

  async grant(keyHash: string, { module, action }: Permission): Promise<void> {
    await query(() =>
      this.pool.query(
        `INSERT INTO permissions (key_hash, module, action) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [keyHash, module, action],
      ),
    );
  }

  /** Returns whether a permission was actually removed. */
  async revoke(keyHash: string, { module, action }: Permission): Promise<boolean> {
    const result = await query(() =>
      this.pool.query(`DELETE FROM permissions WHERE key_hash = $1 AND module = $2 AND action = $3`, [
        keyHash,
        module,
        action,
      ]),
    );
    return (result.rowCount ?? 0) > 0;
  }

  async list(keyHash: string): Promise<Permission[]> {
    const result = await query(() =>
      this.pool.query<Permission>(
        `SELECT module, action FROM permissions WHERE key_hash = $1 ORDER BY module, action`,
        [keyHash],
      ),
    );
    return result.rows;
  }
}
