import type { CommandEvent, CommandHandler, CommandRegistry } from '../types/commands.js';

interface RegisteredCommand {
  handler: CommandHandler;
  usage: string | undefined;
}

export class CommandRegistryImpl implements CommandRegistry {
  private readonly commands = new Map<string, RegisteredCommand>();

  register(command: string, handler: CommandHandler, usage?: string): void {
    this.commands.set(command, { handler, usage });
  }

  async dispatch(command: string, event: CommandEvent, reply: (text: string) => Promise<void>): Promise<void> {
    const entry = this.commands.get(command);
    if (!entry) {
      throw new Error(`Unknown command: ${command}`);
    }
    await entry.handler(event, reply);
  }

  has(command: string): boolean {
    return this.commands.has(command);
  }

  list(): string[] {
    return [...this.commands.keys()];
  }

  getUsage(command: string): string | undefined {
    return this.commands.get(command)?.usage;
  }
}
