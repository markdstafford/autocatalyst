export type WorkspaceLogLevel = 'info' | 'warn' | 'error';

export interface WorkspaceLogEvent {
  readonly component: 'workspace-lifecycle';
  readonly event: string;
  readonly [key: string]: unknown;
}

export interface WorkspaceLogger {
  emit(level: WorkspaceLogLevel, event: WorkspaceLogEvent): void;
}

export const consoleWorkspaceLogger: WorkspaceLogger = {
  emit(level, event) {
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    method(JSON.stringify(event));
  }
};

export const silentWorkspaceLogger: WorkspaceLogger = {
  emit() {}
};
