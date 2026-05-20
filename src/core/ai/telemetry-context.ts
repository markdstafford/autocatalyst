export interface TelemetryContext {
  run_id?: string;
  request_id?: string;
  phase?: string;
  route_task?: string;
  handler?: string;
}

export function buildTelemetryContext(fields: TelemetryContext): TelemetryContext {
  return { ...fields };
}

export function emptyTelemetryContext(): TelemetryContext {
  return {};
}
