/**
 * The development-only component gallery rendered at `/dev/components`.
 *
 * It lists every `ui/` component across useful states so a developer or designer can
 * review them in one place, without a run scenario, a bearer token, or any control-plane
 * call. A toolbar switches theme mode, the light theme, the dark theme, and the key-cap
 * platform; those controls are **local state only** — they write `data-theme` and
 * `data-theme-mode` straight to `document.documentElement` (so Base UI portal content
 * such as the Dialog example picks up the theme) and never call the theme provider or
 * touch stored preferences. On unmount the previous root attributes are restored exactly,
 * including removing an attribute that was absent before.
 *
 * This module is lazily imported behind an `import.meta.env.DEV` guard (see
 * `dev-routes.tsx`), so it is eliminated from production builds. {@link GALLERY_MARKER}
 * is a unique string used by the production build-output assertion to prove the module is
 * absent from `apps/web/dist`.
 */
import { useEffect, useState, type ReactNode } from 'react';

import {
  DARK_THEMES,
  LIGHT_THEMES,
  THEME_MODES,
  type DarkTheme,
  type LightTheme,
  type ThemeMode
} from '../theme/preferences.js';
import type { Binding } from '../shell/key-utils.js';
import { Button } from '../ui/button.js';
import { Chip } from '../ui/chip.js';
import { DescriptionItem, DescriptionList } from '../ui/description-list.js';
import { Dialog } from '../ui/dialog.js';
import { EmptyState } from '../ui/empty-state.js';
import { Field } from '../ui/field.js';
import { Input } from '../ui/input.js';
import { ResizeHandle } from '../ui/resize-handle.js';
import { Shortcut, ShortcutList, type ShortcutPlatform } from '../ui/shortcut.js';
import { Tabs, TabPanel } from '../ui/tabs.js';
import { Tooltip } from '../ui/tooltip.js';
import { WriteOnlySecretField } from '../ui/write-only-secret-field.js';
import { GALLERY_ENTRIES, type GalleryEntry } from './component-gallery-registry.js';

/** Unique marker proving (by its absence) that the gallery is excluded from production. */
export const GALLERY_MARKER = 'AUTOCATALYST_DEV_COMPONENT_GALLERY';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemPrefersDark(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/** Track the OS color scheme so `system` mode resolves to a concrete light/dark theme. */
function useSystemPrefersDark(): boolean {
  const [prefersDark, setPrefersDark] = useState<boolean>(() => systemPrefersDark());
  useEffect(() => {
    let media: MediaQueryList;
    try {
      if (typeof window.matchMedia !== 'function') {
        return;
      }
      media = window.matchMedia(DARK_QUERY);
    } catch {
      return;
    }
    const listener = (event: MediaQueryListEvent): void => {
      setPrefersDark(event.matches);
    };
    setPrefersDark(media.matches);
    media.addEventListener('change', listener);
    return () => {
      media.removeEventListener('change', listener);
    };
  }, []);
  return prefersDark;
}

function restoreAttribute(root: HTMLElement, name: string, previous: string | null): void {
  if (previous === null) {
    root.removeAttribute(name);
  } else {
    root.setAttribute(name, previous);
  }
}

export interface ComponentsGalleryProps {
  /** Test seam: the initial theme mode. Defaults to `system`. */
  readonly initialMode?: ThemeMode;
  /** Test seam: the initial light theme. Defaults to the first light theme. */
  readonly initialLightTheme?: LightTheme;
  /** Test seam: the initial dark theme. Defaults to the first dark theme. */
  readonly initialDarkTheme?: DarkTheme;
  /** Test seam: the initial key-cap platform. Defaults to `mac`. */
  readonly initialPlatform?: ShortcutPlatform;
}

export function ComponentsGallery({
  initialMode = 'system',
  initialLightTheme = LIGHT_THEMES[0],
  initialDarkTheme = DARK_THEMES[0],
  initialPlatform = 'mac'
}: ComponentsGalleryProps): ReactNode {
  const [mode, setMode] = useState<ThemeMode>(initialMode);
  const [lightTheme, setLightTheme] = useState<LightTheme>(initialLightTheme);
  const [darkTheme, setDarkTheme] = useState<DarkTheme>(initialDarkTheme);
  const [platform, setPlatform] = useState<ShortcutPlatform>(initialPlatform);

  const prefersDark = useSystemPrefersDark();
  const useDark = mode === 'dark' || (mode === 'system' && prefersDark);
  const resolvedTheme = useDark ? darkTheme : lightTheme;
  const resolvedMode: 'light' | 'dark' = useDark ? 'dark' : 'light';

  // Capture the root attributes once on mount and restore them exactly on unmount.
  useEffect(() => {
    const root = document.documentElement;
    const previousTheme = root.getAttribute('data-theme');
    const previousMode = root.getAttribute('data-theme-mode');
    return () => {
      restoreAttribute(root, 'data-theme', previousTheme);
      restoreAttribute(root, 'data-theme-mode', previousMode);
    };
  }, []);

  // Apply the toolbar-selected theme directly to the root (never through preferences).
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', resolvedTheme);
    root.setAttribute('data-theme-mode', resolvedMode);
  }, [resolvedTheme, resolvedMode]);

  return (
    <main className="min-h-screen bg-background px-6 py-6 text-text" data-testid="component-gallery">
      <header className="mb-6 flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Component gallery</h1>
        <p className="text-sm text-subtext" style={{ maxWidth: 'var(--width-reading-column)' }}>
          Development-only review of every <code className="font-mono text-xs">ui/</code> component. This
          page makes no model or control-plane call. ({GALLERY_MARKER})
        </p>
      </header>

      <Toolbar
        mode={mode}
        lightTheme={lightTheme}
        darkTheme={darkTheme}
        platform={platform}
        onMode={setMode}
        onLightTheme={setLightTheme}
        onDarkTheme={setDarkTheme}
        onPlatform={setPlatform}
      />

      <div className="mt-8 flex flex-col gap-8">
        {GALLERY_ENTRIES.map((entry) => (
          <GallerySection key={entry.id} entry={entry}>
            {renderExample(entry.id, platform)}
          </GallerySection>
        ))}
      </div>
    </main>
  );
}

export default ComponentsGallery;

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

interface ToolbarProps {
  readonly mode: ThemeMode;
  readonly lightTheme: LightTheme;
  readonly darkTheme: DarkTheme;
  readonly platform: ShortcutPlatform;
  onMode(mode: ThemeMode): void;
  onLightTheme(theme: LightTheme): void;
  onDarkTheme(theme: DarkTheme): void;
  onPlatform(platform: ShortcutPlatform): void;
}

const SELECT_CLASSES =
  'h-control-base rounded-sm border border-border bg-background px-2 text-sm text-text ' +
  'focus:outline-none focus:ring-2 focus:ring-focus focus:ring-offset-1 focus:ring-offset-background';

function Toolbar({
  mode,
  lightTheme,
  darkTheme,
  platform,
  onMode,
  onLightTheme,
  onDarkTheme,
  onPlatform
}: ToolbarProps): ReactNode {
  return (
    <div className="flex flex-wrap items-end gap-4 border-b border-border pb-4">
      <label className="flex flex-col gap-1 text-xs font-medium text-subtext">
        Theme mode
        <select
          className={SELECT_CLASSES}
          value={mode}
          onChange={(event) => {
            onMode(event.target.value as ThemeMode);
          }}
        >
          {THEME_MODES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-subtext">
        Light theme
        <select
          className={SELECT_CLASSES}
          value={lightTheme}
          onChange={(event) => {
            onLightTheme(event.target.value as LightTheme);
          }}
        >
          {LIGHT_THEMES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-subtext">
        Dark theme
        <select
          className={SELECT_CLASSES}
          value={darkTheme}
          onChange={(event) => {
            onDarkTheme(event.target.value as DarkTheme);
          }}
        >
          {DARK_THEMES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-subtext">
        Key-cap platform
        <select
          className={SELECT_CLASSES}
          value={platform}
          onChange={(event) => {
            onPlatform(event.target.value as ShortcutPlatform);
          }}
        >
          <option value="mac">mac</option>
          <option value="other">other</option>
        </select>
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section frame
// ---------------------------------------------------------------------------

function GallerySection({ entry, children }: { entry: GalleryEntry; children: ReactNode }): ReactNode {
  return (
    <section data-gallery-entry={entry.id} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-md font-medium text-text">{entry.title}</h2>
        <Chip tone={entry.kind === 'custom' ? 'neutral' : 'muted'}>
          {entry.kind === 'custom' ? 'custom' : 'Base UI'}
        </Chip>
      </div>
      <p className="text-sm text-subtext">{entry.description}</p>
      <div className="rounded-sm border border-border bg-surface p-4">{children}</div>
    </section>
  );
}

function Row({ children }: { children: ReactNode }): ReactNode {
  return <div className="flex flex-wrap items-center gap-4">{children}</div>;
}

// ---------------------------------------------------------------------------
// Per-component examples
// ---------------------------------------------------------------------------

/** The example block for one `ui/` component id. */
function renderExample(id: string, platform: ShortcutPlatform): ReactNode {
  switch (id) {
    case 'resize-handle':
      return <ResizeHandleExample />;
    case 'chip':
      return (
        <Row>
          <Chip tone="neutral">neutral</Chip>
          <Chip tone="muted">muted</Chip>
          <Chip tone="primary">primary</Chip>
          <Chip tone="green">green</Chip>
          <Chip tone="red">red</Chip>
        </Row>
      );
    case 'empty-state':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="h-40 rounded-sm border border-border-subtle">
            <EmptyState title="No runs yet" message="A run starts from a tracked issue." />
          </div>
          <div className="h-40 rounded-sm border border-border-subtle">
            <EmptyState
              title="Run no longer available"
              message="This run was removed. Pick another from the list."
              action={{ label: 'Back to runs', onClick: () => undefined }}
            />
          </div>
        </div>
      );
    case 'description-list':
      return (
        <DescriptionList>
          <DescriptionItem label="Issue">#175</DescriptionItem>
          <DescriptionItem label="Work kind">feature</DescriptionItem>
          <DescriptionItem label="State">Working</DescriptionItem>
        </DescriptionList>
      );
    case 'shortcut':
      return <ShortcutExample platform={platform} />;
    case 'button':
      return (
        <div className="flex flex-col gap-4">
          <Row>
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="destructive">Destructive</Button>
          </Row>
          <Row>
            <Button variant="primary" size="control-sm">
              Small
            </Button>
            <Button variant="primary" size="control-base">
              Base
            </Button>
            <Button variant="primary" size="control-lg">
              Large
            </Button>
            <Button variant="primary" disabled>
              Disabled
            </Button>
          </Row>
        </div>
      );
    case 'field':
      return (
        <div className="max-w-sm">
          <Field label="Display name" hint="Shown next to your runs.">
            <Input placeholder="Ada Lovelace" />
          </Field>
        </div>
      );
    case 'input':
      return (
        <div className="flex max-w-sm flex-col gap-3">
          <Input placeholder="Default" />
          <Input defaultValue="Filled value" />
          <Input placeholder="Disabled" disabled />
        </div>
      );
    case 'write-only-secret-field':
      return <WriteOnlySecretExample />;
    case 'tabs':
      return <TabsExample />;
    case 'dialog':
      return <DialogExample />;
    case 'tooltip':
      return (
        <Tooltip label="Keyboard shortcuts" keyHint="?">
          <Button variant="secondary">Hover or focus me</Button>
        </Tooltip>
      );
    default:
      return <p className="text-sm text-red">No example registered for &quot;{id}&quot;.</p>;
  }
}

function ResizeHandleExample(): ReactNode {
  const [width, setWidth] = useState(360);
  const [height, setHeight] = useState(120);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex h-32 w-full max-w-xl overflow-hidden rounded-sm border border-border-subtle">
        <div className="min-w-0 flex-1 bg-surface-1 p-2 text-xs text-subtext">List</div>
        <ResizeHandle
          orientation="vertical"
          value={width}
          min={240}
          max={560}
          label="Resize side pane"
          startAxisChange="increase"
          onResize={setWidth}
        />
        <div className="shrink-0 bg-surface p-2 text-xs text-subtext" style={{ width: `${width}px` }}>
          Pane ({Math.round(width)} px)
        </div>
      </div>

      <div className="flex w-full max-w-xl flex-col overflow-hidden rounded-sm border border-border-subtle">
        <div className="min-h-0 flex-1 bg-surface-1 p-2 text-xs text-subtext">Top</div>
        <ResizeHandle
          orientation="horizontal"
          value={height}
          min={80}
          max={220}
          label="Resize bottom pane"
          startAxisChange="increase"
          onResize={setHeight}
        />
        <div className="shrink-0 bg-surface p-2 text-xs text-subtext" style={{ height: `${height}px` }}>
          Bottom ({Math.round(height)} px)
        </div>
      </div>
    </div>
  );
}

function ShortcutExample({ platform }: { platform: ShortcutPlatform }): ReactNode {
  const combo: Binding = [{ key: ',', mod: 'mod' }];
  const sequence: Binding = [{ key: 'g' }, { key: 'r' }];
  const selectNext: readonly Binding[] = [[{ key: 'j' }], [{ key: 'ArrowDown' }]];
  return (
    <DescriptionList>
      <DescriptionItem label="Combo">
        <Shortcut binding={combo} platform={platform} />
      </DescriptionItem>
      <DescriptionItem label="Sequence">
        <Shortcut binding={sequence} platform={platform} />
      </DescriptionItem>
      <DescriptionItem label="Alternates">
        <ShortcutList bindings={selectNext} platform={platform} />
      </DescriptionItem>
    </DescriptionList>
  );
}

function WriteOnlySecretExample(): ReactNode {
  const [fresh, setFresh] = useState('');
  const [existing, setExisting] = useState('');
  return (
    <div className="grid max-w-xl gap-4 sm:grid-cols-2">
      <WriteOnlySecretField hasStoredValue={false} value={fresh} onValueChange={setFresh} />
      <WriteOnlySecretField hasStoredValue value={existing} onValueChange={setExisting} />
    </div>
  );
}

function TabsExample(): ReactNode {
  const [tab, setTab] = useState('summary');
  return (
    <Tabs
      label="Gallery tabs example"
      value={tab}
      onValueChange={setTab}
      tabs={[
        { id: 'summary', label: 'Summary' },
        { id: 'spec', label: 'Spec' },
        { id: 'activity', label: 'Activity' }
      ]}
    >
      <TabPanel value="summary">
        <p className="pt-3 text-sm text-subtext">Summary panel content.</p>
      </TabPanel>
      <TabPanel value="spec">
        <p className="pt-3 text-sm text-subtext">Spec panel content.</p>
      </TabPanel>
      <TabPanel value="activity">
        <p className="pt-3 text-sm text-subtext">Activity panel content.</p>
      </TabPanel>
    </Tabs>
  );
}

function DialogExample(): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Open dialog
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title="Example dialog" description="A token-styled modal.">
        <p className="text-sm text-text">Dialog body content goes here.</p>
      </Dialog>
    </>
  );
}
