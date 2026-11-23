/**
 * Shared fact-state types for the detail pane's independently-loaded facts.
 *
 * Each Summary fact that comes from its own read (pull request, totals-from-sessions)
 * and the Spec discriminator carry their own loading/success/error state, so one failed
 * read never blanks the other facts. Defined here (not in the data hook) so the display
 * components can import the types without importing the hook.
 */
import type { FeedbackResponse, PullRequest, Session, SessionCostTotal } from '@autocatalyst/api-contract';

/** A single independently-loaded fact: loading, a value, or an inline error. */
export type FactState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'success'; readonly value: T }
  | { readonly status: 'error'; readonly message: string };

/** The pull request fact. A successful `null` value is the normal no-PR (404) state. */
export type PullRequestFact = FactState<PullRequest | null>;

/** Transient check feedback, separate from the stored pull request read. */
export interface PullRequestCheck {
  readonly pending?: boolean;
  /** Held until a check of the replaced PR settles; its status is no longer displayed. */
  readonly locked?: boolean;
  readonly checkedAt?: string;
  readonly error?: string;
}

/** The sessions fact, from which the time/token/cost totals are computed. */
export type SessionsFact = FactState<readonly Session[]> & { readonly runCost?: SessionCostTotal };

/**
 * The Spec-tab discriminator:
 * - `no-spec`: the run's work kind has no API-served spec (no read is made).
 * - `loading`: the spec read is in flight.
 * - `drafting`: a spec-capable run whose spec is not ready yet (`getRunSpec` 404).
 * - `ready`: a spec-capable run whose spec exists; carries the markdown, the target artifact id, and
 *   the reconciled artifact feedback so the Spec tab can render the review surface.
 * - `error`: a non-404 spec read failure.
 */
export type SpecDiscriminator =
  | { readonly status: 'no-spec' }
  | { readonly status: 'loading' }
  | { readonly status: 'drafting' }
  | {
      readonly status: 'ready';
      readonly markdown: string;
      readonly artifactId: string;
      readonly feedback: readonly FeedbackResponse[];
    }
  | { readonly status: 'error'; readonly message: string };
