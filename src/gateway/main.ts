import 'dotenv/config';
import { stopTracing } from './instrumentation';
import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { loadGatewayConfig } from './config';

const bootstrap = async () => {
  const config = loadGatewayConfig();
  const app = configureApp(await NestFactory.create(AppModule.forRoot(config)));
  await app.listen(config.port);
  Logger.log(`Gateway listening on :${config.port} — docs at /docs`, 'Bootstrap');

  // enableShutdownHooks closes Nest (and drains NATS); flush pending spans after that.
  process.once('beforeExit', () => void stopTracing());
};

bootstrap().catch((error) => {
  Logger.error(`Startup failed: ${String(error)}`, 'Bootstrap');
  process.exit(1);
});
