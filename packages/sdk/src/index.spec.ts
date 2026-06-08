import { describe, expect, it } from 'vitest';

import { createControlPlaneClient } from './index.js';

describe('sdk barrel', () => {
  it('exports the control-plane client factory', () => {
    expect(createControlPlaneClient).toBeTypeOf('function');
  });
});
