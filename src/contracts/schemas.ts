import { z } from 'zod';

/** Module / action names, e.g. `orders` + `read`. Normalized to lowercase. */
export const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_.:-]*$/;

const identifier = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(IDENTIFIER_PATTERN, 'may only contain letters, digits and _ . : -');

export const apiKeySchema = z.string().min(8).max(256);

export const permissionSchema = z.object({ module: identifier, action: identifier });

export const grantRequestSchema = z
  .object({ apiKey: apiKeySchema, module: identifier, action: identifier })
  .strict();
export const revokeRequestSchema = grantRequestSchema;
export const checkRequestSchema = grantRequestSchema;
export const listRequestSchema = z.object({ apiKey: apiKeySchema }).strict();

export type Permission = z.infer<typeof permissionSchema>;
export type GrantRequest = z.infer<typeof grantRequestSchema>;
export type RevokeRequest = z.infer<typeof revokeRequestSchema>;
export type CheckRequest = z.infer<typeof checkRequestSchema>;
export type ListRequest = z.infer<typeof listRequestSchema>;

export type GrantResponse = { status: 'ok' };
export type RevokeResponse = { status: 'ok'; removed: boolean };
export type CheckResponse = { allowed: boolean };
export type ListResponse = { permissions: Permission[] };
export type HealthResponse = { status: 'ok' };
