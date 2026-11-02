/**
 * The shell footer: five named zones with final control placement and no internal
 * dividers.
 *
 * Zones left to right: Left control (sidebar toggle), Sidebar (status, ends at the
 * sidebar's right edge; zero width when closed), List (the connection indicator;
 * spans the main area), Detail pane (follows the pane's left edge; zero width when
 * the pane is hidden or off the runs route), and Right control (the detail pane
 * toggle). Each zone is a `role="group"` labeled by its name. The control zones keep
 * their width and position across sidebar/pane states; only the sidebar and detail
 * pane zones animate.
 *
 * Tooltip labels and key hints come from the action registry, so the footer never
 * hard-codes a shortcut key.
 */
import { PanelLeft, PanelRight } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

import { Button } from '../ui/button.js';
import { Tooltip } from '../ui/tooltip.js';
import { actionTooltipKey, getAction } from './action-registry.js';
import { HealthIndicator } from './health-indicator.js';
import { isMacPlatform } from './key-utils.js';

interface FooterZoneProps {
  readonly name: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly children?: ReactNode;
}

function FooterZone({ name, className, style, children }: FooterZoneProps): ReactNode {
  return (
    <div
      role="group"
      aria-label={name}
      className={`flex items-center justify-center ${className ?? ''}`}
      {...(style !== undefined ? { style } : {})}
    >
      {children}
    </div>
  );
}

export interface FooterProps {
  readonly sidebarOpen: boolean;
  onToggleSidebar(): void;
  /** Whether the detail pane toggle is enabled (true on the runs route). */
  readonly paneEnabled?: boolean;
  /** Whether the detail pane is currently shown. */
  readonly paneVisible?: boolean;
  /** Current pane width in px, used to size the detail pane zone. */
  readonly paneWidthPx?: number;
  /** Toggle the detail pane (only meaningful when enabled). */
  onTogglePane?(): void;
}

export function Footer({
  sidebarOpen,
  onToggleSidebar,
  paneEnabled = false,
  paneVisible = false,
  paneWidthPx = 0,
  onTogglePane
}: FooterProps): ReactNode {
  const isMac = isMacPlatform();
  // The sidebar zone fills the remainder of the sidebar width after the left control
  // zone, so its right edge equals the sidebar's right edge. Zero when closed.
  const sidebarZoneStyle: CSSProperties = {
    width: sidebarOpen ? 'calc(var(--width-sidebar) - var(--width-footer-control))' : '0px'
  };
  // The detail pane zone mirrors the sidebar zone on the right: its left edge equals
  // the pane's left edge, ending where the right control zone starts. Zero width when
  // the pane is hidden or off the runs route.
  const paneZoneWidth =
    paneEnabled && paneVisible
      ? `calc(${paneWidthPx}px - var(--width-footer-control))`
      : '0px';

  const sidebarLabel = getAction('sidebar-toggle').name;
  const paneLabel = getAction('pane-toggle').name;

  return (
    <footer className="flex h-footer border-t border-border bg-mantle">
      <FooterZone name="Left control" className="w-footer-control shrink-0">
        <Tooltip label={sidebarLabel} keyHint={actionTooltipKey('sidebar-toggle', isMac)}>
          <Button
            variant="secondary"
            size="control-sm"
            aria-label="Toggle sidebar"
            onClick={onToggleSidebar}
            className="aspect-square border-0 bg-transparent px-0 text-subtext hover:bg-hover hover:text-text"
          >
            <PanelLeft aria-hidden size={14} />
          </Button>
        </Tooltip>
      </FooterZone>

      <FooterZone
        name="Sidebar"
        className="overflow-hidden transition-[width] duration-layout"
        style={sidebarZoneStyle}
      />

      <FooterZone name="List" className="min-w-0 flex-1">
        <HealthIndicator />
      </FooterZone>

      <FooterZone
        name="Detail pane"
        className="overflow-hidden transition-[width] duration-layout"
        style={{ width: paneZoneWidth }}
      />

      <FooterZone name="Right control" className="w-footer-control shrink-0">
        <Tooltip label={paneLabel} keyHint={actionTooltipKey('pane-toggle', isMac)}>
          <Button
            variant="secondary"
            size="control-sm"
            aria-label="Toggle detail pane"
            {...(paneEnabled
              ? { onClick: onTogglePane }
              : { 'aria-disabled': true })}
            className="aspect-square border-0 bg-transparent px-0 text-subtext hover:bg-hover hover:text-text"
          >
            <PanelRight aria-hidden size={14} />
          </Button>
        </Tooltip>
      </FooterZone>
    </footer>
  );
}
