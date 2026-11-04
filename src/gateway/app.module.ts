import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { TokenGuard } from './auth/token.guard';
import { GATEWAY_CONFIG, GatewayConfig } from './config';
import { HealthController } from './health/health.controller';
import { PermissionsClient } from './nats/permissions.client';
import { PermissionsController } from './permissions/permissions.controller';

@Module({})
export class AppModule {
  static forRoot(config: GatewayConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [PermissionsController, HealthController],
      providers: [
        { provide: GATEWAY_CONFIG, useValue: config },
        PermissionsClient,
        { provide: APP_GUARD, useClass: TokenGuard },
      ],
    };
  }
}
