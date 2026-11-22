import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { NEW_PROJECT_PATH } from '../shell/navigation.js';
import { EmptyState } from '../ui/empty-state.js';

export function ProjectEmptyState({ fromRuns = false }: { readonly fromRuns?: boolean }): ReactNode {
  const navigate = useNavigate();
  return (
    <EmptyState
      title="Add a project to get started"
      message="Set up a repository for your runs."
      action={{
        label: 'Add project',
        onClick: () => navigate(NEW_PROJECT_PATH, fromRuns ? { state: { fromRuns: true } } : undefined)
      }}
    />
  );
}
