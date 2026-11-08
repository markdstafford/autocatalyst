/**
 * The component gallery registry — the one pure list of gallery entries.
 *
 * Each entry's `id` is the basename (without extension) of a file in
 * `apps/web/src/ui/`, so a completeness test can compare this list against the real
 * `ui/` directory and fail — naming the missing file — when a new component ships
 * without a gallery entry. This module is deliberately free of JSX, React, and DOM
 * access so it can be imported from a Node-environment test; the gallery page
 * (`components-gallery.tsx`) owns the render thunk for each id.
 */

/** One gallery entry. `id` matches a `ui/` file basename (for the completeness test). */
export interface GalleryEntry {
  /** The `ui/` file basename, e.g. `chip` for `ui/chip.tsx`. */
  readonly id: string;
  /** The section heading shown in the gallery. */
  readonly title: string;
  /** One line describing what the section demonstrates. */
  readonly description: string;
  /** Whether the component wraps Base UI or is a custom `ui/` component. */
  readonly kind: 'base-ui-wrapper' | 'custom';
}

/**
 * Every `ui/` component, in gallery display order. Custom components first (the ones
 * this feature adds and the keyboard-display set), then the Base UI wrappers. The id of
 * each entry equals a non-spec file basename under `apps/web/src/ui/`.
 */
export const GALLERY_ENTRIES: readonly GalleryEntry[] = [
  {
    id: 'resize-handle',
    title: 'Resize handle',
    description: 'Vertical and horizontal separators with keyboard and pointer resizing.',
    kind: 'custom'
  },
  {
    id: 'chip',
    title: 'Chip',
    description: 'Non-interactive label in every tone.',
    kind: 'custom'
  },
  {
    id: 'empty-state',
    title: 'Empty state',
    description: 'Centered title, one message line, and an optional single action.',
    kind: 'custom'
  },
  {
    id: 'description-list',
    title: 'Description list',
    description: 'Semantic dl / dt / dd label-above-value pairs.',
    kind: 'custom'
  },
  {
    id: 'shortcut',
    title: 'Keyboard shortcut',
    description: 'Key caps for a combo, a sequence, and alternates, on macOS and other platforms.',
    kind: 'custom'
  },
  {
    id: 'textarea',
    title: 'Textarea',
    description: 'Multi-line text input sharing the form-input tokens, in default and error states.',
    kind: 'custom'
  },
  {
    id: 'button',
    title: 'Button',
    description: 'Primary, secondary, and destructive variants across sizes and disabled states.',
    kind: 'base-ui-wrapper'
  },
  {
    id: 'field',
    title: 'Field',
    description: 'Labelled control with an optional hint.',
    kind: 'base-ui-wrapper'
  },
  {
    id: 'input',
    title: 'Input',
    description: 'Text input in default, filled, and disabled states.',
    kind: 'base-ui-wrapper'
  },
  {
    id: 'write-only-secret-field',
    title: 'Write-only secret field',
    description: 'Password field whose label changes when a secret is already stored.',
    kind: 'base-ui-wrapper'
  },
  {
    id: 'tabs',
    title: 'Tabs',
    description: 'Controlled tab list with arrow-key activation.',
    kind: 'base-ui-wrapper'
  },
  {
    id: 'dialog',
    title: 'Dialog',
    description: 'Modal dialog opened from a trigger button.',
    kind: 'base-ui-wrapper'
  },
  {
    id: 'tooltip',
    title: 'Tooltip',
    description: 'Hover/focus tooltip attached to a button.',
    kind: 'base-ui-wrapper'
  }
];

/** The set of entry ids, for quick membership checks in the completeness test. */
export const GALLERY_ENTRY_IDS: readonly string[] = GALLERY_ENTRIES.map((entry) => entry.id);
