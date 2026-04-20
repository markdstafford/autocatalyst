import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { configExists, isSecret, findMissingRequired, writeToEnv, writeInlineToWorkflow, propertyPathToEnvKey, runInit } from '../../src/core/init.js';
import { parseWorkflow } from '../../src/core/config.js';

// ─── isSecret ───────────────────────────────────────────────────────────────

describe('isSecret', () => {
  it('returns true for property names containing "token"', () => {
    expect(isSecret('slack.bot_token')).toBe(true);
    expect(isSecret('app_token')).toBe(true);
  });

  it('returns true for property names containing "key"', () => {
    expect(isSecret('api_key')).toBe(true);
    expect(isSecret('encryption_key')).toBe(true);
  });

  it('returns true for property names containing "secret"', () => {
    expect(isSecret('client_secret')).toBe(true);
  });

  it('returns true for property names containing "id"', () => {
    expect(isSecret('database_id')).toBe(true);
    expect(isSecret('notion.specs_database_id')).toBe(true);
  });

  it('returns true for property names containing "password"', () => {
    expect(isSecret('user_password')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isSecret('BotToken')).toBe(true);
    expect(isSecret('API_KEY')).toBe(true);
    expect(isSecret('DatabaseID')).toBe(true);
  });

  it('returns false for non-secret property names', () => {
    expect(isSecret('channel_name')).toBe(false);
    expect(isSecret('interval_ms')).toBe(false);
    expect(isSecret('aws_profile')).toBe(false);
    expect(isSecret('workspace.root')).toBe(false);
  });
});

// ─── configExists ─────────────────────────────────────────────────────────

describe('configExists', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'init-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns false when WORKFLOW.md does not exist', () => {
    expect(configExists(tempDir)).toBe(false);
  });

  it('returns true when WORKFLOW.md exists', () => {
    writeFileSync(join(tempDir, 'WORKFLOW.md'), '---\n---\n', 'utf-8');
    expect(configExists(tempDir)).toBe(true);
  });
});

// ─── findMissingRequired ──────────────────────────────────────────────────

describe('findMissingRequired', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'init-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeWorkflow(yaml: string): void {
    writeFileSync(join(tempDir, 'WORKFLOW.md'), `---\n${yaml}\n---\n\nTemplate\n`, 'utf-8');
  }

  it('returns all required properties for an empty config', () => {
    writeWorkflow('');
    const missing = findMissingRequired(tempDir);
    expect(missing).toContain('workspace.root');
    expect(missing).toContain('slack.bot_token');
    expect(missing).toContain('slack.app_token');
    expect(missing).toContain('slack.channel_name');
  });

  it('returns empty list when all required properties are populated', () => {
    writeWorkflow(
      "workspace:\n  root: /tmp/ws\nslack:\n  bot_token: xoxb-abc\n  app_token: xapp-abc\n  channel_name: my-channel"
    );
    expect(findMissingRequired(tempDir)).toEqual([]);
  });

  it('returns only the missing properties for a partial config', () => {
    writeWorkflow("workspace:\n  root: /tmp/ws\nslack:\n  bot_token: xoxb-abc\n  app_token: ''\n  channel_name: ''");
    const missing = findMissingRequired(tempDir);
    expect(missing).not.toContain('workspace.root');
    expect(missing).not.toContain('slack.bot_token');
    expect(missing).toContain('slack.app_token');
    expect(missing).toContain('slack.channel_name');
  });

  it('treats null as unpopulated', () => {
    writeWorkflow("workspace:\n  root: ~\nslack:\n  bot_token: xoxb\n  app_token: xapp\n  channel_name: ch");
    expect(findMissingRequired(tempDir)).toContain('workspace.root');
  });

  it('treats placeholder values as unpopulated', () => {
    writeWorkflow("workspace:\n  root: <your-workspace-root>\nslack:\n  bot_token: xoxb\n  app_token: xapp\n  channel_name: ch");
    expect(findMissingRequired(tempDir)).toContain('workspace.root');
  });

  it('treats TODO as unpopulated', () => {
    writeWorkflow("workspace:\n  root: TODO\nslack:\n  bot_token: xoxb\n  app_token: xapp\n  channel_name: ch");
    expect(findMissingRequired(tempDir)).toContain('workspace.root');
  });

  it('treats ${VAR} references as populated', () => {
    writeWorkflow(
      "workspace:\n  root: /tmp/ws\nslack:\n  bot_token: ${AC_SLACK_BOT_TOKEN}\n  app_token: ${AC_SLACK_APP_TOKEN}\n  channel_name: my-channel"
    );
    expect(findMissingRequired(tempDir)).toEqual([]);
  });
});

// ─── writeToEnv ──────────────────────────────────────────────────────────

describe('writeToEnv', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'init-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates .env with key=value when file does not exist', () => {
    writeToEnv('AC_SLACK_BOT_TOKEN', 'xoxb-test', tempDir);
    const content = readFileSync(join(tempDir, '.env'), 'utf-8');
    expect(content).toContain('AC_SLACK_BOT_TOKEN=xoxb-test');
  });

  it('appends key=value when .env exists but key is absent', () => {
    writeFileSync(join(tempDir, '.env'), 'EXISTING_VAR=existing\n', 'utf-8');
    writeToEnv('AC_SLACK_BOT_TOKEN', 'xoxb-new', tempDir);
    const content = readFileSync(join(tempDir, '.env'), 'utf-8');
    expect(content).toContain('EXISTING_VAR=existing');
    expect(content).toContain('AC_SLACK_BOT_TOKEN=xoxb-new');
  });

  it('replaces in-place when key already exists in .env', () => {
    writeFileSync(join(tempDir, '.env'), 'AC_SLACK_BOT_TOKEN=old-value\n', 'utf-8');
    writeToEnv('AC_SLACK_BOT_TOKEN', 'new-value', tempDir);
    const content = readFileSync(join(tempDir, '.env'), 'utf-8');
    expect(content).toContain('AC_SLACK_BOT_TOKEN=new-value');
    expect(content).not.toContain('old-value');
    // Should not duplicate the key
    expect(content.split('AC_SLACK_BOT_TOKEN=').length - 1).toBe(1);
  });
});

// ─── writeInlineToWorkflow ────────────────────────────────────────────────

describe('writeInlineToWorkflow', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'init-test-'));
    writeFileSync(
      join(tempDir, 'WORKFLOW.md'),
      "---\nworkspace:\n  root: ''\nslack:\n  bot_token: ''\n  app_token: ''\n  channel_name: ''\n---\n\nTemplate body\n",
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('sets an existing nested property inline', () => {
    writeInlineToWorkflow('slack.channel_name', 'my-channel', tempDir);
    const content = readFileSync(join(tempDir, 'WORKFLOW.md'), 'utf-8');
    expect(content).toContain('my-channel');
  });

  it('sets a property to a ${VAR} env reference', () => {
    writeInlineToWorkflow('slack.bot_token', '${AC_SLACK_BOT_TOKEN}', tempDir);
    const content = readFileSync(join(tempDir, 'WORKFLOW.md'), 'utf-8');
    expect(content).toContain('${AC_SLACK_BOT_TOKEN}');
  });

  it('produces output that parses back correctly via parseWorkflow', () => {
    writeInlineToWorkflow('workspace.root', '/my/workspace', tempDir);
    const content = readFileSync(join(tempDir, 'WORKFLOW.md'), 'utf-8');
    const { config, promptTemplate } = parseWorkflow(content);
    expect((config as Record<string, unknown>)?.['workspace']?.['root']).toBe('/my/workspace');
    expect(promptTemplate).toContain('Template body');
  });

  it('preserves other properties when setting one value', () => {
    writeInlineToWorkflow('slack.channel_name', 'general', tempDir);
    // workspace.root should still be present (empty string) not deleted
    const content = readFileSync(join(tempDir, 'WORKFLOW.md'), 'utf-8');
    expect(content).toContain('workspace');
    expect(content).toContain('slack');
  });
});

// ─── runInit integration ──────────────────────────────────────────────────

describe('runInit — decline branch', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'init-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates no files when user declines initialization', async () => {
    await runInit(tempDir, { promptFn: async () => 'n' });
    expect(existsSync(join(tempDir, 'WORKFLOW.md'))).toBe(false);
  });

  it('emits init.creation_declined log event', async () => {
    const stream = new PassThrough();
    const events: Record<string, unknown>[] = [];
    stream.on('data', (chunk: Buffer) => {
      try { events.push(JSON.parse(chunk.toString())); } catch {}
    });
    await runInit(tempDir, { promptFn: async () => 'n', logDestination: stream });
    stream.end();
    await new Promise<void>((resolve) => stream.on('finish', resolve));
    expect(events.some((e) => e['event'] === 'init.creation_declined')).toBe(true);
  });
});

describe('runInit — complete config branch', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'init-test-'));
    writeFileSync(
      join(tempDir, 'WORKFLOW.md'),
      '---\nworkspace:\n  root: /tmp/ws\nslack:\n  bot_token: xoxb-abc\n  app_token: xapp-abc\n  channel_name: my-channel\n---\n\nTemplate\n',
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('makes no file writes when config is already complete', async () => {
    const before = readFileSync(join(tempDir, 'WORKFLOW.md'), 'utf-8');
    await runInit(tempDir, { promptFn: async () => { throw new Error('should not prompt'); } });
    const after = readFileSync(join(tempDir, 'WORKFLOW.md'), 'utf-8');
    expect(after).toBe(before);
    expect(existsSync(join(tempDir, '.env'))).toBe(false);
  });

  it('emits init.completed with missing_count: 0', async () => {
    const stream = new PassThrough();
    const events: Record<string, unknown>[] = [];
    stream.on('data', (chunk: Buffer) => {
      try { events.push(JSON.parse(chunk.toString())); } catch {}
    });
    await runInit(tempDir, { promptFn: async () => '', logDestination: stream });
    stream.end();
    await new Promise<void>((resolve) => stream.on('finish', resolve));
    const completed = events.find((e) => e['event'] === 'init.completed');
    expect(completed).toBeDefined();
    expect(completed?.['missing_count']).toBe(0);
  });

  it('emits init.validation_passed', async () => {
    const stream = new PassThrough();
    const events: Record<string, unknown>[] = [];
    stream.on('data', (chunk: Buffer) => {
      try { events.push(JSON.parse(chunk.toString())); } catch {}
    });
    await runInit(tempDir, { promptFn: async () => '', logDestination: stream });
    stream.end();
    await new Promise<void>((resolve) => stream.on('finish', resolve));
    expect(events.some((e) => e['event'] === 'init.validation_passed')).toBe(true);
  });
});

describe('runInit — incomplete config branch', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'init-test-'));
    // workspace.root populated; slack fields empty
    writeFileSync(
      join(tempDir, 'WORKFLOW.md'),
      "---\nworkspace:\n  root: /tmp/ws\nslack:\n  bot_token: ''\n  app_token: ''\n  channel_name: ''\n---\n\nTemplate\n",
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes secret properties to .env and inserts ${VAR} reference in WORKFLOW.md', async () => {
    await runInit(tempDir, {
      promptFn: async (question) => {
        if (question.includes('slack.bot_token')) return 'xoxb-real-token';
        if (question.includes('slack.app_token')) return 'xapp-real-token';
        if (question.includes('channel_name')) return 'my-channel';
        return '';
      },
    });

    const envContent = readFileSync(join(tempDir, '.env'), 'utf-8');
    expect(envContent).toContain('AC_SLACK_BOT_TOKEN=xoxb-real-token');
    expect(envContent).toContain('AC_SLACK_APP_TOKEN=xapp-real-token');

    const wfContent = readFileSync(join(tempDir, 'WORKFLOW.md'), 'utf-8');
    expect(wfContent).toContain('${AC_SLACK_BOT_TOKEN}');
    expect(wfContent).toContain('${AC_SLACK_APP_TOKEN}');
  });

  it('writes non-secret properties inline to WORKFLOW.md', async () => {
    await runInit(tempDir, {
      promptFn: async (question) => {
        if (question.includes('channel_name')) return 'general';
        return 'some-value';
      },
    });

    const wfContent = readFileSync(join(tempDir, 'WORKFLOW.md'), 'utf-8');
    expect(wfContent).toContain('general');
  });

  it('emits init.missing_detected with correct properties and count', async () => {
    const stream = new PassThrough();
    const events: Record<string, unknown>[] = [];
    stream.on('data', (chunk: Buffer) => {
      try { events.push(JSON.parse(chunk.toString())); } catch {}
    });
    await runInit(tempDir, {
      promptFn: async () => 'some-value',
      logDestination: stream,
    });
    stream.end();
    await new Promise<void>((resolve) => stream.on('finish', resolve));
    const detected = events.find((e) => e['event'] === 'init.missing_detected');
    expect(detected).toBeDefined();
    expect(detected?.['count']).toBe(3); // bot_token, app_token, channel_name
    expect((detected?.['properties'] as string[])).toContain('slack.bot_token');
  });

  it('emits init.value_written for each written value with correct destination', async () => {
    const stream = new PassThrough();
    const events: Record<string, unknown>[] = [];
    stream.on('data', (chunk: Buffer) => {
      try { events.push(JSON.parse(chunk.toString())); } catch {}
    });
    await runInit(tempDir, {
      promptFn: async () => 'some-value',
      logDestination: stream,
    });
    stream.end();
    await new Promise<void>((resolve) => stream.on('finish', resolve));
    const written = events.filter((e) => e['event'] === 'init.value_written');
    expect(written.length).toBe(3);
    // bot_token and app_token are secrets → env; channel_name → inline
    expect(written.filter((e) => e['destination'] === 'env').length).toBe(2);
    expect(written.filter((e) => e['destination'] === 'inline').length).toBe(1);
  });

  it('config passes findMissingRequired after all values are written', async () => {
    await runInit(tempDir, { promptFn: async () => 'filled-value' });
    expect(findMissingRequired(tempDir)).toEqual([]);
  });
});

describe('runInit — no config + confirm branch', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'init-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates skeleton, prompts for all required values, writes them', async () => {
    let promptCount = 0;
    // First prompt is Y/n, then one per required property
    const answers = ['Y', '/my/workspace', 'xoxb-bot', 'xapp-app', 'general'];
    await runInit(tempDir, {
      promptFn: async () => answers[promptCount++] ?? '',
    });

    expect(existsSync(join(tempDir, 'WORKFLOW.md'))).toBe(true);
    expect(findMissingRequired(tempDir)).toEqual([]);
  });

  it('emits init.config_created after skeleton creation', async () => {
    const stream = new PassThrough();
    const events: Record<string, unknown>[] = [];
    stream.on('data', (chunk: Buffer) => {
      try { events.push(JSON.parse(chunk.toString())); } catch {}
    });
    let promptCount = 0;
    const answers = ['Y', '/my/workspace', 'xoxb-bot', 'xapp-app', 'general'];
    await runInit(tempDir, {
      promptFn: async () => answers[promptCount++] ?? '',
      logDestination: stream,
    });
    stream.end();
    await new Promise<void>((resolve) => stream.on('finish', resolve));
    expect(events.some((e) => e['event'] === 'init.config_created')).toBe(true);
  });

  it('emits all expected log events', async () => {
    const stream = new PassThrough();
    const events: Record<string, unknown>[] = [];
    stream.on('data', (chunk: Buffer) => {
      try { events.push(JSON.parse(chunk.toString())); } catch {}
    });
    let promptCount = 0;
    const answers = ['Y', '/my/workspace', 'xoxb-bot', 'xapp-app', 'general'];
    await runInit(tempDir, {
      promptFn: async () => answers[promptCount++] ?? '',
      logDestination: stream,
    });
    stream.end();
    await new Promise<void>((resolve) => stream.on('finish', resolve));

    const eventNames = events.map((e) => e['event']);
    expect(eventNames).toContain('init.started');
    expect(eventNames).toContain('init.config_not_found');
    expect(eventNames).toContain('init.config_created');
    expect(eventNames).toContain('init.missing_detected');
    expect(eventNames).toContain('init.value_written');
    expect(eventNames).toContain('init.validation_passed');
    expect(eventNames).toContain('init.completed');
  });
});
