import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline';
import { stringify } from 'yaml';
import { parseWorkflow } from './config.js';
import { createLogger } from './logger.js';
import type { DestinationStream } from 'pino';

// ─── Constants ────────────────────────────────────────────────────────────

export const REQUIRED_PROPERTIES = [
  'workspace.root',
  'channels.0.provider',
  'channels.0.name',
] as const;

const SECRET_KEYWORDS = new Set(['token', 'key', 'secret', 'id', 'password']);

// ─── Public types ─────────────────────────────────────────────────────────

export interface InitOptions {
  /** Injectable prompt function for testing. Receives full question string, returns trimmed answer. */
  promptFn?: (question: string) => Promise<string>;
  logDestination?: DestinationStream;
}

// ─── Exported helpers ─────────────────────────────────────────────────────

export function configExists(repoPath: string): boolean {
  return existsSync(join(repoPath, 'WORKFLOW.md'));
}

export function isSecret(propertyPath: string): boolean {
  return propertyPath
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[._-]/)
    .some((part) => SECRET_KEYWORDS.has(part));
}

export function findMissingRequired(repoPath: string): string[] {
  const workflowPath = join(repoPath, 'WORKFLOW.md');
  const content = readFileSync(workflowPath, 'utf-8');
  const { config } = parseWorkflow(content);
  const raw = config as Record<string, unknown>;
  return REQUIRED_PROPERTIES.filter((prop) => isUnpopulated(getByPath(raw, prop)));
}

export function propertyPathToEnvKey(propertyPath: string): string {
  return 'AC_' + propertyPath.replace(/\./g, '_').toUpperCase();
}

export function writeToEnv(key: string, value: string, repoPath: string): void {
  const envPath = join(repoPath, '.env');
  const line = `${key}=${value}`;
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const lines = content.split('\n');
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (idx >= 0) {
      lines[idx] = line;
      writeFileSync(envPath, lines.join('\n'), 'utf-8');
    } else {
      const sep = content.endsWith('\n') ? '' : '\n';
      writeFileSync(envPath, content + sep + line + '\n', 'utf-8');
    }
  } else {
    writeFileSync(envPath, line + '\n', 'utf-8');
  }
}

export function writeInlineToWorkflow(propertyPath: string, value: string, repoPath: string): void {
  const workflowPath = join(repoPath, 'WORKFLOW.md');
  const content = readFileSync(workflowPath, 'utf-8');
  const { config, promptTemplate } = parseWorkflow(content);
  const raw = config as Record<string, unknown>;
  setByPath(raw, propertyPath, value);
  const newYaml = stringify(raw);
  writeFileSync(workflowPath, `---\n${newYaml}---\n\n${promptTemplate}`, 'utf-8');
}

export function printConfigSummary(repoPath: string): void {
  const workflowPath = join(repoPath, 'WORKFLOW.md');
  const content = readFileSync(workflowPath, 'utf-8');
  const { config } = parseWorkflow(content);
  const raw = config as Record<string, unknown>;
  console.log('\nConfiguration summary:');
  for (const prop of REQUIRED_PROPERTIES) {
    const value = getByPath(raw, prop);
    const display = isSecret(prop) ? '***' : String(value ?? '(not set)');
    console.log(`  ${prop}: ${display}`);
  }
  console.log('');
}

// ─── Main entry point ─────────────────────────────────────────────────────

export async function runInit(repoPath: string, options?: InitOptions): Promise<void> {
  const logger = createLogger('init', { destination: options?.logDestination });
  const prompt = options?.promptFn ?? defaultPromptFn;

  logger.info({ event: 'init.started', repo_path: repoPath }, 'Init started');

  if (!configExists(repoPath)) {
    logger.info({ event: 'init.config_not_found', repo_path: repoPath }, 'No WORKFLOW.md found');
    const answer = await prompt('No config found. Initialize this repository for Autocatalyst? [Y/n]: ');
    const confirmed = answer === '' || answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';

    if (!confirmed) {
      logger.info({ event: 'init.creation_declined' }, 'Init declined');
      console.log('To set up manually, create WORKFLOW.md with the required configuration fields.');
      return;
    }

    createSkeleton(repoPath);
    logger.info({ event: 'init.config_created', path: join(repoPath, 'WORKFLOW.md') }, 'Config skeleton created');
  }

  const missing = findMissingRequired(repoPath);
  logger.info(
    { event: 'init.missing_detected', properties: missing, count: missing.length },
    `${missing.length} required properties missing`,
  );

  let writtenCount = 0;

  for (const prop of missing) {
    const envKey = propertyPathToEnvKey(prop);
    const secret = isSecret(prop);
    const questionSuffix = secret
      ? ` (will be stored in .env as ${envKey}, leave blank to set later): `
      : ': ';
    const value = await prompt(`Enter value for ${prop}${questionSuffix}`);

    if (secret) {
      writeToEnv(envKey, value, repoPath);
      writeInlineToWorkflow(prop, `\${${envKey}}`, repoPath);
      logger.info({ event: 'init.value_written', property: prop, destination: 'env' }, `Wrote ${prop} to .env`);
    } else {
      writeInlineToWorkflow(prop, value, repoPath);
      logger.info(
        { event: 'init.value_written', property: prop, destination: 'inline' },
        `Wrote ${prop} inline`,
      );
    }
    writtenCount++;
  }

  const stillMissing = findMissingRequired(repoPath);
  if (stillMissing.length > 0) {
    logger.warn(
      { event: 'init.validation_failed', properties: stillMissing },
      `Validation failed: ${stillMissing.join(', ')} still missing`,
    );
    console.log(`Warning: the following properties are still missing: ${stillMissing.join(', ')}`);
  } else {
    logger.info(
      { event: 'init.validation_passed', property_count: REQUIRED_PROPERTIES.length },
      'All required properties are set',
    );
  }

  printConfigSummary(repoPath);
  logger.info(
    { event: 'init.completed', missing_count: missing.length, written_count: writtenCount },
    'Init completed',
  );
}

// ─── Private helpers ──────────────────────────────────────────────────────

function isUnpopulated(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return true;
    if (/^<[^>]*>$/.test(trimmed)) return true;
    if (trimmed.toUpperCase() === 'TODO') return true;
  }
  return false;
}

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      current[part] === null ||
      current[part] === undefined ||
      typeof current[part] !== 'object'
    ) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function createSkeleton(repoPath: string): void {
  const name = repoPath.split('/').filter(Boolean).pop() ?? 'project';
  const content = `---
workspace:
  root: ''
channels:
  - provider: ''
    name: ''
    config: {}
publishers:
  - provider: ''
    artifacts:
      - artifact
    config: {}
---

You are working on an idea for the ${name} project.

{{ idea.content }}
`;
  writeFileSync(join(repoPath, 'WORKFLOW.md'), content, 'utf-8');
}

function defaultPromptFn(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
