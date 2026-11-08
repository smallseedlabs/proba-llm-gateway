import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: [
        'apiKey',
        'authorization',
        'headers.authorization',
        'req.headers.authorization',
        'actAsAssertion',
        '*.apiKey',
        '*.authorization',
        '*.actAsAssertion',
      ],
      censor: '[REDACTED]',
    },
  });
}
