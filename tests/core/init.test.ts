import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { configExists, isSecret, findMissingRequired } from '../../src/core/init.js';

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
