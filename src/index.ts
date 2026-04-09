#!/usr/bin/env node

import { parseArgs, printUsage } from './core/cli.js';
import { bootstrapWorkflow, loadConfig, redactConfig, resolveEnvVars } from './core/config.js';
import { ConfigWatcher } from './core/config-watcher.js';
import { Service } from './core/service.js';
import { registerSignalHandlers } from './core/signals.js';
import { createLogger } from './core/logger.js';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { App } from '@slack/bolt';
import { SlackAdapter } from './adapters/slack/slack-adapter.js';
import { WorkspaceManagerImpl } from './core/workspace-manager.js';
import { OMCSpecGenerator } from './adapters/agent/spec-generator.js';
import { SlackCanvasPublisher } from './adapters/slack/canvas-publisher.js';
import { OrchestratorImpl } from './core/orchestrator.js';

const logger = createLogger('cli');

try {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  logger.info({ event: 'service.starting' }, 'Starting Autocatalyst');

  const bootstrapped = bootstrapWorkflow(args.repoPath);
  if (bootstrapped) {
    logger.info({ event: 'config.bootstrapped', repoPath: args.repoPath }, 'Created default WORKFLOW.md');
  }

  const workflowPath = join(args.repoPath, 'WORKFLOW.md');
  let currentConfig = loadConfig(workflowPath, process.env as Record<string, string>);

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

  // Resolve repo_url from git origin
  let repo_url: string;
  try {
    repo_url = execSync('git remote get-url origin', { cwd: args.repoPath }).toString().trim();
    if (!repo_url) throw new Error('git remote get-url origin returned empty string');
  } catch (err) {
    logger.error({ event: 'config.parse_error', error: String(err) }, 'Could not resolve git origin URL. Run: git remote add origin <url>');
    process.exit(1);
  }

  // Validate workspace.root
  const workspaceRoot = currentConfig.config.workspace?.root;
  if (!workspaceRoot || typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
    logger.error({ event: 'config.parse_error', error: 'workspace.root is not set in WORKFLOW.md' }, 'workspace.root is required');
    process.exit(1);
  }

  // Build Bolt App
  const boltApp = new App({
    token: currentConfig.config.slack?.bot_token,
    appToken: currentConfig.config.slack?.app_token,
    socketMode: true,
  });

  // Build adapter, components, orchestrator
  const adapter = new SlackAdapter(boltApp, {
    channelName: currentConfig.config.slack?.channel_name ?? '',
    approvalEmojis: currentConfig.config.slack?.approval_emojis ?? ['thumbsup'],
  });

  const workspaceManager = new WorkspaceManagerImpl(workspaceRoot);
  const specGenerator = new OMCSpecGenerator();
  const canvasPublisher = new SlackCanvasPublisher(boltApp);

  const orchestrator = new OrchestratorImpl({
    adapter,
    workspaceManager,
    specGenerator,
    canvasPublisher,
    postError: async (channel_id, thread_ts, text) => {
      await boltApp.client.chat.postMessage({ channel: channel_id, thread_ts, text });
    },
    repo_url,
  });

  const service = new Service(currentConfig, { orchestrator });

  const cleanupSignals = registerSignalHandlers(service);

  const watcher = new ConfigWatcher(workflowPath, {
    onReload: () => {
      try {
        const newConfig = loadConfig(workflowPath, process.env as Record<string, string>);
        const changedKeys = Object.keys(newConfig.config).filter(
          k => JSON.stringify(newConfig.config[k]) !== JSON.stringify(currentConfig.config[k]),
        );
        currentConfig = newConfig;
        service.updateConfig(newConfig);
        logger.info({ event: 'config.reloaded', changed_keys: changedKeys }, 'Configuration reloaded');
      } catch (err) {
        logger.warn({ event: 'config.reload_failed', error: String(err) }, 'Config reload failed, keeping current config');
      }
    },
  });
  watcher.start();

  service.start();

  service.stopped.then(() => {
    watcher.stop();
    cleanupSignals();
    process.exit(0);
  });
} catch (err) {
  logger.error({ event: 'config.parse_error', error: String(err) }, String(err));
  process.exit(1);
}
