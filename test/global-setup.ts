import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

declare global {
  var __TEST_CONTAINERS__: (StartedPostgreSqlContainer | StartedTestContainer)[] | undefined;
}

/** Starts real PostgreSQL and NATS (JetStream enabled) containers once for the whole run. Requires Docker. */
export default async function globalSetup() {
  const [postgres, nats] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new GenericContainer('nats:2.10-alpine')
      .withCommand(['-js'])
      .withExposedPorts(4222)
      .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
      .start(),
  ]);

  // Test workers start after this and inherit these variables.
  process.env.NODE_ENV = 'test';
  process.env.TEST_DATABASE_URL = postgres.getConnectionUri();
  process.env.TEST_NATS_URL = `nats://${nats.getHost()}:${nats.getMappedPort(4222)}`;

  globalThis.__TEST_CONTAINERS__ = [postgres, nats];
}
