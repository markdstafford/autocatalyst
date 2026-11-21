import type { ReactNode } from 'react';

import { RunDetailPane } from './run-detail-pane.js';
import { useRunDetail, type UseRunDetailOptions } from './use-run-detail.js';

export function RunDetailHarness(props: UseRunDetailOptions & { readonly currentPrincipalId?: string }): ReactNode {
  const detail = useRunDetail(props);
  return (
    <RunDetailPane
      run={props.run}
      detail={detail}
      {...(props.currentPrincipalId !== undefined ? { currentPrincipalId: props.currentPrincipalId } : {})}
    />
  );
}
