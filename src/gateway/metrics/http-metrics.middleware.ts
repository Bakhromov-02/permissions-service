import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import { GATEWAY_METRICS, GatewayMetrics } from './gateway-metrics';

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(@Inject(GATEWAY_METRICS) private readonly metrics: GatewayMetrics) {}

  use(req: Request, res: Response, next: NextFunction) {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      // Label by route *pattern*, never the raw URL, so label cardinality stays bounded.
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      if (route === '/metrics') return;

      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.metrics.httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
      this.metrics.httpDuration.observe({ method: req.method, route }, seconds);
    });

    next();
  }
}
