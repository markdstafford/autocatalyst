/**
 * The common settings page frame: a scroller with 24 px padding, a content column no
 * wider than `--width-settings-column`. Pages may render a title and description,
 * focus the heading on entry, or fill the column with a centered empty state.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';

export interface SettingsPageProps {
  readonly title?: string;
  readonly description?: string;
  readonly focusTitle?: boolean;
  readonly children: ReactNode;
}

export function SettingsPage({ title, description, focusTitle = false, children }: SettingsPageProps): ReactNode {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (focusTitle) heading.current?.focus();
  }, [focusTitle]);
  return (
    <div className="h-full overflow-auto bg-background p-6">
      <div className={`mx-auto w-full ${title === undefined ? 'h-full' : ''}`} style={{ maxWidth: 'var(--width-settings-column)' }}>
        {title !== undefined ? (
          <div className="mb-4 flex flex-col gap-1">
            <h2 ref={heading} tabIndex={focusTitle ? -1 : undefined} className="text-lg font-semibold text-text">{title}</h2>
            {description !== undefined ? <p className="text-sm text-subtext">{description}</p> : null}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
