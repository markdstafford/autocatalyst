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

  it('marks the control invalid and links the error message as its description', () => {
    render(
      <Field label="Name" error="Name is required">
        <Input />
      </Field>
    );
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const message = screen.getByText('Name is required');
    expect(message.className).toContain('text-red');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy?.split(/\s+/)).toContain(message.id);
  });

  it('does not mark the control invalid without an error', () => {
    render(
      <Field label="Name">
        <Input />
      </Field>
    );
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByText('Name is required')).toBeNull();
  });

  it('forwards the loading state to the nested control', () => {
    render(
      <Field label="Name" loading>
        <Input />
      </Field>
    );
    const input = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
    expect(input.getAttribute('aria-busy')).toBe('true');
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(false);
  });
});
