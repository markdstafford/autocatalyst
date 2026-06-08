import { describe, expect, it } from 'vitest';

import {
  createExtensionRegistryCatalog,
  createProbeResource,
  defaultExtensionRegistryCatalog,
  getHealth,
  validateProviderConfigurationAgainstRegistry
} from './index.js';

describe('core barrel', () => {
  it('exports core service behavior', () => {
    expect(getHealth).toBeTypeOf('function');
    expect(createProbeResource).toBeTypeOf('function');
  });

  it('exports extension registry behavior', () => {
    expect(createExtensionRegistryCatalog).toBeTypeOf('function');
    expect(defaultExtensionRegistryCatalog.list()).toEqual([]);
    expect(validateProviderConfigurationAgainstRegistry).toBeTypeOf('function');
  });
});
