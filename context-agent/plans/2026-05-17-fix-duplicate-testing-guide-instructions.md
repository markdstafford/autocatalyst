# Fix Duplicate Testing Guide Instructions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent repeated setup/test boilerplate variants from accumulating in the Notion testing guide's `## Testing instructions` section across implementation-feedback cycles.

**Architecture:** Add a `normalizeStep` helper (strips backticks, collapses whitespace, normalizes trailing slashes) and a `getBaselineCategory` classifier (identifies `cd`, `npm_install`, `test_command` singletons) in `implementation-feedback-page.ts`. Use both in `update()` so that normalized near-duplicates and same-category baseline steps are skipped. Adjust the feedback-pass prompt in `agent-services.ts` to instruct agents to return only net-new testing steps on feedback runs.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Add normalizeStep helper and getBaselineCategory classifier with tests

**Files:**
- Modify: `src/adapters/notion/implementation-feedback-page.ts` (add two module-level helpers before `escapeRegex`)
- Test: `tests/adapters/notion/implementation-feedback-page.test.ts`

The helpers to add at the bottom of `implementation-feedback-page.ts` (just before the existing `escapeRegex` function at line 457):

```typescript
function normalizeStep(step: string): string {
  // Strip surrounding backticks
  let s = step.replace(/^`+|`+$/g, '');
  // Trim and collapse internal whitespace
  s = s.trim().replace(/\s+/g, ' ');
  // Remove trailing slash from cd paths
  s = s.replace(/^(cd\s+\S.*?)\/$/, '$1');
  return s;
}

type BaselineCategory = 'cd' | 'npm_install' | 'test_command';

function getBaselineCategory(step: string): BaselineCategory | null {
  const s = normalizeStep(step).toLowerCase();
  if (/^cd\s+/.test(s)) return 'cd';
  if (/^(npm\s+ci|npm\s+install|yarn\s+install|pnpm\s+install)\b/.test(s)) return 'npm_install';
  if (/^(npm\s+test|npx\s+vitest|npx\s+jest|yarn\s+test)\b/.test(s)) return 'test_command';
  return null;
}
```

- [ ] **Step 1: Write failing tests for normalizeStep and getBaselineCategory**

Add a new `describe` block at the end of `tests/adapters/notion/implementation-feedback-page.test.ts` (after the last closing `}`):

```typescript
describe('normalizeStep (via update deduplication behavior)', () => {
  // We test normalizeStep indirectly by calling update() with variants that should be treated as duplicates

  function makeUpdateClient(existingSteps: string[]) {
    const existingLines = existingSteps.map(s => `- [ ] ${s}`).join('\n');
    const markdown = [
      '## Testing instructions',
      '',
      existingLines,
      '',
      '## Additional steps',
      '',
      '- [ ] Add any extra testing steps here.',
      '',
      '## Feedback',
      '',
    ].join('\n');
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue(markdown);
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList: vi.fn().mockResolvedValue({ results: [] }) });
    return { client, pagesUpdateMarkdown };
  }

  it('treats "cd /workspace/" as duplicate of existing "cd /workspace" (trailing slash)', async () => {
    const { client, pagesUpdateMarkdown } = makeUpdateClient(['cd /workspace', 'npm install']);
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    await page.update('page-id', { testing_steps: ['cd /workspace/', 'npm install'] });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect((updated.match(/cd \/workspace/g) ?? []).length).toBe(1);
  });

  it('treats "`cd /workspace`" as duplicate of existing "cd /workspace" (backticks)', async () => {
    const { client, pagesUpdateMarkdown } = makeUpdateClient(['cd /workspace']);
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    await page.update('page-id', { testing_steps: ['`cd /workspace`'] });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect((updated.match(/cd \/workspace/g) ?? []).length).toBe(1);
  });

  it('treats "npm test " as duplicate of existing "npm test" (trailing whitespace)', async () => {
    const { client, pagesUpdateMarkdown } = makeUpdateClient(['npm test']);
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    await page.update('page-id', { testing_steps: ['npm test '] });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect((updated.match(/npm test/g) ?? []).length).toBe(1);
  });

  it('skips a new cd step when a different cd step already exists (baseline singleton)', async () => {
    const { client, pagesUpdateMarkdown } = makeUpdateClient(['cd /workspace/project', 'npm install']);
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    // Agent returns a slightly different path (e.g., trailing slash variant)
    await page.update('page-id', { testing_steps: ['cd /workspace/project/', 'npm install', 'npm test'] });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    // cd step should appear only once
    expect((updated.match(/cd\s+\/workspace/g) ?? []).length).toBe(1);
    // npm install should appear only once
    expect((updated.match(/npm install/g) ?? []).length).toBe(1);
    // npm test is new, should be appended
    expect(updated).toContain('npm test');
  });

  it('skips npm install when an equivalent npm ci step already exists (same baseline category)', async () => {
    const { client, pagesUpdateMarkdown } = makeUpdateClient(['cd /workspace', 'npm ci']);
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    await page.update('page-id', { testing_steps: ['cd /workspace', 'npm install', 'npm test'] });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    // Neither npm install nor duplicate npm ci should appear
    const installCount = (updated.match(/npm\s+(install|ci)/g) ?? []).length;
    expect(installCount).toBe(1);
    // npm test is new
    expect(updated).toContain('npm test');
  });

  it('feedback update with no genuinely new steps leaves the Testing instructions section unchanged', async () => {
    const { client, pagesUpdateMarkdown } = makeUpdateClient(['cd /workspace', 'npm install', 'npm test']);
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    await page.update('page-id', { testing_steps: ['cd /workspace', 'npm install', 'npm test'] });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect((updated.match(/cd \/workspace/g) ?? []).length).toBe(1);
    expect((updated.match(/npm install/g) ?? []).length).toBe(1);
    expect((updated.match(/npm test/g) ?? []).length).toBe(1);
  });

  it('feedback update with only baseline boilerplate appends nothing new', async () => {
    const { client, pagesUpdateMarkdown } = makeUpdateClient(['cd /workspace', 'npm install']);
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    await page.update('page-id', { testing_steps: ['cd /workspace/', 'npm install'] });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    // The Testing instructions section should have exactly the original two steps
    const todoMatches = updated.match(/^- \[[ x]\] /gm) ?? [];
    // 2 testing instruction todos + 1 Additional steps placeholder
    expect(todoMatches.length).toBe(3);
  });

  it('appends one new round-specific test step while preserving existing checked to-dos', async () => {
    const markdown = [
      '## Testing instructions',
      '',
      '- [x] cd /workspace',
      '- [x] npm install',
      '- [ ] npm test',
      '',
      '## Additional steps',
      '',
      '- [ ] Add any extra testing steps here.',
      '',
      '## Feedback',
      '',
    ].join('\n');
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue(markdown);
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList: vi.fn().mockResolvedValue({ results: [] }) });
    const page = new NotionImplementationFeedbackPage(client, 'db-id', { logDestination: nullDest });

    await page.update('page-id', {
      testing_steps: ['cd /workspace', 'npm install', 'npm test', 'Open http://localhost:3000 and verify the widget appears'],
    });

    const updated = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    // Checked steps preserved
    expect(updated).toContain('- [x] cd /workspace');
    expect(updated).toContain('- [x] npm install');
    // npm test already present, not duplicated
    expect((updated.match(/npm test/g) ?? []).length).toBe(1);
    // New step appended
    expect(updated).toContain('Open http://localhost:3000 and verify the widget appears');
    // New step is before Additional steps
    const newStepIdx = updated.indexOf('Open http://localhost:3000');
    const additionalIdx = updated.indexOf('## Additional steps');
    expect(newStepIdx).toBeLessThan(additionalIdx);
  });
});
```

- [ ] **Step 2: Run new tests to confirm they fail**

```bash
cd /Users/mark.stafford/.autocatalyst/workspaces/autocatalyst/e11ec939-fb6b-493a-a2db-4300668dae34
npx vitest run tests/adapters/notion/implementation-feedback-page.test.ts 2>&1 | tail -30
```

Expected: Several tests in the `normalizeStep` describe block fail (functions not yet implemented / dedup not using normalization).

- [ ] **Step 3: Add normalizeStep and getBaselineCategory helpers to implementation-feedback-page.ts**

In `src/adapters/notion/implementation-feedback-page.ts`, add the following just before the existing `function escapeRegex` at line 457:

```typescript
function normalizeStep(step: string): string {
  // Strip surrounding backticks
  let s = step.replace(/^`+|`+$/g, '');
  // Trim and collapse internal whitespace
  s = s.trim().replace(/\s+/g, ' ');
  // Remove trailing slash from cd paths
  s = s.replace(/^(cd\s+\S.*?)\/$/, '$1');
  return s;
}

type BaselineCategory = 'cd' | 'npm_install' | 'test_command';

function getBaselineCategory(step: string): BaselineCategory | null {
  const s = normalizeStep(step).toLowerCase();
  if (/^cd\s+/.test(s)) return 'cd';
  if (/^(npm\s+ci|npm\s+install|yarn\s+install|pnpm\s+install)\b/.test(s)) return 'npm_install';
  if (/^(npm\s+test|npx\s+vitest|npx\s+jest|yarn\s+test)\b/.test(s)) return 'test_command';
  return null;
}
```

- [ ] **Step 4: Update the deduplication logic in update() to use normalizeStep and getBaselineCategory**

In `src/adapters/notion/implementation-feedback-page.ts`, replace lines 372–378 (the `existingItemsText` / `existingSet` / `newSteps` block) with:

Old code (lines 372–378):
```typescript
      const existingItemsText = testingMatch
        ? (testingMatch[1].match(/^- \[[ x]\] .+/gm) ?? []).map(item => item.replace(/^- \[[ x]\] /, '').toLowerCase())
        : [];
      const existingSet = new Set(existingItemsText);

      const newSteps = options.testing_steps.filter(step => !existingSet.has(step.toLowerCase()));
```

New code:
```typescript
      const existingItemsRaw = testingMatch
        ? (testingMatch[1].match(/^- \[[ x]\] .+/gm) ?? []).map(item => item.replace(/^- \[[ x]\] /, ''))
        : [];
      const existingSet = new Set(existingItemsRaw.map(item => normalizeStep(item).toLowerCase()));
      const existingBaselineCategories = new Set(
        existingItemsRaw
          .map(item => getBaselineCategory(item))
          .filter((c): c is BaselineCategory => c !== null),
      );

      const newSteps = options.testing_steps.filter(step => {
        const normalizedLower = normalizeStep(step).toLowerCase();
        if (existingSet.has(normalizedLower)) return false;
        const category = getBaselineCategory(step);
        if (category !== null && existingBaselineCategories.has(category)) return false;
        return true;
      });
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd /Users/mark.stafford/.autocatalyst/workspaces/autocatalyst/e11ec939-fb6b-493a-a2db-4300668dae34
npx vitest run tests/adapters/notion/implementation-feedback-page.test.ts 2>&1 | tail -20
```

Expected: All tests pass (including the new `normalizeStep` describe block).

- [ ] **Step 6: Commit**

```bash
cd /Users/mark.stafford/.autocatalyst/workspaces/autocatalyst/e11ec939-fb6b-493a-a2db-4300668dae34
git add src/adapters/notion/implementation-feedback-page.ts tests/adapters/notion/implementation-feedback-page.test.ts
git commit -m "fix: normalize testing step deduplication to prevent near-duplicate accumulation"
```

---

### Task 2: Adjust feedback-pass prompt in agent-services.ts

**Files:**
- Modify: `src/core/ai/agent-services.ts` (lines 898–900, the Rules block in `buildImplementationPrompt`)
- Test: `tests/core/ai/agent-services.test.ts`

- [ ] **Step 1: Write failing test for feedback-pass prompt testing_steps instruction**

Add the following test to `tests/core/ai/agent-services.test.ts` inside the existing implementation tests describe block (after the `'feedback implementation prompt instructs agent to preserve feedback IDs exactly'` test around line 578):

```typescript
  test('feedback implementation prompt tells agent to include only net-new testing steps', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-feedback-delta-steps-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ status: 'complete', summary: 'Done' }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());
      const feedbackContext = '[FEEDBACK_ID: block-1]\nFix the crash';

      await service.implement('/tmp/spec.md', workspace, feedbackContext);

      const prompt = calls[0].prompt;
      // Feedback-pass prompt should NOT say testing_steps must start with cd
      expect(prompt).not.toMatch(/testing_steps must start with a `cd `/);
      // Instead it should say to include only net-new steps
      expect(prompt).toMatch(/net.new|only.*new.*step|omit.*setup|setup.*already/i);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('initial implementation prompt still instructs testing_steps to start with cd step', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-initial-cd-step-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ status: 'complete', summary: 'Done' }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      await service.implement('/tmp/spec.md', workspace);

      expect(calls[0].prompt).toContain('testing_steps must start with a `cd `');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run new tests to confirm they fail**

```bash
cd /Users/mark.stafford/.autocatalyst/workspaces/autocatalyst/e11ec939-fb6b-493a-a2db-4300668dae34
npx vitest run tests/core/ai/agent-services.test.ts 2>&1 | tail -20
```

Expected: The two new tests fail (prompt still has unconditional "testing_steps must start with cd" rule).

- [ ] **Step 3: Update buildImplementationPrompt to make the testing_steps rule conditional**

In `src/core/ai/agent-services.ts`, replace line 900:

Old:
```typescript
  lines.push('- testing_steps must start with a `cd ` step when a workspace path is available.');
```

New (conditional on whether this is a feedback pass):
```typescript
  if (hasFeedbackContext) {
    lines.push('- testing_steps should contain only net-new steps introduced by the changes in this feedback cycle.');
    lines.push('  Omit setup steps such as `cd /workspace` and `npm install` that are already in the testing guide baseline.');
    lines.push('  Include a baseline step only if the correct setup command has genuinely changed.');
  } else {
    lines.push('- testing_steps must start with a `cd ` step when a workspace path is available.');
  }
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /Users/mark.stafford/.autocatalyst/workspaces/autocatalyst/e11ec939-fb6b-493a-a2db-4300668dae34
npx vitest run tests/core/ai/agent-services.test.ts 2>&1 | tail -20
```

Expected: All tests pass, including the two new tests.

- [ ] **Step 5: Run full test suite to confirm no regressions**

```bash
cd /Users/mark.stafford/.autocatalyst/workspaces/autocatalyst/e11ec939-fb6b-493a-a2db-4300668dae34
npx vitest run tests/adapters/notion/implementation-feedback-page.test.ts tests/core/handlers/implementation-feedback-handler.test.ts tests/core/ai/agent-services.test.ts 2>&1 | tail -20
```

Expected: All 3 test files pass.

- [ ] **Step 6: Run lint**

```bash
cd /Users/mark.stafford/.autocatalyst/workspaces/autocatalyst/e11ec939-fb6b-493a-a2db-4300668dae34
npm run lint 2>&1 | tail -10
```

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/mark.stafford/.autocatalyst/workspaces/autocatalyst/e11ec939-fb6b-493a-a2db-4300668dae34
git add src/core/ai/agent-services.ts tests/core/ai/agent-services.test.ts
git commit -m "fix: feedback-pass prompt instructs agent to return only net-new testing steps"
```
