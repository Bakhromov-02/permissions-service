import { Pool } from 'pg';

/** Append-only list; each migration runs once, in order. */
const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_create_permissions',
    sql: `
      CREATE TABLE permissions (
        key_hash   CHAR(64)    NOT NULL,
        module     TEXT        NOT NULL,
        action     TEXT        NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (key_hash, module, action)
      );
    `,
  },
];

/**
 * Applies pending migrations inside one transaction. The advisory lock makes concurrent replicas
 * starting at the same time wait for each other instead of racing.
 */
export const runMigrations = async (pool: Pool): Promise<string[]> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('permissions-service:migrations'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.id));
    const ran: string[] = [];

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
      ran.push(migration.id);
    }

    await client.query('COMMIT');
    return ran;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
