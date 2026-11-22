import { Select as BaseSelect } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

import { Field } from './field.js';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

interface SelectProps {
  readonly label: string;
  readonly options: readonly SelectOption[];
  readonly value: string;
  onValueChange(value: string): void;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly error?: string | undefined;
  readonly placeholder?: string;
  readonly describedBy?: string | undefined;
  readonly triggerRef?: React.Ref<HTMLButtonElement>;
}

/** Labelled, token-styled single selection. Base UI owns focus and keyboard behavior. */
export function Select({
  label, options, value, onValueChange, required = false, disabled = false, error, placeholder, describedBy, triggerRef
}: SelectProps): ReactNode {
  return (
    <Field label={label} {...(error !== undefined ? { error } : {})}>
      <BaseSelect.Root
        items={[...options]}
        value={value || null}
        required={required}
        disabled={disabled}
        onValueChange={(next) => { if (next !== null) onValueChange(next); }}
      >
        <BaseSelect.Trigger ref={triggerRef} {...(describedBy !== undefined ? { 'aria-describedby': describedBy } : {})} className="flex h-control-base w-full items-center justify-between gap-2 rounded-sm border border-border bg-background px-2 text-sm text-text data-[invalid]:border-red focus:outline-none focus:ring-2 focus:ring-focus disabled:opacity-60">
          <BaseSelect.Value className="truncate" placeholder={placeholder} />
          <BaseSelect.Icon><ChevronDown aria-hidden size={14} /></BaseSelect.Icon>
        </BaseSelect.Trigger>
        <BaseSelect.Portal>
          <BaseSelect.Positioner alignItemWithTrigger={false} sideOffset={4} className="z-50">
            <BaseSelect.Popup className="max-h-[var(--available-height)] min-w-[var(--anchor-width)] overflow-auto rounded-sm border border-border bg-surface p-1 text-sm text-text shadow-popover">
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  className="flex h-control-base cursor-default items-center justify-between gap-2 rounded-sm px-2 data-[highlighted]:bg-hover"
                >
                  <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator><Check aria-hidden size={14} /></BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
    </Field>
  );
}
