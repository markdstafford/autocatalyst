import { intakeRoutingErrorDetailsSchema } from '@autocatalyst/api-contract';
import { ControlPlaneClientError } from '@autocatalyst/sdk';

export interface LookupFailure {
  readonly message: string;
  readonly action?: 'reconcile' | 'settings' | 'retry';
}

function detail(value: unknown, name: string): unknown {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, name)
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

export function lookupFailure(error: unknown): LookupFailure {
  if (error instanceof ControlPlaneClientError) {
    const { code, details } = error.response.error;
    if (error.status === 404 && code === 'not_found') {
      switch (detail(details, 'resource')) {
        case 'issue': return { message: 'That issue was not found in this repository' };
        case 'project': return { message: 'This project is no longer available.', action: 'reconcile' };
      }
    }
    if (error.status === 400 && code === 'intake_routing_error') {
      const trackerCode = detail(details, 'trackerCode');
      const resolver = trackerCode === undefined ? intakeRoutingErrorDetailsSchema.safeParse(details) : undefined;
      // Project setup can fail in the intake resolver before it calls an adapter.
      // Its public schema has no trackerCode; accept only these two setup cases.
      const setupCode = resolver?.success && !('trackerCode' in resolver.data) &&
        (resolver.data.code === 'tracker_not_configured' || resolver.data.code === 'tracker_credential_missing')
        ? resolver.data.code : undefined;
      switch (trackerCode ?? setupCode) {
        case 'tracker_auth_failed':
          return { message: "This project's issue tracker credential was rejected.", action: 'settings' };
        case 'tracker_credential_missing':
          return { message: 'This project is missing an issue tracker credential.', action: 'settings' };
        case 'tracker_not_configured':
          return { message: 'This project has no issue tracker.', action: 'settings' };
      }
    }
  }
  return { message: 'The issue could not be read.', action: 'retry' };
}

export function isRejectedBearer(error: unknown): boolean {
  return error instanceof ControlPlaneClientError && error.status === 401;
}

export function startRunFailure(error: unknown): string {
  const fallback = 'The run could not be started.';
  if (!(error instanceof ControlPlaneClientError)) return fallback;
  const { code, details, message } = error.response.error;
  // Intake is the only create error family that handles provider or routing text.
  // Display messages from known, control-plane-generated failures in that family.
  if (code !== 'intake_routing_error') return message;
  if (error.status !== 400) return fallback;
  const intake = intakeRoutingErrorDetailsSchema.safeParse(details);
  if (!intake.success || 'trackerCode' in intake.data) return fallback;
  switch (intake.data.code) {
    case 'project_not_accessible':
    case 'tracker_not_configured':
    case 'tracker_credential_missing':
    case 'unsupported_tracker_provider':
      return message;
    case 'tracker_read_failed':
      return message === 'Failed to read issue from tracker.' ? message : fallback;
    default:
      return fallback;
  }
}
