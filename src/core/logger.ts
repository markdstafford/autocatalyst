import pino from 'pino';

interface LoggerOptions {
  destination?: pino.DestinationStream;
}

export function createLogger(component: string, options?: LoggerOptions): pino.Logger {
  const dest = options?.destination ?? pino.destination(1);

  return pino(
    {
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
    },
    dest,
  );
}
