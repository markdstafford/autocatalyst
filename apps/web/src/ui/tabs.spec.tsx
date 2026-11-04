/**
 * Tabs wrapper tests: role/selection semantics, controlled selection via clicks, and
 * arrow-key movement through the wrapper.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { TabPanel, Tabs, type TabItem } from './tabs.js';

const TABS: readonly TabItem[] = [
  { id: 'one', label: 'One' },
  { id: 'two', label: 'Two' },
  { id: 'three', label: 'Three' }
];

function Harness({ initial = 'one' }: { initial?: string }): ReactNode {
  const [value, setValue] = useState(initial);
  return (
    <Tabs label="Sections" tabs={TABS} value={value} onValueChange={setValue}>
      <TabPanel value="one">Panel one</TabPanel>
      <TabPanel value="two">Panel two</TabPanel>
      <TabPanel value="three">Panel three</TabPanel>
    </Tabs>
  );
}

describe('Tabs wrapper', () => {
  it('renders a named tablist with all tabs and marks the selected one', () => {
    render(<Harness />);
    const list = screen.getByRole('tablist', { name: 'Sections' });
    expect(list).toBeDefined();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['One', 'Two', 'Three']);
    expect(screen.getByRole('tab', { name: 'One' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Two' }).getAttribute('aria-selected')).toBe('false');
  });

  it('selects a tab on click and shows its panel', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByText('Panel one')).toBeDefined();
    await user.click(screen.getByRole('tab', { name: 'Two' }));
    expect(screen.getByRole('tab', { name: 'Two' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Panel two')).toBeDefined();
  });

  it('moves the selection with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: 'One' }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Two' }).getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Three' }).getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Two' }).getAttribute('aria-selected')).toBe('true');
  });
});
