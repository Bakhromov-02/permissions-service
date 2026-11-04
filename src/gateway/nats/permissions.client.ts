import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { connect, ErrorCode as NatsErrorCode, JSONCodec, NatsConnection, NatsError } from 'nats';

import {
  CheckRequest,
  CheckResponse,
  ErrorCode,
  GrantRequest,
  GrantResponse,
  isErrorResponse,
  ListRequest,
  ListResponse,
  RevokeRequest,
  RevokeResponse,
  Subject,
  Subjects,
} from '../../contracts';
import { traceRequest } from '../../shared/nats-tracing';
import { GATEWAY_CONFIG, GatewayConfig } from '../config';
import { GATEWAY_METRICS, GatewayMetrics } from '../metrics/gateway-metrics';

const codec = JSONCodec();

/** Typed request–reply client for the permissions service. Translates failures into HTTP errors. */
@Injectable()
export class PermissionsClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PermissionsClient.name);
  private nats?: NatsConnection;

  constructor(
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
    @Inject(GATEWAY_METRICS) private readonly metrics: GatewayMetrics,
  ) {}

  async onModuleInit() {
    this.nats = await connect({ servers: this.config.natsUrl, name: 'gateway' });
    this.logger.log(`Connected to NATS at ${this.config.natsUrl}`);
  }

  async onModuleDestroy() {
    await this.nats?.drain();
  }

  get isConnected(): boolean {
    return !!this.nats && !this.nats.isClosed();
  }

  grant(payload: GrantRequest) {
    return this.request<GrantResponse>(Subjects.GRANT, payload);
  }

  revoke(payload: RevokeRequest) {
    return this.request<RevokeResponse>(Subjects.REVOKE, payload);
  }

  check(payload: CheckRequest) {
    return this.request<CheckResponse>(Subjects.CHECK, payload);
  }

  list(payload: ListRequest) {
    return this.request<ListResponse>(Subjects.LIST, payload);
  }

  /** True if at least one service instance answers within the timeout. */
  async ping(): Promise<boolean> {
    try {
      await this.request(Subjects.HEALTH, {});
      return true;
    } catch {
      return false;
    }
  }

  private async request<T>(subject: Subject, payload: unknown): Promise<T> {
    const nats = this.nats;
    if (!nats) throw new ServiceUnavailableException('Not connected to NATS');

    const stopTimer = this.metrics.natsDuration.startTimer({ subject });
    let body: unknown;
    try {
      // The trace context travels in NATS headers, so the service's span joins this request's trace.
      const reply = await traceRequest(subject, (headers) =>
        nats.request(subject, codec.encode(payload), { timeout: this.config.requestTimeoutMs, headers }),
      );
      body = codec.decode(reply.data);
    } catch (error) {
      if (error instanceof NatsError && error.code === NatsErrorCode.NoResponders) {
        stopTimer({ outcome: 'no_responders' });
        throw new ServiceUnavailableException('Permissions service is unavailable');
      }
      if (error instanceof NatsError && error.code === NatsErrorCode.Timeout) {
        stopTimer({ outcome: 'timeout' });
        throw new GatewayTimeoutException('Permissions service did not respond in time');
      }
      stopTimer({ outcome: 'error' });
      this.logger.error(`NATS request to ${subject} failed: ${String(error)}`);
      throw new BadGatewayException('Permissions service request failed');
    }

    stopTimer({ outcome: isErrorResponse(body) ? body.error.code : 'ok' });

    if (isErrorResponse(body)) {
      const { code, message, details } = body.error;
      if (code === ErrorCode.InvalidPayload) throw new BadRequestException({ message, details });
      if (code === ErrorCode.DatabaseUnavailable) throw new ServiceUnavailableException(message);
      throw new BadGatewayException(message);
    }

    return body as T;
  }
}
