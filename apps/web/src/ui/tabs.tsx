/**
 * The client-owned tabs wrapper around Base UI's `Tabs` parts.
 *
 * App code imports this wrapper and never `@base-ui/react` directly (enforced by the
 * `src/ui/`-only rule and the import-conventions test), the same convention the
 * `Button`, `Tooltip`, and `Dialog` wrappers follow. Styling is token-only.
 *
 * The tab list is controlled through `value`/`onValueChange`. Base UI supplies the
 * roving tab stop and arrow-key movement; with `activateOnFocus` the arrow keys change
 * the active tab, so keyboard movement selects as it moves. A selected tab exposes
 * `aria-selected="true"` (from Base UI) and the design-system selected underline (a 2 px
 * `--color-primary` bottom border); the others are `--color-subtext` and `--color-text`
 * on hover. Tab labels carry no counts.
 */
import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import type { ReactNode } from 'react';

export interface TabItem {
  readonly id: string;
  readonly label: string;
}

export interface TabsProps {
  /** Accessible name for the tab list. */
  readonly label: string;
  /** The tabs, in display order. */
  readonly tabs: readonly TabItem[];
  /** The selected tab id (controlled). */
  readonly value: string;
  onValueChange(value: string): void;
  /** The tab panels, rendered under the list. Use {@link TabPanel} for each. */
  readonly children: ReactNode;
}

const LIST_CLASSES = 'flex items-stretch gap-4 border-b border-border';
const TAB_CLASSES =
  'relative -mb-px cursor-pointer border-b-2 border-transparent bg-transparent px-0.5 pb-2 pt-1 ' +
  'text-sm font-medium text-subtext transition-colors select-none ' +
  'hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus ' +
  'aria-selected:border-primary aria-selected:text-text';

export function Tabs({ label, tabs, value, onValueChange, children }: TabsProps): ReactNode {
  return (
    <BaseTabs.Root
      value={value}
      onValueChange={(next) => {
        if (typeof next === 'string') {
          onValueChange(next);
        }
      }}
    >
      <BaseTabs.List aria-label={label} activateOnFocus className={LIST_CLASSES}>
        {tabs.map((tab) => (
          <BaseTabs.Tab key={tab.id} value={tab.id} className={TAB_CLASSES}>
            {tab.label}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      {children}
    </BaseTabs.Root>
  );
}

export interface TabPanelProps {
  readonly value: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/** A single tab panel, shown when its `value` matches the selected tab. */
export function TabPanel({ value, children, className }: TabPanelProps): ReactNode {
  return (
    <BaseTabs.Panel value={value} className={className ?? ''}>
      {children}
    </BaseTabs.Panel>
  );
}
