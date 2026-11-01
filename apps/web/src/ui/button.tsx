/**
 * The first client-owned UI wrapper: a token-styled button around Base UI's
 * `Button`.
 *
 * Screens import this wrapper and never `@base-ui/react` directly (enforced by the
 * `src/ui/`-only lint restriction and the import-conventions test). Styling is
 * token-only (semantic Tailwind utilities, never raw color literals) so every
 * variant tracks the active theme.
 *
 * Soft-disable: passing `aria-disabled` keeps the button focusable and hoverable
 * (so an attached tooltip still works) while suppressing activation. This is the
 * state an icon-only button uses while its action is pending. Native `disabled`
 * is still supported for the hard-disabled case.
 */
import { Button as BaseButton } from '@base-ui/react/button';
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactNode
} from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive';
export type ButtonSize = 'control-sm' | 'control-base' | 'control-lg';

type BaseButtonProps = ComponentPropsWithoutRef<typeof BaseButton>;

export interface ButtonProps extends Omit<BaseButtonProps, 'className'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Extra utility classes merged after the variant/size classes. */
  readonly className?: string;
}

const BASE_CLASSES =
  'inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-sm ' +
  'text-base font-medium select-none transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ' +
  'focus-visible:ring-offset-1 focus-visible:ring-offset-background ' +
  'disabled:cursor-not-allowed disabled:opacity-60 ' +
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-60';

const VARIANT_CLASSES: Readonly<Record<ButtonVariant, string>> = {
  primary: 'bg-primary text-on-primary hover:bg-primary/90',
  secondary: 'border border-border bg-surface text-text hover:bg-surface-1',
  destructive: 'bg-red text-on-destructive hover:bg-red/90'
};

const SIZE_CLASSES: Readonly<Record<ButtonSize, string>> = {
  'control-sm': 'h-control-sm px-2 text-sm',
  'control-base': 'h-control-base px-2.5',
  'control-lg': 'h-control-lg px-3 text-md'
};

function classes(variant: ButtonVariant, size: ButtonSize, extra: string | undefined): string {
  return [BASE_CLASSES, VARIANT_CLASSES[variant], SIZE_CLASSES[size], extra]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
}

function isSoftDisabled(value: BaseButtonProps['aria-disabled']): boolean {
  return value === true || value === 'true';
}

type ButtonClickHandler = NonNullable<BaseButtonProps['onClick']>;
type ButtonClickEvent = Parameters<ButtonClickHandler>[0];

export const Button = forwardRef<HTMLElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'control-base', className, onClick, ...rest },
  ref
): ReactNode {
  const softDisabled = isSoftDisabled(rest['aria-disabled']);

  const handleClick = (event: ButtonClickEvent): void => {
    if (softDisabled) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  return (
    <BaseButton
      ref={ref}
      className={classes(variant, size, className)}
      onClick={handleClick}
      {...rest}
    />
  );
});
