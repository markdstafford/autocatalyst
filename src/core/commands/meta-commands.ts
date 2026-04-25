import type { CommandHandler, CommandRegistry } from '../../types/commands.js';

export function makeHealthHandler(
  isConnected: () => boolean,
  getActiveRunCount: () => number,
): CommandHandler {
  return async (_event, reply) => {
    const connected = isConnected();
    const activeRuns = getActiveRunCount();
    const status = connected ? '✓ Connected' : '✗ Disconnected';
    await reply(`*Autocatalyst health*\nChannel: ${status}\nActive runs: ${activeRuns}`);
  };
}

export function makeHelpHandler(registry: CommandRegistry): CommandHandler {
  return async (event, reply) => {
    const [commandArg] = event.args;

    if (commandArg) {
      if (!registry.has(commandArg)) {
        await reply(`unknown command: \`${commandArg}\`. Use \`:ac-help:\` to see all available commands.`);
        return;
      }
      const usage = registry.getUsage(commandArg) ?? `\`${commandArg}\` — no usage information available.`;
      await reply(usage);
      return;
    }

    // No args: list all commands
    const commands = registry.list();
    if (commands.length === 0) {
      await reply('No commands are registered.');
      return;
    }
    const lines = commands.map(cmd => {
      const emojiName = cmd.replace(/\./g, '-');
      const usage = registry.getUsage(cmd);
      return usage ? `• \`:ac-${emojiName}:\` — ${usage}` : `• \`:ac-${emojiName}:\``;
    });
    await reply(`*Available commands:*\n${lines.join('\n')}`);
  };
}
