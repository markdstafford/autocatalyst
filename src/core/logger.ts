import { pino } from 'pino';
import { Writable } from 'node:stream';
import type { LoggerProvider } from '@opentelemetry/api-logs';
import { SeverityNumber } from '@opentelemetry/api-logs';

interface LoggerOptions {
  destination?: pino.DestinationStream;
  loggerProvider?: LoggerProvider;
}

const LEVEL_TO_SEVERITY: Record<string, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

export function createLogger(component: string, options?: LoggerOptions): pino.Logger {
  let primaryDest: pino.DestinationStream | ReturnType<typeof pino.transport>;

  if (options?.destination) {
    primaryDest = options.destination;
  } else if (process.env.LOG_PRETTY === 'true') {
    primaryDest = pino.transport({ target: 'pino-pretty', options: { destination: 2 } });
  } else {
    primaryDest = pino.destination(2);
  }

  const pinoConfig = {
    base: null,
    level: 'debug',
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: {
      level(label: string) {
        return { level: label };
      },
      log(object: Record<string, unknown>) {
        return { component, ...object };
      },
    },
  };

  const loggerProvider = options?.loggerProvider;
  if (!loggerProvider) {
    return pino(pinoConfig, primaryDest);
  }

  const otelLogger = loggerProvider.getLogger(component);
  const otelStream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      try {
        const line = chunk.toString().trim();
        if (line) {
          const record = JSON.parse(line) as Record<string, unknown>;
          const { msg, level: levelLabel, ...attributes } = record;
          const severityNumber = LEVEL_TO_SEVERITY[levelLabel as string] ?? SeverityNumber.INFO;
          otelLogger.emit({
            body: typeof msg === 'string' ? msg : '',
            severityNumber,
            attributes: attributes as Record<string, string | number | boolean>,
          });
        }
      } catch {
        // Never block pino on parse failures
      }
      cb();
    },
  });

  const multiDest = pino.multistream([
    { stream: primaryDest as pino.DestinationStream },
    { stream: otelStream as unknown as pino.DestinationStream },
  ]);

  return pino(pinoConfig, multiDest);
}
