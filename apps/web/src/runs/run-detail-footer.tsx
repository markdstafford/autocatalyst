/**
 * The run-detail → shell-footer bridge.
 *
 * The shell footer owns the detail-pane zone, but the spec-tab comment counts and the previous/next
 * comment controls are computed by the run detail pane. This small context lets the pane publish that
 * content and the footer render it, without the footer importing run state or a second data loader
 * (ADR-031: the client stays stateless; only derived view state crosses the bridge).
 *
 * The pane sets the content while the Spec tab is active and the spec has loaded, and clears it when
 * the tab changes, the run changes, the spec is not ready, the expanded overlay opens (the footer is
 * then covered), or the pane unmounts. A null content means the footer detail-pane zone stays empty.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

/** The spec-tab comment content the footer renders in its detail-pane zone. */
export interface RunDetailFooterContent {
  readonly openCount: number;
  readonly resolvedCount: number;
  readonly hasComments: boolean;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  onPrevious(): void;
  onNext(): void;
}

interface RunDetailFooterContextValue {
  readonly content: RunDetailFooterContent | null;
  setContent(content: RunDetailFooterContent | null): void;
}

const RunDetailFooterContext = createContext<RunDetailFooterContextValue | undefined>(undefined);

export function RunDetailFooterProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [content, setContent] = useState<RunDetailFooterContent | null>(null);
  const value = useMemo<RunDetailFooterContextValue>(() => ({ content, setContent }), [content]);
  return <RunDetailFooterContext.Provider value={value}>{children}</RunDetailFooterContext.Provider>;
}

/** Read the bridge, or `undefined` when no provider is present (e.g. isolated component tests). */
export function useRunDetailFooterOptional(): RunDetailFooterContextValue | undefined {
  return useContext(RunDetailFooterContext);
}

/** Read the bridge; throws when used outside a provider. */
export function useRunDetailFooter(): RunDetailFooterContextValue {
  const value = useRunDetailFooterOptional();
  if (value === undefined) {
    throw new Error('useRunDetailFooter must be used within a RunDetailFooterProvider.');
  }
  return value;
}
