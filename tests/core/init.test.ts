import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { configExists, isSecret, findMissingRequired, writeToEnv, writeInlineToWorkflow, propertyPathToEnvKey } from '../../src/core/init.js';
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
