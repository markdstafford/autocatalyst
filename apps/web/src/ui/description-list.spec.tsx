/**
 * DescriptionList / DescriptionItem tests: the semantic dl/dt/dd structure, the name/value
 * row layout (a fixed-width name column beside a wrapping value column), the `--text-sm`
 * name and value text, and a forwarded test id on the list.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DescriptionItem, DescriptionList } from './description-list.js';

describe('DescriptionList', () => {
  it('renders a dl with dt/dd item pairs', () => {
    render(
      <DescriptionList data-testid="facts">
        <DescriptionItem label="Step">feature</DescriptionItem>
        <DescriptionItem label="Cost">
          <span data-testid="cost-value">$0.30</span>
        </DescriptionItem>
      </DescriptionList>
    );
    const list = screen.getByTestId('facts');
    expect(list.tagName).toBe('DL');
    const terms = list.querySelectorAll('dt');
    const defs = list.querySelectorAll('dd');
    expect(terms.length).toBe(2);
    expect(defs.length).toBe(2);
    expect(terms[0]?.textContent).toBe('Step');
    expect(defs[0]?.textContent).toBe('feature');
    expect(screen.getByTestId('cost-value').closest('dd')).not.toBeNull();
  });

  it('lays the name and value out as a row with a fixed name column', () => {
    render(
      <DescriptionList>
        <DescriptionItem label="Tokens">1.1K</DescriptionItem>
      </DescriptionList>
    );
    const term = screen.getByText('Tokens');
    expect(term.tagName).toBe('DT');
    // Name column: fixed width from the token, non-shrinking, --text-sm, --color-subtext.
    expect(term.className).toContain('shrink-0');
    expect(term.className).toContain('text-sm');
    expect(term.className).toContain('text-subtext');
    expect(term.getAttribute('style')).toContain('var(--width-description-label)');
    // The row container is a flex row (name beside value), not label-above-value.
    const row = term.parentElement;
    expect(row?.className).toContain('flex');
    expect(row?.className).not.toContain('flex-col');
  });

  it('wraps a long value inside the value column without overlapping the name column', () => {
    const longValue = 'a-very-long-value-that-should-wrap-inside-its-own-column-'.repeat(4);
    render(
      <DescriptionList>
        <DescriptionItem label="Failure">{longValue}</DescriptionItem>
      </DescriptionList>
    );
    const value = screen.getByText(longValue);
    expect(value.tagName).toBe('DD');
    // The value column fills the remaining width, can shrink below its content, wraps, and so
    // never pushes into the fixed name column.
    expect(value.className).toContain('flex-1');
    expect(value.className).toContain('min-w-0');
    expect(value.className).toContain('break-words');
    expect(value.className).toContain('text-sm');
    expect(value.className).toContain('text-text');
  });
});
