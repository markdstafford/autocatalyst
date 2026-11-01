/**
 * The shell footer: five named zones with final control placement and no internal
 * dividers.
 *
 * Zones left to right: Left control (sidebar toggle), Sidebar (status, ends at the
 * sidebar's right edge; zero width when closed), List (the health connection item;
 * spans the main area before #134 adds a list), Detail pane (zero width before #134),
 * and Right control (the disabled detail pane toggle). Each zone is a `role="group"`
 * with its zone name as the accessible label. The control zones keep their width and
 * position across sidebar/pane states; only the sidebar zone animates.
 */
import { PanelLeft, PanelRight } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

import { Button } from '../ui/button.js';
import { Tooltip } from '../ui/tooltip.js';
import { HealthIndicator } from './health-indicator.js';
import { isMacPlatform, keyHintFor } from './shell-keys.js';

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
}

export function Footer({ sidebarOpen, onToggleSidebar }: FooterProps): ReactNode {
  const isMac = isMacPlatform();
  // The sidebar zone fills the remainder of the sidebar width after the left control
  // zone, so its right edge equals the sidebar's right edge. Zero when closed.
  const sidebarZoneStyle: CSSProperties = {
    width: sidebarOpen ? 'calc(var(--width-sidebar) - var(--width-footer-control))' : '0px'
  };

  return (
    <footer className="flex h-footer border-t border-border bg-mantle">
      <FooterZone name="Left control" className="w-footer-control shrink-0">
        <Tooltip label="Sidebar" keyHint={keyHintFor('sidebar-toggle', isMac)}>
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

      <FooterZone name="Detail pane" style={{ width: '0px' }} className="overflow-hidden" />

      <FooterZone name="Right control" className="w-footer-control shrink-0">
        <Tooltip label="Detail pane" keyHint={keyHintFor('pane-toggle', isMac)}>
          <Button
            variant="secondary"
            size="control-sm"
            aria-label="Toggle detail pane"
            aria-disabled
            className="aspect-square border-0 bg-transparent px-0 text-subtext"
          >
            <PanelRight aria-hidden size={14} />
          </Button>
        </Tooltip>
      </FooterZone>
    </footer>
  );
}
