// Imported first by main.ts, so the pg instrumentation is active before `pg` is loaded.
import { startTracing } from '../shared/tracing';

export const stopTracing = startTracing('permissions-service');
