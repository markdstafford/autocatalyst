/**
 * DescriptionList / DescriptionItem tests: semantic dl/dt/dd structure, the
 * label-above-value content, and a forwarded test id on the list.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DescriptionItem, DescriptionList } from './description-list.js';

describe('DescriptionList', () => {
  it('renders a dl with dt/dd item pairs', () => {
    render(
      <DescriptionList data-testid="facts">
        <DescriptionItem label="Work kind">feature</DescriptionItem>
        <DescriptionItem label="State">
          <span data-testid="state-value">In progress</span>
        </DescriptionItem>
      </DescriptionList>
    );
    const list = screen.getByTestId('facts');
    expect(list.tagName).toBe('DL');
    const terms = list.querySelectorAll('dt');
    const defs = list.querySelectorAll('dd');
    expect(terms.length).toBe(2);
    expect(defs.length).toBe(2);
    expect(terms[0]?.textContent).toBe('Work kind');
    expect(defs[0]?.textContent).toBe('feature');
    expect(screen.getByTestId('state-value').closest('dd')).not.toBeNull();
  });

  it('places the label above the value', () => {
    render(
      <DescriptionList>
        <DescriptionItem label="Tokens">1.1K</DescriptionItem>
      </DescriptionList>
    );
    const term = screen.getByText('Tokens');
    expect(term.tagName).toBe('DT');
    expect(term.className).toContain('text-subtext');
  });
});
