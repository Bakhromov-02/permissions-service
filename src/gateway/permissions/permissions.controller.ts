import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequireToken } from '../auth/token.guard';
import { PermissionsClient } from '../nats/permissions.client';
import {
  ApiKeyDto,
  CheckResponseDto,
  ListResponseDto,
  PermissionRequestDto,
  RevokeResponseDto,
  StatusResponseDto,
} from './permissions.dto';

/**
 * All operations take the API key in the JSON body (never in the URL), so keys don't end up in
 * access logs, proxies or browser history.
 */
@ApiTags('permissions')
@ApiBearerAuth()
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permissions: PermissionsClient) {}

  @Post('grant')
  @HttpCode(HttpStatus.OK)
  @RequireToken('admin')
  @ApiOperation({ summary: 'Grant a permission to an API key (idempotent)' })
  @ApiOkResponse({ type: StatusResponseDto })
  grant(@Body() dto: PermissionRequestDto) {
    return this.permissions.grant(dto);
  }

  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  @RequireToken('admin')
  @ApiOperation({ summary: 'Revoke a permission from an API key' })
  @ApiOkResponse({ type: RevokeResponseDto })
  revoke(@Body() dto: PermissionRequestDto) {
    return this.permissions.revoke(dto);
  }

  @Post('list')
  @HttpCode(HttpStatus.OK)
  @RequireToken('admin')
  @ApiOperation({ summary: 'List the permissions of an API key' })
  @ApiOkResponse({ type: ListResponseDto })
  list(@Body() dto: ApiKeyDto) {
    return this.permissions.list(dto);
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @RequireToken('service')
  @ApiOperation({ summary: 'Check whether an API key may perform an action (service or admin token)' })
  @ApiOkResponse({ type: CheckResponseDto })
  check(@Body() dto: PermissionRequestDto) {
    return this.permissions.check(dto);
  }
}
