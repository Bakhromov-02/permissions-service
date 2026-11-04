import { DynamicModule, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Registry } from 'prom-client';

import { TokenGuard } from './auth/token.guard';
import { GATEWAY_CONFIG, GatewayConfig } from './config';
import { HealthController } from './health/health.controller';
import {
  createGatewayMetrics,
  createGatewayRegistry,
  GATEWAY_METRICS,
  METRICS_REGISTRY,
} from './metrics/gateway-metrics';
import { HttpMetricsMiddleware } from './metrics/http-metrics.middleware';
import { MetricsController } from './metrics/metrics.controller';
import { PermissionsClient } from './nats/permissions.client';
import { PermissionsController } from './permissions/permissions.controller';

@Module({})
export class AppModule implements NestModule {
  static forRoot(config: GatewayConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [PermissionsController, HealthController, MetricsController],
      providers: [
        { provide: GATEWAY_CONFIG, useValue: config },
        // A registry per app instance, so tests can boot several gateways in one process.
        { provide: METRICS_REGISTRY, useFactory: createGatewayRegistry },
        {
          provide: GATEWAY_METRICS,
          inject: [METRICS_REGISTRY],
          useFactory: (registry: Registry) => createGatewayMetrics(registry),
        },
        PermissionsClient,
        HttpMetricsMiddleware,
        { provide: APP_GUARD, useClass: TokenGuard },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(HttpMetricsMiddleware).forRoutes('{*splat}');
  }
}
