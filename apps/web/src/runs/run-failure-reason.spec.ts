import { expect, it } from 'vitest';

import { formatRunFailureReason } from './run-failure-reason.js';

it('translates only the closed-without-merge failure code', () => {
  expect(formatRunFailureReason('pull_request_closed_without_merge')).toBe('The pull request was closed without merging.');
  expect(formatRunFailureReason('Other stored text <without markup>')).toBe('Other stored text <without markup>');
  expect(formatRunFailureReason(undefined)).toBeUndefined();
});
