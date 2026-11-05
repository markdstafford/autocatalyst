/**
 * Kbd / Shortcut / ShortcutList tests, driven by scripted bindings:
 * - a combo renders one cap with platform-aware text and an accessible name;
 * - a sequence renders a cap per step with a "then" separator and a "g then r" name;
 * - an alternate list separates bindings with "or" and honours `limit`;
 * - macOS and non-macOS caps differ.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Binding } from '../shell/key-utils.js';
import { Kbd, Shortcut, ShortcutList, bindingAccessibleName } from './shortcut.js';

const SETTINGS: Binding = [{ key: ',', mod: 'mod' }];
const SEQUENCE: Binding = [{ key: 'g' }, { key: 'r' }];
const J: Binding = [{ key: 'j' }];
const ARROW_DOWN: Binding = [{ key: 'ArrowDown' }];

describe('Kbd', () => {
  it('renders one cap with the design-system cap styling', () => {
    render(<Kbd>⌘</Kbd>);
    const cap = screen.getByText('⌘');
    expect(cap.tagName).toBe('KBD');
    expect(cap.className).toContain('font-mono');
    expect(cap.className).toContain('text-xs');
    expect(cap.className).toContain('border-border');
  });
});

describe('Shortcut combo', () => {
  it('renders the macOS glyph cap and accessible name', () => {
    const { container } = render(<Shortcut binding={SETTINGS} platform="mac" />);
    expect(screen.getByText('⌘,')).toBeDefined();
    expect(container.querySelector('[aria-label="⌘,"]')).not.toBeNull();
  });

  it('spells the modifier on other platforms', () => {
    render(<Shortcut binding={SETTINGS} platform="other" />);
    expect(screen.getByText('Ctrl+,')).toBeDefined();
    expect(bindingAccessibleName(SETTINGS, 'other')).toBe('Ctrl+,');
  });
});

describe('Shortcut sequence', () => {
  it('renders a cap per step with a then separator and a sequence accessible name', () => {
    const { container } = render(<Shortcut binding={SEQUENCE} platform="other" />);
    expect(screen.getByText('g')).toBeDefined();
    expect(screen.getByText('r')).toBeDefined();
    expect(screen.getByText('then')).toBeDefined();
    expect(container.querySelector('[aria-label="g then r"]')).not.toBeNull();
    expect(bindingAccessibleName(SEQUENCE, 'other')).toBe('g then r');
  });
});

describe('ShortcutList alternates', () => {
  it('separates alternates with "or" and shows all by default', () => {
    render(<ShortcutList bindings={[J, ARROW_DOWN]} platform="other" />);
    expect(screen.getByText('j')).toBeDefined();
    expect(screen.getByText('↓')).toBeDefined();
    expect(screen.getByText('or')).toBeDefined();
  });

  it('honours a limit so tooltips/menus show only the first binding', () => {
    render(<ShortcutList bindings={[J, ARROW_DOWN]} platform="other" limit={1} />);
    expect(screen.getByText('j')).toBeDefined();
    expect(screen.queryByText('↓')).toBeNull();
    expect(screen.queryByText('or')).toBeNull();
  });

  it('renders macOS and non-macOS caps differently for the same binding', () => {
    const mac = render(<ShortcutList bindings={[SETTINGS]} platform="mac" />);
    expect(within(mac.container).getByText('⌘,')).toBeDefined();
    mac.unmount();
    const other = render(<ShortcutList bindings={[SETTINGS]} platform="other" />);
    expect(within(other.container).getByText('Ctrl+,')).toBeDefined();
  });
});
