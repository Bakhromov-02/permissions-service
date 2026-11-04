import {
  CheckRequest,
  CheckResponse,
  GrantRequest,
  GrantResponse,
  ListRequest,
  ListResponse,
  Permission,
  RevokeRequest,
  RevokeResponse,
} from '../contracts';
import { hashApiKey } from '../shared/hash';
import { PermissionCache } from './cache';
import { PermissionsRepository } from './repository';

/** Business logic, independent of NATS: easy to read and to test. */
export class PermissionHandlers {
  constructor(
    private readonly repository: PermissionsRepository,
    private readonly cache: PermissionCache,
  ) {}

  async grant({ apiKey, module, action }: GrantRequest): Promise<GrantResponse> {
    const keyHash = hashApiKey(apiKey);
    await this.repository.grant(keyHash, { module, action });
    await this.cache.invalidate(keyHash);
    return { status: 'ok' };
  }

  async revoke({ apiKey, module, action }: RevokeRequest): Promise<RevokeResponse> {
    const keyHash = hashApiKey(apiKey);
    const removed = await this.repository.revoke(keyHash, { module, action });
    await this.cache.invalidate(keyHash);
    return { status: 'ok', removed };
  }

  async list({ apiKey }: ListRequest): Promise<ListResponse> {
    return { permissions: await this.load(hashApiKey(apiKey)) };
  }

  /** An unknown API key simply has no permissions, so it is never allowed. */
  async check({ apiKey, module, action }: CheckRequest): Promise<CheckResponse> {
    const permissions = await this.load(hashApiKey(apiKey));
    return { allowed: permissions.some((p) => p.module === module && p.action === action) };
  }

  private async load(keyHash: string): Promise<Permission[]> {
    const lookup = await this.cache.get(keyHash);
    if (lookup.permissions) return lookup.permissions;

    const permissions = await this.repository.list(keyHash);
    // Empty lists are cached too, so repeated checks for unknown keys don't hit the database.
    // The fill is conditional on `lookup.revision`, so it is skipped if a write happened meanwhile.
    await this.cache.fill(keyHash, permissions, lookup.revision);
    return permissions;
  }
}
