/**
 * The one module of empty-state copy for the detail pane's non-Summary tabs.
 *
 * Every empty tab (Spec variants, Acceptance, Activity) names its copy here so
 * component tests assert against these descriptors instead of duplicating the wording,
 * and so a wording change happens in exactly one place. The rendering rules (centered,
 * `--text-md` title, one `--text-sm` `--color-subtext` line, no button, no
 * illustration) live in the reusable empty-state component.
 */
export interface EmptyStateCopy {
  /** The centered title line (`--text-md`). */
  readonly title: string;
  /** The single explanatory line (`--text-sm`, `--color-subtext`). */
  readonly line: string;
}

/**
 * The three Spec-tab variants:
 * - `noSpec`: the run's work kind has no API-served spec at all.
 * - `drafting`: a spec-capable run whose spec is not ready yet (`getRunSpec` 404).
 * - `ready`: a spec-capable run whose spec exists but is not rendered in this view yet.
 */
export const SPEC_EMPTY_STATES: Readonly<Record<'noSpec' | 'drafting' | 'ready', EmptyStateCopy>> = {
  noSpec: {
    title: 'No spec for this work kind',
    line: 'This work kind runs without a spec, so there is nothing to review here.'
  },
  drafting: {
    title: 'Spec is being drafted',
    line: 'The spec is not ready yet. You will be asked to review it here once it is.'
  },
  ready: {
    title: 'Spec is ready',
    line: 'This view does not render the spec yet. It will appear here in a later update.'
  }
};

/** The single, run-independent Acceptance empty state. */
export const ACCEPTANCE_EMPTY_STATE: EmptyStateCopy = {
  title: 'No testing guide for this run',
  line: 'A testing guide is not available here yet. Review the pull request to validate the change.'
};

/** The single, run-independent Activity empty state. */
export const ACTIVITY_EMPTY_STATE: EmptyStateCopy = {
  title: 'No activity to show',
  line: 'This view does not list steps and events yet. They will appear here later.'
};
