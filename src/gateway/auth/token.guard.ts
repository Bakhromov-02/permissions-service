import { timingSafeEqual } from 'crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import { GATEWAY_CONFIG, GatewayConfig } from '../config';

export type TokenScope = 'admin' | 'service';

const SCOPE_KEY = 'tokenScope';

/** `admin` routes need the admin token; `service` routes accept the service or the admin token. */
export const RequireToken = (scope: TokenScope) => SetMetadata(SCOPE_KEY, scope);

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

@Injectable()
export class TokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const scope = this.reflector.getAllAndOverride<TokenScope | undefined>(SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!scope) return true;

    const header = context.switchToHttp().getRequest<Request>().headers.authorization ?? '';
    const [type, token] = header.split(' ');
    if (type !== 'Bearer' || !token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const isAdmin = safeEqual(token, this.config.adminToken);
    const isService = safeEqual(token, this.config.serviceToken);

    if (!isAdmin && !isService) throw new UnauthorizedException('Invalid token');
    if (scope === 'admin' && !isAdmin) throw new ForbiddenException('Admin token required');
    return true;
  }
}
