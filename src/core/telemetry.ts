import { metrics } from '@opentelemetry/api';
import type { Meter } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import type { LoggerProvider } from '@opentelemetry/api-logs';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { LoggerProvider as SdkLoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import type { TelemetryConfig } from '../types/config.js';

export interface TelemetryHandles {
  meter: Meter;
  loggerProvider: LoggerProvider;
  shutdown: () => Promise<void>;
}

export function initTelemetry(config?: TelemetryConfig): TelemetryHandles {
  // Config takes precedence over env vars
  const metricsEndpoint = config?.metrics_endpoint ?? process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  const logsEndpoint = config?.logs_endpoint ?? process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  const rawInterval = config?.export_interval_ms ?? parseInt(process.env.OTEL_EXPORT_INTERVAL_MS ?? '30000', 10);
  const exportIntervalMs = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 30000;

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

  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'autocatalyst' });

  // Live OTLP path — gate each provider independently
  let sdkMeterProvider: MeterProvider | undefined;
  if (metricsEndpoint) {
    const metricExporter = new OTLPMetricExporter({
      url: metricsEndpoint,
    });

    sdkMeterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: exportIntervalMs,
        }),
      ],
    });

    metrics.setGlobalMeterProvider(sdkMeterProvider);
  }

  let sdkLoggerProvider: SdkLoggerProvider | undefined;
  if (logsEndpoint) {
    const logExporter = new OTLPLogExporter({
      url: logsEndpoint,
    });

    sdkLoggerProvider = new SdkLoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor(logExporter)],
    });

    logs.setGlobalLoggerProvider(sdkLoggerProvider);
  }

  const meter = sdkMeterProvider
    ? sdkMeterProvider.getMeter('autocatalyst')
    : metrics.getMeter('autocatalyst');

  const loggerProvider: LoggerProvider = sdkLoggerProvider ?? logs.getLoggerProvider();

  const shutdown = async (): Promise<void> => {
    if (sdkMeterProvider) {
      try {
        await sdkMeterProvider.forceFlush();
      } catch (err) {
        console.warn('telemetry shutdown flush error (ignored):', err);
      }
      try {
        await sdkMeterProvider.shutdown();
      } catch (err) {
        console.warn('telemetry shutdown flush error (ignored):', err);
      }
    }
    if (sdkLoggerProvider) {
      try {
        await sdkLoggerProvider.forceFlush();
      } catch (err) {
        console.warn('telemetry shutdown flush error (ignored):', err);
      }
      try {
        await sdkLoggerProvider.shutdown();
      } catch (err) {
        console.warn('telemetry shutdown flush error (ignored):', err);
      }
    }
  };

  return { meter, loggerProvider, shutdown };
}
