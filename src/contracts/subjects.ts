/** NATS subjects served by the permissions service (request–reply). */
export const Subjects = {
  GRANT: 'permissions.grant',
  REVOKE: 'permissions.revoke',
  CHECK: 'permissions.check',
  LIST: 'permissions.list',
  HEALTH: 'permissions.health',
} as const;

export type Subject = (typeof Subjects)[keyof typeof Subjects];

/**
 * Queue group shared by all permissions-service instances: NATS delivers each request to exactly one
 * member, so running more replicas scales horizontally with no other coordination.
 */
export const PERMISSIONS_QUEUE_GROUP = 'permissions-service';
