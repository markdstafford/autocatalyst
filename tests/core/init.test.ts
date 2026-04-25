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
    expect(isSecret('channels.0.config.bot_token')).toBe(true);
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
    expect(isSecret('publishers.0.config.review_database_id')).toBe(true);
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
    expect(isSecret('channels.0.provider')).toBe(false);
    expect(isSecret('channels.0.name')).toBe(false);
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
    expect(missing).toContain('channels.0.provider');
    expect(missing).toContain('channels.0.name');
  });

  it('returns empty list when all required properties are populated', () => {
    writeWorkflow(
      "workspace:\n  root: /tmp/ws\nchannels:\n  - provider: chat\n    name: product"
    );
    expect(findMissingRequired(tempDir)).toEqual([]);
  });

  it('returns only the missing properties for a partial config', () => {
    writeWorkflow("workspace:\n  root: /tmp/ws\nchannels:\n  - provider: chat\n    name: ''");
    const missing = findMissingRequired(tempDir);
    expect(missing).not.toContain('workspace.root');
    expect(missing).not.toContain('channels.0.provider');
    expect(missing).toContain('channels.0.name');
  });

  it('treats null as unpopulated', () => {
    writeWorkflow("workspace:\n  root: ~\nchannels:\n  - provider: chat\n    name: product");
    expect(findMissingRequired(tempDir)).toContain('workspace.root');
  });

  it('treats placeholder values as unpopulated', () => {
    writeWorkflow("workspace:\n  root: <your-workspace-root>\nchannels:\n  - provider: chat\n    name: product");
    expect(findMissingRequired(tempDir)).toContain('workspace.root');
  });

  it('treats TODO as unpopulated', () => {
    writeWorkflow("workspace:\n  root: TODO\nchannels:\n  - provider: chat\n    name: product");
    expect(findMissingRequired(tempDir)).toContain('workspace.root');
  });

  it('treats ${VAR} references as populated', () => {
    writeWorkflow(
      "workspace:\n  root: /tmp/ws\nchannels:\n  - provider: ${AC_CHANNEL_PROVIDER}\n    name: product"
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
    writeToEnv('AC_PROVIDER_TOKEN', 'secret-value', tempDir);
    const content = readFileSync(join(tempDir, '.env'), 'utf-8');
    expect(content).toContain('AC_PROVIDER_TOKEN=secret-value');
  });

  it('appends key=value when .env exists but key is absent', () => {
    writeFileSync(join(tempDir, '.env'), 'EXISTING_VAR=existing\n', 'utf-8');
    writeToEnv('AC_PROVIDER_TOKEN', 'new-secret', tempDir);
    const content = readFileSync(join(tempDir, '.env'), 'utf-8');
    expect(content).toContain('EXISTING_VAR=existing');
    expect(content).toContain('AC_PROVIDER_TOKEN=new-secret');
  });

  it('replaces in-place when key already exists in .env', () => {
    writeFileSync(join(tempDir, '.env'), 'AC_PROVIDER_TOKEN=old-value\n', 'utf-8');
    writeToEnv('AC_PROVIDER_TOKEN', 'new-value', tempDir);
    const content = readFileSync(join(tempDir, '.env'), 'utf-8');
    expect(content).toContain('AC_PROVIDER_TOKEN=new-value');
    expect(content).not.toContain('old-value');
    // Should not duplicate the key
    expect(content.split('AC_PROVIDER_TOKEN=').length - 1).toBe(1);
  });
});

// ─── writeInlineToWorkflow ────────────────────────────────────────────────

describe('writeInlineToWorkflow', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'init-test-'));
    writeFileSync(
      join(tempDir, 'WORKFLOW.md'),
      "---\nworkspace:\n  root: ''\nchannels:\n  - provider: ''\n    name: ''\n---\n\nTemplate body\n",
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('sets an existing nested property inline', () => {
    writeInlineToWorkflow('channels.0.name', 'product', tempDir);
    const content = readFileSync(join(tempDir, 'WORKFLOW.md'), 'utf-8');
    expect(content).toContain('product');
  });

  it('sets a property to a ${VAR} env reference', () => {
    writeInlineToWorkflow('channels.0.provider', '${AC_CHANNEL_PROVIDER}', tempDir);
    const content = readFileSync(join(tempDir, 'WORKFLOW.md'), 'utf-8');
    expect(content).toContain('${AC_CHANNEL_PROVIDER}');
  });

  it('produces output that parses back correctly via parseWorkflow', () => {
    writeInlineToWorkflow('workspace.root', '/my/workspace', tempDir);
    const content = readFileSync(join(tempDir, 'WORKFLOW.md'), 'utf-8');
    const { config, promptTemplate } = parseWorkflow(content);
    expect((config as Record<string, unknown>)?.['workspace']?.['root']).toBe('/my/workspace');
    expect(promptTemplate).toContain('Template body');
  });

  it('preserves other properties when setting one value', () => {
    writeInlineToWorkflow('channels.0.name', 'product', tempDir);
    // workspace.root should still be present (empty string) not deleted
    const content = readFileSync(join(tempDir, 'WORKFLOW.md'), 'utf-8');
    expect(content).toContain('workspace');
    expect(content).toContain('channels');
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
      '---\nworkspace:\n  root: /tmp/ws\nchannels:\n  - provider: chat\n    name: product\n---\n\nTemplate\n',
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
    writeFileSync(
      join(tempDir, 'WORKFLOW.md'),
      "---\nworkspace:\n  root: /tmp/ws\nchannels:\n  - provider: ''\n    name: ''\n---\n\nTemplate\n",
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes missing required properties inline', async () => {
    await runInit(tempDir, {
      promptFn: async (question) => {
        if (question.includes('channels.0.provider')) return 'chat';
        if (question.includes('channels.0.name')) return 'product';
        return '';
      },
    });

    const wfContent = readFileSync(join(tempDir, 'WORKFLOW.md'), 'utf-8');
    expect(wfContent).toContain('chat');
    expect(wfContent).toContain('product');
    expect(existsSync(join(tempDir, '.env'))).toBe(false);
  });

  it('writes non-secret properties inline to WORKFLOW.md', async () => {
    await runInit(tempDir, {
      promptFn: async (question) => {
        if (question.includes('channels.0.provider')) return 'chat';
        if (question.includes('channels.0.name')) return 'general';
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
    expect(detected?.['count']).toBe(2);
    expect((detected?.['properties'] as string[])).toContain('channels.0.provider');
    expect((detected?.['properties'] as string[])).toContain('channels.0.name');
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
    expect(written.length).toBe(2);
    expect(written.filter((e) => e['destination'] === 'env').length).toBe(0);
    expect(written.filter((e) => e['destination'] === 'inline').length).toBe(2);
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
    const answers = ['Y', '/my/workspace', 'chat', 'product'];
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
    const answers = ['Y', '/my/workspace', 'chat', 'product'];
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
    const answers = ['Y', '/my/workspace', 'chat', 'product'];
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
