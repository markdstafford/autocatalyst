import { describe, expect, it } from 'vitest';

import { createControlPlaneClient } from './index.js';
import type { RunEventsResponse, RunEventsStreamOptions } from './index.js';

describe('sdk barrel', () => {
  it('exports the control-plane client factory', () => {
    expect(createControlPlaneClient).toBeTypeOf('function');
  });

  it('exports RunEventsStreamOptions and RunEventsResponse types', () => {
    // Type-level check: these imports should not cause type errors
    const _options: RunEventsStreamOptions = { lastEventId: 'evt_1' };
    const _response: RunEventsResponse = { kind: 'response', response: new Response() };
    expect(_options.lastEventId).toBe('evt_1');
    expect(_response.kind).toBe('response');
  });
});
