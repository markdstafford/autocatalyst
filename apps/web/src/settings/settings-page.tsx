/**
 * The common settings page frame: a scroller with 24 px padding, a content column no
 * wider than `--width-settings-column`, a title (`--text-lg`, weight 600), and an
 * optional description (`--text-sm`, `--color-subtext`). Individual settings pages
 * render their form or rows as children.
 */
import type { ReactNode } from 'react';

export interface SettingsPageProps {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}

export function SettingsPage({ title, description, children }: SettingsPageProps): ReactNode {
  return (
    <div className="h-full overflow-auto bg-background p-6">
      <div className="mx-auto w-full" style={{ maxWidth: 'var(--width-settings-column)' }}>
        <div className="mb-4 flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-text">{title}</h2>
          {description !== undefined ? <p className="text-sm text-subtext">{description}</p> : null}
        </div>
        {children}
      </div>
    </div>
  );
}
