import { describe, expect, it } from 'vitest';

import { createProbeResource, getHealth } from './index.js';

describe('core barrel', () => {
  it('exports core service behavior', () => {
    expect(getHealth).toBeTypeOf('function');
    expect(createProbeResource).toBeTypeOf('function');
  });
});
