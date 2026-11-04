import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { PermissionsClient } from '../nats/permissions.client';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly permissions: PermissionsClient) {}

  @Get()
  @ApiOperation({ summary: 'Gateway, NATS and permissions-service health' })
  async health() {
    const status = {
      nats: this.permissions.isConnected ? 'up' : 'down',
      permissionsService: (await this.permissions.ping()) ? 'up' : 'down',
    };
    if (status.nats === 'down' || status.permissionsService === 'down') {
      throw new ServiceUnavailableException({ status: 'degraded', ...status });
    }
    return { status: 'ok', ...status };
  }
}
