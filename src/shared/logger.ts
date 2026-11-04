import winston from 'winston';

/** Structured JSON logger. Never log raw API keys — use `keyId()` instead. */
export const createLogger = (service: string) =>
  winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    silent: process.env.NODE_ENV === 'test' && !process.env.LOG_LEVEL,
    defaultMeta: { service },
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [new winston.transports.Console()],
  });

export type Logger = ReturnType<typeof createLogger>;
