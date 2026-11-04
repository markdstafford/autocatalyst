/**
 * Shared fact-state types for the detail pane's independently-loaded facts.
 *
 * Each Summary fact that comes from its own read (pull request, totals-from-sessions)
 * and the Spec discriminator carry their own loading/success/error state, so one failed
 * read never blanks the other facts. Defined here (not in the data hook) so the display
 * components can import the types without importing the hook.
 */
import type { PullRequest, Session } from '@autocatalyst/api-contract';

/** A single independently-loaded fact: loading, a value, or an inline error. */
export type FactState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'success'; readonly value: T }
  | { readonly status: 'error'; readonly message: string };

/** The pull request fact. A successful `null` value is the normal no-PR (404) state. */
export type PullRequestFact = FactState<PullRequest | null>;

/** The sessions fact, from which the time/token/cost totals are computed. */
export type SessionsFact = FactState<readonly Session[]>;

/**
 * The Spec-tab discriminator:
 * - `no-spec`: the run's work kind has no API-served spec (no read is made).
 * - `loading`: the spec read is in flight.
 * - `drafting`: a spec-capable run whose spec is not ready yet (`getRunSpec` 404).
 * - `ready`: a spec-capable run whose spec exists (success).
 * - `error`: a non-404 spec read failure.
 */
export type SpecDiscriminator =
  | { readonly status: 'no-spec' }
  | { readonly status: 'loading' }
  | { readonly status: 'drafting' }
  | { readonly status: 'ready' }
  | { readonly status: 'error'; readonly message: string };
