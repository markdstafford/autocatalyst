export interface CommandEvent {
  command: string;              // normalized command name: 'run.status', 'health', etc.
  args: string[];               // text after the emoji token, split on whitespace
  source: 'slack';
  channel_id: string;
  thread_ts: string;
  author: string;
  received_at: string;          // ISO 8601
  inferred_context?: {
    request_id?: string;        // resolved from ThreadRegistry using thread_ts
  };
}

export type CommandHandler = (
  event: CommandEvent,
  reply: (text: string) => Promise<void>,
) => Promise<void>;

export interface CommandRegistry {
  register(command: string, handler: CommandHandler, usage?: string): void;
  dispatch(command: string, event: CommandEvent, reply: (text: string) => Promise<void>): Promise<void>;
  has(command: string): boolean;
  list(): string[];
  getUsage(command: string): string | undefined;
}
