import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Response } from 'express';
import { Registry } from 'prom-client';

import { METRICS_REGISTRY } from './gateway-metrics';

/** Prometheus scrape endpoint. Expose it only on the internal network in production. */
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly registry: Registry) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async metrics(@Res() res: Response) {
    res.type(this.registry.contentType).send(await this.registry.metrics());
  }
}
