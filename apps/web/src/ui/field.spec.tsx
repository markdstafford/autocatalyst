/**
 * Field wrapper tests: the label is accessibly associated with the nested control,
 * and the hint is wired as the control's description.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Field } from './field.js';
import { Input } from './input.js';

describe('Field', () => {
  it('associates the label with the nested control', () => {
    render(
      <Field label="Bearer token">
        <Input type="password" />
      </Field>
    );
    // getByLabelText resolves only through an accessible label association.
    expect(screen.getByLabelText('Bearer token')).toBeDefined();
  });

  it('wires the hint as the control description', () => {
    render(
      <Field label="Name" hint="Your full name">
        <Input />
      </Field>
    );
    const input = screen.getByRole('textbox', { name: 'Name' });
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const hint = screen.getByText('Your full name');
    expect(describedBy?.split(/\s+/)).toContain(hint.id);
  });

  it('omits the description when no hint is given', () => {
    render(
      <Field label="Name">
        <Input />
      </Field>
    );
    expect(screen.queryByText('Your full name')).toBeNull();
  });
});
