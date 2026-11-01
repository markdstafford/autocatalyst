/**
 * Tooltip wrapper tests: label composition (`label` and `label (key)`), that the
 * trigger renders the composed child as an accessible button, and that hovering
 * reveals the tooltip text.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Button } from './button.js';
import { Tooltip, formatTooltipLabel } from './tooltip.js';

describe('formatTooltipLabel', () => {
  it('returns the plain label with no key', () => {
    expect(formatTooltipLabel('Check connection')).toBe('Check connection');
  });

  it('appends the key as "label (key)"', () => {
    expect(formatTooltipLabel('Save', 'S')).toBe('Save (S)');
  });

  it('ignores an empty key', () => {
    expect(formatTooltipLabel('Save', '')).toBe('Save');
  });
});

describe('Tooltip', () => {
  it('renders the composed trigger as a button', () => {
    render(
      <Tooltip label="Check connection">
        <Button aria-label="Check connection">icon</Button>
      </Tooltip>
    );
    expect(screen.getByRole('button', { name: 'Check connection' })).toBeDefined();
  });

  it('reveals the label on hover', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Save" keyHint="S" delay={0}>
        <Button aria-label="Save">icon</Button>
      </Tooltip>
    );

    await user.hover(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Save (S)')).toBeDefined();
  });
});
