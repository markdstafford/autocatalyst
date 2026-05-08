import { metrics } from '@opentelemetry/api';
import type { Meter } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import type { LoggerProvider } from '@opentelemetry/api-logs';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { LoggerProvider as SdkLoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';

export interface TelemetryHandles {
  meter: Meter;
  loggerProvider: LoggerProvider;
  shutdown: () => Promise<void>;
}

export function initTelemetry(): TelemetryHandles {
  const metricsEndpoint = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  const logsEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  const exportInterval = parseInt(process.env.OTEL_EXPORT_INTERVAL_MS ?? '30000', 10);

  if (!metricsEndpoint && !logsEndpoint) {
    // No-op path: use global no-op providers; zero network connections
    const meter = metrics.getMeter('autocatalyst');
    const loggerProvider = logs.getLoggerProvider();
    return {
      meter,
      loggerProvider,
      shutdown: async () => {
        // Nothing to shut down in no-op path
      },
    };
  }

  // Live OTLP path
  const metricExporter = new OTLPMetricExporter({
    url: metricsEndpoint,
  });

  const sdkMeterProvider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: exportInterval,
      }),
    ],
  });

  const logExporter = new OTLPLogExporter({
    url: logsEndpoint,
  });

  const sdkLoggerProvider = new SdkLoggerProvider({
    processors: [new BatchLogRecordProcessor(logExporter)],
  });

  const meter = sdkMeterProvider.getMeter('autocatalyst');
  const loggerProvider: LoggerProvider = sdkLoggerProvider;

  const shutdown = async (): Promise<void> => {
    try {
      await sdkMeterProvider.forceFlush();
    } catch {
      // swallow export errors
    }
    try {
      await sdkMeterProvider.shutdown();
    } catch {
      // swallow shutdown errors
    }
    try {
      await sdkLoggerProvider.forceFlush();
    } catch {
      // swallow export errors
    }
    try {
      await sdkLoggerProvider.shutdown();
    } catch {
      // swallow shutdown errors
    }
  };

  return { meter, loggerProvider, shutdown };
}
