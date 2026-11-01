/**
 * The Runs destination.
 *
 * The run list arrives in #134. Until then, Runs shows an empty main area when a
 * token is stored, or the design-system connection empty state when none is: a title,
 * one explanatory line, and a single primary button to open Connection settings.
 *
 * Token presence is read from the token store as a boolean (never the value). The
 * page remounts on navigation, so returning here after saving a token shows the empty
 * main area rather than the connect prompt.
 */
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { hasBearerToken } from '../auth/token-store.js';
import { CONNECTION_PATH } from '../shell/navigation.js';
import { Button } from '../ui/button.js';

export function RunsPage(): ReactNode {
  const navigate = useNavigate();
  const connected = hasBearerToken();

  if (connected) {
    // Empty until #134 adds the run list.
    return <div className="h-full" data-testid="runs-empty" />;
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <h2 className="text-md font-medium text-text">Connect to the control plane</h2>
      <p className="text-sm text-subtext" style={{ maxWidth: 'var(--width-reading-column)' }}>
        Enter a bearer token in Connection settings to reach the control plane.
      </p>
      <Button
        variant="primary"
        className="mt-2"
        onClick={() => {
          navigate(CONNECTION_PATH);
        }}
      >
        Open connection settings
      </Button>
    </div>
  );
}
