import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const SCANNED_DIRS = ['src/core', 'src/types', 'src/config'];
const FORBIDDEN_TERMS = [
  /\bslack\b/i,
  /\bthread_ts\b/i,
  /\bnotion\b/i,
  /\bgithub\b/i,
  /\bslack_canvas\b/i,
  /\bcanvas\b/i,
  /@anthropic-ai/i,
  /\banthropic\b/i,
  /\bclaude agent sdk\b/i,
  /\bAgentSDK\b/,
  /discussion-urls/i,
];

const ALLOWLIST = new Set<string>();

function sourceFiles(): string[] {
  return SCANNED_DIRS.flatMap(dir =>
    execFileSync('rg', ['--files', dir], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .filter(file => file.endsWith('.ts'))
      .filter(file => !ALLOWLIST.has(file)),
  );
}

describe('provider boundary', () => {
  test('core and shared types do not contain channel, publisher, or issue-provider implementation vocabulary', () => {
    const leaks: string[] = [];

    for (const file of sourceFiles()) {
      const content = readFileSync(join(ROOT, file), 'utf8');
      const lines = content.split('\n');
      for (const [index, line] of lines.entries()) {
        const matchedTerm = FORBIDDEN_TERMS.find(term => term.test(line));
        if (matchedTerm) {
          leaks.push(`${relative(ROOT, join(ROOT, file))}:${index + 1}: ${line.trim()}`);
        }
      }
    }

    expect(leaks).toEqual([]);
  });
});
