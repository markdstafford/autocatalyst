import { App } from '@slack/bolt';

export function createBoltApp(botToken: string, appToken: string): App {
  return new App({
    token: botToken,
    appToken,
    socketMode: true,
  });
}
