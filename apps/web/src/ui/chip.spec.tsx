/**
 * Chip tests: each tone maps to its token classes, the base styling is token-only
 * (`--text-xs`, `--radius-sm`, no wrap), and a forwarded test id reaches the element.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CHIP_TONE_CLASSES, Chip, type ChipTone } from './chip.js';

describe('Chip', () => {
  it('defaults to the neutral tone', () => {
    render(<Chip data-testid="chip">feature</Chip>);
    const chip = screen.getByTestId('chip');
    expect(chip.className).toContain('border-border');
    expect(chip.className).toContain('text-text');
  });

  it('maps each tone to its token classes', () => {
    const cases: ReadonlyArray<{ tone: ChipTone; includes: readonly string[] }> = [
      { tone: 'neutral', includes: ['border-border', 'text-text'] },
      { tone: 'muted', includes: ['border-border', 'text-subtext'] },
      { tone: 'primary', includes: ['bg-primary', 'text-on-primary', 'font-medium'] },
      { tone: 'green', includes: ['border-border', 'text-green'] },
      { tone: 'red', includes: ['border-border', 'text-red'] }
    ];
    for (const { tone, includes } of cases) {
      render(
        <Chip tone={tone} data-testid={`chip-${tone}`}>
          {tone}
        </Chip>
      );
      const chip = screen.getByTestId(`chip-${tone}`);
      for (const token of includes) {
        expect(chip.className).toContain(token);
      }
      // The exported tone table is the single source of truth.
      expect(chip.className).toContain(CHIP_TONE_CLASSES[tone]);
    }
  });

  it('is token-only base styling: text-xs, rounded-sm, and no wrap', () => {
    render(<Chip data-testid="chip">x</Chip>);
    const chip = screen.getByTestId('chip');
    expect(chip.className).toContain('text-xs');
    expect(chip.className).toContain('rounded-sm');
    expect(chip.className).toContain('whitespace-nowrap');
  });

  it('merges extra classes after the tone classes', () => {
    render(
      <Chip tone="primary" className="ml-2" data-testid="chip">
        x
      </Chip>
    );
    expect(screen.getByTestId('chip').className).toContain('ml-2');
  });
});
