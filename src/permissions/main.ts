import 'dotenv/config';

import { createLogger } from '../shared/logger';
import { loadPermissionsConfig } from './config';
import { startPermissionsService } from './service';

const logger = createLogger('permissions');

const main = async () => {
  const service = await startPermissionsService(loadPermissionsConfig(), logger);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('shutdown', { signal });
    await service.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
};

main().catch((error) => {
  logger.error('startup_failed', { error: String(error) });
  process.exit(1);
});
