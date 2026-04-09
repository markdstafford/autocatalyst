#!/usr/bin/env node

import { parseArgs, printUsage } from './core/cli.js';
import { bootstrapWorkflow, loadConfig, redactConfig, resolveEnvVars } from './core/config.js';
import { ConfigWatcher } from './core/config-watcher.js';
import { Service } from './core/service.js';
import { registerSignalHandlers } from './core/signals.js';
import { createLogger } from './core/logger.js';
import { join } from 'node:path';

const logger = createLogger('cli');

try {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  // Bootstrap WORKFLOW.md if missing
  logger.info({ event: 'service.starting' }, 'Starting Autocatalyst');

  const bootstrapped = bootstrapWorkflow(args.repoPath);
  if (bootstrapped) {
    logger.info({ event: 'config.bootstrapped', repoPath: args.repoPath },
      'Created default WORKFLOW.md');
  }

  // Load config
  const workflowPath = join(args.repoPath, 'WORKFLOW.md');
  let currentConfig = loadConfig(workflowPath, process.env as Record<string, string>);

  // Log loaded config (redacted)
  const { resolved: _resolved, missing } = resolveEnvVars(
    currentConfig.config as Record<string, unknown>,
    process.env as Record<string, string>,
  );

  if (missing.length > 0) {
    logger.warn({ event: 'config.env_missing', missing }, `Missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  const redacted = redactConfig(
    currentConfig.config as Record<string, unknown>,
    Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]
    ),
  );
  logger.info({ event: 'config.loaded', config: redacted }, 'Configuration loaded');

  // Create service
  const service = new Service(currentConfig);

  // Register signal handlers
  const cleanupSignals = registerSignalHandlers(service);

  // Start config watcher
  const watcher = new ConfigWatcher(workflowPath, {
    onReload: () => {
      try {
        const newConfig = loadConfig(workflowPath, process.env as Record<string, string>);
        currentConfig = newConfig;
        service.updateConfig(newConfig);
        logger.info({ event: 'config.reloaded' }, 'Configuration reloaded');
      } catch (err) {
        logger.warn({ event: 'config.reload_failed', error: String(err) },
          'Config reload failed, keeping current config');
      }
    },
  });
  watcher.start();

  // Start service
  service.start();

  // Wait for shutdown
  service.stopped.then(() => {
    watcher.stop();
    cleanupSignals();
    process.exit(0);
  });
} catch (err) {
  logger.error({ event: 'config.parse_error', error: String(err) }, String(err));
  process.exit(1);
}
