import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { collectDefaultMetrics, Registry } from 'prom-client';

/** Latency buckets (seconds) tuned for a sub-millisecond-to-seconds request path. */
export const LATENCY_BUCKETS = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

/** One registry per service instance (tests run several in one process), with Node.js runtime metrics. */
export const createRegistry = (service: string): Registry => {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
  return registry;
};

export type MetricsServer = { url: string; close: () => Promise<void> };

/** Minimal `/metrics` endpoint for processes that have no HTTP server of their own. Port 0 = random. */
export const startMetricsServer = (registry: Registry, port: number): Promise<MetricsServer> =>
  new Promise((resolve, reject) => {
    const server: Server = createServer(async (req, res) => {
      if (req.url !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      try {
        res.writeHead(200, { 'Content-Type': registry.contentType }).end(await registry.metrics());
      } catch (error) {
        res.writeHead(500).end(String(error));
      }
    });
    server.once('error', reject);
    server.listen(port, () => {
      const { port: actual } = server.address() as AddressInfo;
      resolve({
        url: `http://localhost:${actual}/metrics`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
