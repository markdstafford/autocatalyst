import type { RunStep, RunSystemActivity } from '@autocatalyst/api-contract';

const short = (sha: string) => sha.slice(0, 12);
const integrationReasons = {
  binding_unavailable: 'The project repository or credential could not be resolved.',
  target_unavailable: 'The remote target ref could not be read.',
  workspace_not_ready: 'The run branch was missing, dirty, or busy.',
  attestation_missing: 'The publication candidate did not have a matching review.',
  target_changed: 'The remote target changed after final review.',
  candidate_changed: 'The local candidate no longer matched final review.',
  push_unverified: 'The source ref could not be verified at the published commit.'
} satisfies Record<NonNullable<Extract<RunSystemActivity, { kind: 'integration' }>['safeReason']>, string>;
const stopped: Partial<Record<RunSystemActivity['code'], string>> = {
  repair_remote_changed: 'The remote pull request changed; no overwrite was attempted.',
  repair_remote_unverified: 'The current pull request could not be verified.',
  repair_workspace_not_ready: 'The run branch was missing, dirty, busy, or not at the expected commit.',
  repair_implementation_failed: 'Implementation could not complete.',
  repair_human_docs_changed: 'The fix requires edits to human-owned docs or a frozen spec.',
  repair_final_review_blocked: 'Final review blocked publication.',
  repair_final_review_failed: 'Final review could not be completed.',
  repair_integration_conflict: 'Integration with the target conflicted.',
  repair_target_verification_failed: 'The target could not be verified.',
  repair_publication_refresh_exhausted: 'The target changed after two publication refreshes.',
  repair_candidate_changed: 'The reviewed candidate changed.',
  repair_execution_failed: 'The repair encountered a technical failure.',
  repair_no_change: 'The integrated tree did not change; nothing was pushed.',
  repair_push_unverified: 'The push outcome could not be verified. Check the existing pull request before continuing.',
  repair_interrupted: 'The previous repair owner was interrupted; this attempt was not replayed.',
  repair_pr_merged: 'The pull request merged; the repair was superseded.',
  repair_pr_closed: 'The pull request closed; the repair was superseded.',
  repair_canceled: 'The repair was canceled.'
};

function label(entry: RunSystemActivity) {
  switch (entry.code) {
    case 'pr_integration_conflict': return `PR not opened: integration conflict with ${entry.base}.`;
    case 'pr_target_verification_failed': return 'PR not opened: target could not be verified.';
    case 'pr_publication_refresh_exhausted': return 'PR not opened: publication candidate could not be verified after 2 refreshes.';
    case 'pr_publication_refreshed': return 'Publication candidate invalidated; reviewing again.';
    case 'pr_target_integrated': return `Reviewed against the fetched ${entry.base} target.`;
    case 'pr_integration_workspace_unavailable': return 'PR not opened: the local run workspace was not ready.';
    case 'pr_publication_candidate_changed': return 'PR not opened: unexpected changes invalidated final review.';
    case 'pr_publication_push_unverified': return 'PR not opened: the source push could not be verified.';
    case 'repair_queued': return `CI repair ${entry.ordinal} of ${entry.limit} queued.`;
    case 'repair_needs_guidance': return `CI repair ${entry.ordinal} of ${entry.limit} needs guidance.`;
    case 'repair_disabled': return 'Required CI failed; automatic repair is disabled (limit 0).';
    case 'repair_budget_exhausted': return `Required CI failed; automatic repair limit reached (limit ${entry.limit}, ${entry.admittedCount ?? entry.limit} admitted).`;
    case 'repair_unverified_provenance': return `Required CI failed on ${short(entry.headSha)}; Autocatalyst has no verified publication record for this commit. No repair queued.`;
    case 'repair_failure_cleared': return `Automatic repair stopped: no required failure remains on ${short(entry.headSha)}.${entry.requiredPending ? ' A required check is pending.' : ''} This attempt counts and this head will not be queued again.`;
    case 'repair_pushed': return `Repair pushed; waiting for checks on ${short(entry.publishHeadSha ?? entry.headSha)}.`;
    default: return `Automatic repair stopped: ${stopped[entry.code] ?? 'Publication was blocked.'}`;
  }
}

export function PrSystemActivity({ step }: { step: RunStep }) {
  const note = step.prCiCoverage === 'ticker_disabled' || step.prCiCoverage === 'tenant_not_covered';
  if (step.prCiCoverage === undefined && (step.systemActivity?.length ?? 0) === 0) return null;
  return <div className="space-y-2 break-words border-l border-border py-1 pl-3 ml-3">
    {step.prCiCoverage === 'enabled' ? <p className="text-subtext">Periodic CI watching is enabled for this run.</p> : null}
    {note ? <p className="text-subtext">Periodic CI watching is off for this run. Check CI on GitHub or ask an operator to enable watching for this tenant.</p> : null}
    {step.systemActivity?.map(entry => <div key={entry.key} className="space-y-1">
      <p className="font-medium">{label(entry)}</p>
      {entry.kind === 'integration' ? <>
        <p className="text-subtext">
          {entry.repository ? `Repository ${entry.repository} · ` : ''}Run {step.runId}
          {entry.branch ? ` · Branch ${entry.branch}` : ''} · Target {entry.base}
          {entry.sourcePushed === true ? ' · Source ref previously pushed' :
            entry.code === 'pr_publication_push_unverified' ? ' · Source push unverified' :
              entry.sourcePushed === false ? ' · Source ref not pushed' : ''}
        </p>
        <p className="text-subtext">
          {entry.sourceSha ? `Source ${entry.sourceSha} · ` : ''}
          {entry.targetSha ? `Target ${entry.targetSha} · ` : ''}
          {entry.observedTargetSha ? `Observed target ${entry.observedTargetSha} · ` : ''}
          {entry.publishSha ? `Candidate ${entry.publishSha} · ` : ''}Refreshes {entry.refreshCount}
        </p>
        {entry.safeReason ? <p className="text-subtext">{integrationReasons[entry.safeReason]}</p> : null}
        {entry.code === 'pr_integration_conflict' ?
          <p>Ask an authorized host operator to locate the retained run branch, resolve and commit the conflict, and leave the workspace clean before you use Resume. If the branch expired, Resume cannot recover it.</p> : null}
        {entry.code === 'pr_target_verification_failed' ? <p>Restore target access, then use Resume.</p> : null}
        {entry.code === 'pr_publication_refresh_exhausted' ? <p>Wait for the target to stabilize, then use Resume.</p> : null}
      </> : <>
        <p className="text-subtext">{entry.ordinal !== undefined ? `Attempt ${entry.ordinal} of ${entry.limit} · ` : ''}Failed head {short(entry.headSha)}</p>
        {entry.checks.length > 0 ? <ul className="list-inside list-disc">{entry.checks.map(check => <li key={check.id}>{check.name} · {check.conclusion}</li>)}</ul> : null}
        {entry.prUrl ? <a href={entry.prUrl} target="_blank" rel="noreferrer" className="text-primary underline">Open existing pull request on GitHub</a> : null}
        {entry.kind === 'ci_outcome' && entry.workspaceHold ?
          <p>The workspace is held. Ask an authorized host operator to confirm that old workers have exited before salvaging local work.</p> : null}
        {entry.kind === 'ci_outcome' && entry.findings?.map((finding, i) => <p key={i}>{finding.severity}: {finding.summary}</p>)}
      </>}
      {'paths' in entry && entry.paths?.length ? <ul className="list-inside list-disc">{entry.paths.map(path => <li key={path}>{path}</li>)}</ul> : null}
      {'cleanup' in entry && entry.cleanup ? <p>{entry.cleanup === 'restored' ? 'The original local head was restored.' : 'Merge cleanup needs authorized host inspection.'}</p> : null}
    </div>)}
  </div>;
}
