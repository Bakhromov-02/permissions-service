// Imported first by main.ts, so the http/express instrumentations are active before Nest loads them.
import { startTracing } from '../shared/tracing';

export const stopTracing = startTracing('gateway');
