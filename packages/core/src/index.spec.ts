import { describe, expect, it } from 'vitest';

import {
  buildProviderAdapterKey,
  composeConfiguredProviders,
  createExtensionRegistryCatalog,
  createProbeResource,
  defaultExtensionRegistryCatalog,
  emptyProviderAdapterMap,
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

  it('exports provider composition behavior', () => {
    expect(buildProviderAdapterKey('model_runner', 'fake')).toBe(JSON.stringify(['model_runner', 'fake']));
    expect(emptyProviderAdapterMap.size).toBe(0);
    expect(composeConfiguredProviders).toBeTypeOf('function');
  });
});
