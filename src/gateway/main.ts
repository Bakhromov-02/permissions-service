import 'reflect-metadata';
import 'dotenv/config';

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
};

bootstrap().catch((error) => {
  Logger.error(`Startup failed: ${String(error)}`, 'Bootstrap');
  process.exit(1);
});
