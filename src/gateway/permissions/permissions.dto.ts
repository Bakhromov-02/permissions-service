import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { IDENTIFIER_PATTERN } from '../../contracts';

const IDENTIFIER_MESSAGE = 'may only contain lowercase letters, digits and _ . : -';

export class ApiKeyDto {
  @ApiProperty({ example: 'sk_live_51HbX3k2eZvKYlo2C', minLength: 8, maxLength: 256 })
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  apiKey!: string;
}

export class PermissionRequestDto extends ApiKeyDto {
  @ApiProperty({ example: 'orders', maxLength: 64 })
  @IsString()
  @MaxLength(64)
  @Matches(IDENTIFIER_PATTERN, { message: `module ${IDENTIFIER_MESSAGE}` })
  module!: string;

  @ApiProperty({ example: 'read', maxLength: 64 })
  @IsString()
  @MaxLength(64)
  @Matches(IDENTIFIER_PATTERN, { message: `action ${IDENTIFIER_MESSAGE}` })
  action!: string;
}

export class PermissionDto {
  @ApiProperty({ example: 'orders' }) module!: string;
  @ApiProperty({ example: 'read' }) action!: string;
}

export class StatusResponseDto {
  @ApiProperty({ example: 'ok' }) status!: 'ok';
}

export class RevokeResponseDto extends StatusResponseDto {
  @ApiProperty({ description: 'false if the permission did not exist' }) removed!: boolean;
}

export class CheckResponseDto {
  @ApiProperty() allowed!: boolean;
}

export class ListResponseDto {
  @ApiProperty({ type: [PermissionDto] }) permissions!: PermissionDto[];
}
