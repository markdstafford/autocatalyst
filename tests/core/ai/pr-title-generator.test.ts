import { describe, expect, test } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelPRTitleGenerator } from '../../../src/core/ai/pr-title-generator.js';
import type { DirectModelRunner, DirectModelRunRequest } from '../../../src/types/ai.js';

function fakeRunner(
  textOrFn: string | ((req: DirectModelRunRequest) => string),
): { runner: DirectModelRunner; requests: DirectModelRunRequest[] } {
  const requests: DirectModelRunRequest[] = [];
  const runner: DirectModelRunner = {
    async run(request) {
      requests.push(request);
      return { text: typeof textOrFn === 'function' ? textOrFn(request) : textOrFn };
    },
  };
  return { runner, requests };
}

function extractArtifactSection(prompt: string): string {
  const marker = 'Artifact:\n<<<\n';
  const start = prompt.indexOf(marker) + marker.length;
  const end = prompt.indexOf('\n>>>', start);
  return prompt.slice(start, end);
}

async function withSpec(content: string, run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pr-title-'));
  const path = join(dir, 'spec.md');
  await writeFile(path, content, 'utf8');
  try {
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('ModelPRTitleGenerator', () => {
  test('returns the model-provided title verbatim on happy path', async () => {
    const { runner, requests } = fakeRunner('replace databases.query with dataSources.query');
    const gen = new ModelPRTitleGenerator(runner);
    await withSpec('# Bug: login crash\n\nsome details', async (path) => {
      const title = await gen.generate({
        intent: 'bug',
        spec_path: path,
        impl_summary: 'switched to dataSources.query',
      });
      expect(title).toBe('replace databases.query with dataSources.query');
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].route).toEqual({ task: 'pr.title_generate', intent: 'bug' });
    expect(requests[0].messages[0].content).toContain('Bug: login crash');
    expect(requests[0].messages[0].content).toContain('switched to dataSources.query');
  });

  test('truncates the artifact at the first implementation-heavy heading', async () => {
    const { runner, requests } = fakeRunner('title ok');
    const gen = new ModelPRTitleGenerator(runner);
    const body = [
      '# Enhancement: @-reference files',
      '',
      '## What',
      'allow @foo references',
      '',
      '## Design changes',
      'INCLUDE-NOTHING-AFTER-THIS',
    ].join('\n');
    await withSpec(body, async (path) => {
      await gen.generate({ intent: 'idea', spec_path: path, impl_summary: undefined });
    });
    const promptContent = requests[0].messages[0].content;
    expect(promptContent).toContain('## What');
    expect(promptContent).not.toContain('INCLUDE-NOTHING-AFTER-THIS');
  });

  test('falls back to a character cap when no implementation heading is present', async () => {
    const { runner, requests } = fakeRunner('title ok');
    const gen = new ModelPRTitleGenerator(runner);
    const long = 'x'.repeat(5000);
    await withSpec(long, async (path) => {
      await gen.generate({ intent: 'bug', spec_path: path, impl_summary: undefined });
    });
    const artifactSection = extractArtifactSection(requests[0].messages[0].content);
    expect(artifactSection.length).toBeLessThanOrEqual(3000);
  });

  test('strips surrounding quotes, backticks, and trailing period', async () => {
    for (const raw of ['"fix the thing"', "'fix the thing'", '`fix the thing`', 'fix the thing.', '   fix the thing   ']) {
      const { runner } = fakeRunner(raw);
      const gen = new ModelPRTitleGenerator(runner);
      await withSpec('# x', async (path) => {
        const title = await gen.generate({ intent: 'bug', spec_path: path, impl_summary: undefined });
        expect(title).toBe('fix the thing');
      });
    }
  });

  test('takes only the first line if model returns multiple lines', async () => {
    const { runner } = fakeRunner('fix the thing\nextra commentary');
    const gen = new ModelPRTitleGenerator(runner);
    await withSpec('# x', async (path) => {
      const title = await gen.generate({ intent: 'bug', spec_path: path, impl_summary: undefined });
      expect(title).toBe('fix the thing');
    });
  });

  test('rejects empty, whitespace-only, or over-length titles', async () => {
    for (const raw of ['', '   ', 'x'.repeat(101)]) {
      const { runner } = fakeRunner(raw);
      const gen = new ModelPRTitleGenerator(runner);
      await withSpec('# x', async (path) => {
        const title = await gen.generate({ intent: 'bug', spec_path: path, impl_summary: undefined });
        expect(title).toBeNull();
      });
    }
  });
});
