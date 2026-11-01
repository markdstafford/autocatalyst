import { readControlPlaneAppConfig } from './config.js';
import { startControlPlaneServer, type ControlPlaneServerHandle } from './server.js';

function registerShutdownHandlers(handle: ControlPlaneServerHandle): void {
  const shutdown = async (signal: NodeJS.Signals) => {
    console.info('control-plane shutdown requested', { signal });
    await handle.close();
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<ControlPlaneServerHandle> {
  const config = readControlPlaneAppConfig(argv, env);
  const handle = await startControlPlaneServer(config);
  console.info('control-plane started', {
    port: handle.port,
    databasePath: handle.databasePath
  });
  if (config.fakeMode !== undefined) {
    // Exactly one readiness line to stdout after the server is listening.
    console.log(
      `fake-mode ready port=${handle.port} stateDir=${config.fakeMode.stateDir} baseUrl=http://127.0.0.1:${handle.port}`
    );
  }
  registerShutdownHandlers(handle);
  return handle;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error('control-plane failed to start', error);
    process.exit(1);
  });
}
