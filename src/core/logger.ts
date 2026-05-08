import { pino } from 'pino';

interface LoggerOptions {
  destination?: pino.DestinationStream;
}

export function createLogger(component: string, options?: LoggerOptions): pino.Logger {
  let dest: pino.DestinationStream | ReturnType<typeof pino.transport>;

  if (options?.destination) {
    dest = options.destination;
  } else if (process.env.LOG_PRETTY === 'true') {
    dest = pino.transport({ target: 'pino-pretty', options: { destination: 2 } });
  } else {
    dest = pino.destination(2);
  }

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
