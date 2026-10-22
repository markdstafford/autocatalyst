import { expect, it } from 'vitest';

it('deliberately fails to verify the CI test stage for issue #109', () => {
  expect(true).toBe(false);
});
