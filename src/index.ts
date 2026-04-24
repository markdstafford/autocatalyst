#!/usr/bin/env node

import { parseArgs, printUsage } from './core/cli.js';
import { loadConfig, loadConfigFromPath, redactConfig, resolveEnvVars, resolveAwsProfile, repoNameFromUrl } from './core/config.js';
import type { ChannelRepoMap } from './types/config.js';
import { runInit, configExists } from './core/init.js';
import { ConfigWatcher } from './core/config-watcher.js';
import { Service } from './core/service.js';
import { registerSignalHandlers } from './core/signals.js';
import { createLogger } from './core/logger.js';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { App } from '@slack/bolt';
import { SlackAdapter } from './adapters/slack/slack-adapter.js';
import { ThreadRegistry } from './adapters/slack/thread-registry.js';
import { WorkspaceManagerImpl } from './core/workspace-manager.js';
import { AgentSDKSpecGenerator } from './adapters/agent/spec-generator.js';
import { SlackCanvasPublisher } from './adapters/slack/canvas-publisher.js';
import type { SpecPublisher } from './types/publisher.js';
import { OrchestratorImpl } from './core/orchestrator.js';
import { CommandRegistryImpl } from './core/command-registry.js';
import { makeRunStatusHandler, makeRunListHandler, makeRunCancelHandler, makeRunLogsHandler } from './core/commands/run-commands.js';
import { makeHealthHandler, makeHelpHandler } from './core/commands/meta-commands.js';
import { makeClassifyIntentHandler } from './core/commands/classify-intent-command.js';
import { FileRunStore } from './core/run-store.js';
import { NotionClientImpl } from './adapters/notion/notion-client.js';
import { NotionPublisher } from './adapters/notion/notion-publisher.js';
import { NotionFeedbackSource, type FeedbackSource } from './adapters/notion/notion-feedback-source.js';
import { AnthropicIntentClassifier } from './adapters/agent/intent-classifier.js';
import { AgentSDKQuestionAnswerer } from './adapters/agent/question-answerer.js';
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { AgentSDKImplementer } from './adapters/agent/implementer.js';
import { GHPRManager } from './adapters/agent/pr-manager.js';
import { GHIssueManager } from './adapters/agent/issue-manager.js';
import { AgentSDKIssueFiler } from './adapters/agent/issue-filer.js';
import { NotionSpecCommitter } from './adapters/notion/spec-committer.js';
import { NotionImplementationFeedbackPage } from './adapters/notion/implementation-feedback-page.js';
import type { SpecCommitter } from './adapters/notion/spec-committer.js';
import type { ImplementationFeedbackPage } from './adapters/notion/implementation-feedback-page.js';

const logger = createLogger('cli');

try {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (args.command === 'init') {
    const repoPath = args.repoPath || process.cwd();
    await runInit(repoPath);
    process.exit(0);
  }

  // run command — repoPath(s) validated by parseArgs
  const repoPaths = args.repoPaths;
  const repoPath = repoPaths[0];
  const isMultiRepo = repoPaths.length > 1;

  logger.info(
    { event: 'service.starting', mode: isMultiRepo ? 'multi-repo' : 'single-repo', ...(isMultiRepo ? { channel_count: repoPaths.length } : {}) },
    'Starting Autocatalyst',
  );

  // Init always runs before service startup
  await runInit(repoPath);

  if (!configExists(repoPath)) {
    logger.error(
      { event: 'service.init_incomplete' },
      'Config is not set up. Run `autocatalyst init --repo <path>` to initialize.',
    );
    process.exit(1);
  }

  const workflowPath = join(repoPath, 'WORKFLOW.md');
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

  // Resolve AWS profile — config takes precedence over environment variable
  const resolvedAwsProfile = resolveAwsProfile(currentConfig.config, process.env as Record<string, string | undefined>);
  if (resolvedAwsProfile !== undefined) {
    process.env['AWS_PROFILE'] = resolvedAwsProfile;
    logger.info(
      { event: 'service.config', aws_profile: resolvedAwsProfile },
      'Using AWS profile',
    );
  }

  // Resolve repo_url from git origin
  let repo_url: string;
  try {
    repo_url = execSync('git remote get-url origin', { cwd: repoPath }).toString().trim();
    if (!repo_url) throw new Error('git remote get-url origin returned empty string');
  } catch (err) {
    logger.error({ event: 'config.parse_error', error: String(err) }, 'Could not resolve git origin URL. Run: git remote add origin <url>');
    process.exit(1);
  }
  const repo_name = repoNameFromUrl(repo_url);

  // Validate workspace.root
  const rawWorkspaceRoot = currentConfig.config.workspace?.root;
  if (!rawWorkspaceRoot || typeof rawWorkspaceRoot !== 'string' || rawWorkspaceRoot.trim() === '') {
    logger.error({ event: 'config.parse_error', error: 'workspace.root is not set in WORKFLOW.md' }, 'workspace.root is required');
    process.exit(1);
  }
  const workspaceRoot = rawWorkspaceRoot.replace(/^~/, homedir());

  // Validate Slack tokens
  const botToken = currentConfig.config.slack?.bot_token;
  const appToken = currentConfig.config.slack?.app_token;
  if (!botToken || !appToken) {
    logger.error({ event: 'config.parse_error', error: 'slack.bot_token and slack.app_token are required' }, 'Missing Slack tokens');
    process.exit(1);
  }

  // Build Bolt App
  const boltApp = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  // Validate channel name
  const channelName = currentConfig.config.slack?.channel_name;
  if (!channelName) {
    logger.error({ event: 'config.parse_error', error: 'slack.channel_name is required' }, 'Missing Slack channel name');
    process.exit(1);
  }

  // Build intent classifier — prefer direct API key, fall back to Bedrock via AWS credential chain
  const anthropicApiKey = process.env['AC_ANTHROPIC_API_KEY'];
  let intentClassifier: AnthropicIntentClassifier;
  if (anthropicApiKey) {
    intentClassifier = new AnthropicIntentClassifier(anthropicApiKey);
    logger.info({ event: 'service.config', auth: 'anthropic-api-key' }, 'Using Anthropic API key for intent classification');
  } else {
    const bedrockClient = new AnthropicBedrock({
      providerChainResolver: () => Promise.resolve(fromNodeProviderChain()),
    });
    const bedrockCreateFn = async (params: { model: string; max_tokens: number; messages: Array<{ role: 'user'; content: string }> }) => {
      try {
        return await bedrockClient.messages.create({
          ...params,
          model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        }) as unknown as { content: Array<{ type: string; text: string }> };
      } catch (err) {
        const msg = String(err);
        if (msg.includes('CredentialsProviderError') || msg.includes('Could not load credentials') || msg.includes('sso')) {
          logger.error(
            { event: 'bedrock.credentials_expired', aws_profile: process.env['AWS_PROFILE'] ?? 'default' },
            'AWS credentials expired or unavailable. Run: aws sso login --profile <profile>',
          );
        }
        throw err;
      }
    };
    intentClassifier = new AnthropicIntentClassifier('', { createFn: bedrockCreateFn });
    logger.info({ event: 'service.config', auth: 'bedrock', aws_profile: process.env['AWS_PROFILE'] ?? 'default' }, 'Using AWS Bedrock for intent classification');
  }

  // Build question answerer — always uses Agent SDK with repo path as cwd (no Bedrock variant needed)
  const questionAnswerer = new AgentSDKQuestionAnswerer(repoPath);

  // Multi-repo: load config for each additional repo path and build PreRepoEntry list
  type PreEntryLocal = { channel_name: string; repo_url: string; workspace_root: string };
  const preRepoEntries: PreEntryLocal[] = [];

  if (isMultiRepo) {
    for (const rp of repoPaths) {
      await runInit(rp);
      if (!configExists(rp)) {
        logger.error({ event: 'service.init_incomplete', repo_path: rp }, `Config is not set up for ${rp}. Run autocatalyst init --repo ${rp}`);
        process.exit(1);
      }
      const rpLoaded = loadConfigFromPath(rp, process.env as Record<string, string>);
      const { resolved: rpResolved, missing: rpMissing } = resolveEnvVars(rpLoaded.config as Record<string, unknown>, process.env as Record<string, string>);
      if (rpMissing.length > 0) {
        logger.warn({ event: 'config.env_missing', repo_path: rp, missing: rpMissing }, `Missing env vars for ${rp}: ${rpMissing.join(', ')}`);
        process.exit(1);
      }
      const rpFinalConfig = rpResolved as import('./types/config.js').WorkflowConfig;

      let rpRepoUrl: string;
      try {
        rpRepoUrl = execSync('git remote get-url origin', { cwd: rp }).toString().trim();
        if (!rpRepoUrl) throw new Error('git remote get-url origin returned empty string');
      } catch (err) {
        logger.error({ event: 'config.parse_error', repo_path: rp, error: String(err) }, `Could not resolve git origin URL for ${rp}`);
        process.exit(1);
      }

      const rpChannelName = rpFinalConfig.slack?.channel_name;
      if (!rpChannelName) {
        logger.error({ event: 'config.parse_error', repo_path: rp }, `slack.channel_name is required in ${rp}/WORKFLOW.md`);
        process.exit(1);
      }

      const rpWorkspaceRoot = rpFinalConfig.workspace?.root ?? '~/.autocatalyst/workspaces';
      preRepoEntries.push({ channel_name: rpChannelName, repo_url: rpRepoUrl!, workspace_root: rpWorkspaceRoot });
    }
  }

  // Build adapter, components, orchestrator
  const threadRegistry = new ThreadRegistry();
  const adapter = new SlackAdapter(
    boltApp,
    isMultiRepo ? { repoEntries: preRepoEntries } : { channelName: channelName! },
    { registry: threadRegistry },
  );

  // Resolve channels before building orchestrator (idempotent — start() will be a no-op)
  await adapter.resolveChannels();

  // Build ChannelRepoMap
  const channelRepoMap: ChannelRepoMap = isMultiRepo
    ? adapter.getChannelRepoMap()
    : (() => {
        const channelId = adapter.getChannelId();
        const map: ChannelRepoMap = new Map([[channelId, { channel_id: channelId, repo_url, workspace_root: workspaceRoot }]]);
        return map;
      })();

  const workspaceManager = new WorkspaceManagerImpl();
  const runStore = new FileRunStore(workspaceRoot);
  const specGenerator = new AgentSDKSpecGenerator();
  const implementer = new AgentSDKImplementer();
  const prManager = new GHPRManager();
  const issueManager = new GHIssueManager();
  const issueFiler = new AgentSDKIssueFiler(issueManager);

  let specPublisher: SpecPublisher;
  let feedbackSource: FeedbackSource | undefined;
  let specCommitter: SpecCommitter | undefined;
  let implFeedbackPage: ImplementationFeedbackPage | undefined;

  if (currentConfig.config.notion) {
    const notionToken = process.env['AC_NOTION_INTEGRATION_TOKEN'];
    if (!notionToken) {
      logger.error({ event: 'config.parse_error' }, 'AC_NOTION_INTEGRATION_TOKEN is required when notion config is present');
      process.exit(1);
    }
    const specsDatabaseId = currentConfig.config.notion.specs_database_id;
    const testingGuidesDatabaseId = currentConfig.config.notion.testing_guides_database_id;
    if (!specsDatabaseId || !testingGuidesDatabaseId) {
      logger.error(
        { event: 'config.parse_error' },
        'notion.specs_database_id and notion.testing_guides_database_id are required in WORKFLOW.md',
      );
      process.exit(1);
    }
    const notionClient = new NotionClientImpl({ integration_token: notionToken });
    let botUser: { id: string };
    try {
      botUser = await notionClient.users.me();
    } catch (err) {
      logger.error({ event: 'notion.auth_failed', error: String(err) }, 'Failed to detect Notion bot user. Check AC_NOTION_INTEGRATION_TOKEN permissions.');
      process.exit(1);
    }
    logger.info({ event: 'service.config', bot_user_id: botUser.id }, 'Detected Notion bot user ID');
    specPublisher = new NotionPublisher(notionClient, boltApp, specsDatabaseId, { repo_name });
    feedbackSource = new NotionFeedbackSource(notionClient, { bot_user_id: botUser.id });
    specCommitter = new NotionSpecCommitter(specPublisher);
    implFeedbackPage = new NotionImplementationFeedbackPage(notionClient, testingGuidesDatabaseId);
    logger.info({ event: 'service.config', publisher: 'notion' }, 'Using Notion publisher');
  } else {
    specPublisher = new SlackCanvasPublisher(boltApp);
    logger.info({ event: 'service.config', publisher: 'slack-canvas' }, 'Using Slack canvas publisher');
  }

  const commandRegistry = new CommandRegistryImpl();

  const orchestrator = new OrchestratorImpl({
    adapter,
    workspaceManager,
    specGenerator,
    specPublisher,
    feedbackSource,
    intentClassifier,
    questionAnswerer,
    specCommitter,
    implementer,
    implFeedbackPage,
    prManager,
    issueManager,
    issueFiler,
    runStore,
    threadRegistry,
    commandRegistry,
    postError: async (channel_id, thread_ts, text) => {
      await boltApp.client.chat.postMessage({ channel: channel_id, thread_ts, text });
    },
    postMessage: async (channel_id, thread_ts, text) => {
      await boltApp.client.chat.postMessage({ channel: channel_id, thread_ts, text });
    },
    channelRepoMap,
  });

  // Register command handlers
  commandRegistry.register(
    'run.status',
    makeRunStatusHandler(orchestrator.getRuns()),
    'Show the current stage, intent, and time in stage for a run. Usage: `:ac-run-status:` (in thread) or `:ac-run-status: <run-id>`',
  );
  commandRegistry.register(
    'run.list',
    makeRunListHandler(orchestrator.getRuns()),
    'List all active runs. Usage: `:ac-run-list:`',
  );
  commandRegistry.register(
    'run.cancel',
    makeRunCancelHandler(
      orchestrator.getRuns(),
      (requestId) => orchestrator.cancelRun(requestId),
    ),
    'Cancel an active run. Usage: `:ac-run-cancel:` (in thread) or `:ac-run-cancel: <run-id>`',
  );
  commandRegistry.register(
    'run.logs',
    makeRunLogsHandler(
      orchestrator.getRuns(),
      (requestId) => orchestrator.getRunLogs(requestId),
    ),
    'Show the log tail for a run. Usage: `:ac-run-logs:` (in thread) or `:ac-run-logs: <run-id>`',
  );

  commandRegistry.register(
    'health',
    makeHealthHandler(
      () => adapter.isConnected(),
      () => orchestrator.getActiveRunCount(),
    ),
    'Check system health and active run count. Usage: `:ac-health:`',
  );
  commandRegistry.register(
    'help',
    makeHelpHandler(commandRegistry),
    'Show available commands. Usage: `:ac-help:` or `:ac-help: <command>`',
  );
  commandRegistry.register(
    'classify-intent',
    makeClassifyIntentHandler(intentClassifier),
    'Test how a message would be classified. Usage: `:ac-classify-intent: <message>` or `:ac-classify-intent: <context> <message>`',
  );

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
