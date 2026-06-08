import type { HealthResponse } from '@autocatalyst/api-contract';

export interface HealthDependencyChecker {
  isDatabaseReachable(): Promise<boolean>;
}

export async function getHealth(checker: HealthDependencyChecker): Promise<HealthResponse> {
  try {
    if (await checker.isDatabaseReachable()) {
      return { status: 'ok', database: { status: 'reachable' } };
    }
  } catch {
    return { status: 'degraded', database: { status: 'unreachable' } };
  }

  return { status: 'degraded', database: { status: 'unreachable' } };
}
