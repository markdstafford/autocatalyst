import { PrSystemActivity } from './pr-system-activity.js';
import type { Run, Session } from '@autocatalyst/api-contract';
import { CheckCircle2, ChevronRight, Circle, Hand, Loader2, MinusCircle, Square, XCircle } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { RunActivityBuffer } from './run-activity-buffer.js';
import { groupActivity, placeSessions, projectActivity, type ActivityRow, type ActivityState } from './run-activity-path.js';
import type { ActivityFacts, SessionsFact } from './run-detail-facts.js';
import { formatDurationMs, formatNanoUsd, summaryTokens } from './run-summary-totals.js';
import { Tooltip } from '../ui/tooltip.js';

const markers = {
  done: [CheckCircle2, 'text-green', 'Done'],
  failed: [XCircle, 'text-red', 'Failed'],
  canceled: [XCircle, 'text-overlay', 'Canceled'],
  waiting: [Hand, 'text-primary', 'Waiting on you'],
  running: [Loader2, 'text-primary motion-safe:animate-spin', 'Running'],
  skipped: [MinusCircle, 'text-overlay', 'Skipped'],
  unreached: [Circle, 'text-overlay', 'Not started'],
  ended: [Square, 'text-overlay', 'Ended'],
  'historical-stop': [Square, 'text-overlay', ''],
  refreshing: [Square, 'text-overlay', 'Refreshing']
} as const satisfies Record<ActivityState, readonly [typeof Square, string, string]>;

export function RunActivity({ run, activity, sessions, active }: {
  run: Run; activity: ActivityFacts; sessions: SessionsFact; active: boolean;
}) {
  const { workflow, steps, buffer } = activity;
  const projection = projectActivity(run, steps.value, workflow.value);
  const ticking = active && projection.current !== undefined;
  const running = projection.rows.find(row => row.state === 'running')?.key;
  const [disclosures, setDisclosures] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  // Persist the default-open choice when an observed running attempt finishes,
  // while leaving an explicit collapse untouched.
  useEffect(() => {
    if (!active || running === undefined) return;
    setDisclosures(previous => previous.has(running) ? previous : new Map(previous).set(running, true));
  }, [active, running]);
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  // A run may be selected between ticks or become current after the clock was stopped.
  const now = Math.max(clock, Date.now());
  const placed = placeSessions(steps.value ?? [], sessions.value ?? [], now);
  return (
    <div className="min-w-0 space-y-3 text-sm">
      {activity.connection === 'connecting' ? <p className="text-subtext">Connecting to live activity…</p> : null}
      {activity.connection === 'reconnecting' ? <p className="text-subtext">Reconnecting to live activity…</p> : null}
      {activity.connection === 'ended' && !run.terminal ? <p className="text-subtext">Live activity disconnected.</p> : null}
      {activity.replayGap ? <p className="text-subtext">Some events may be missing after reconnecting.</p> : null}
      {activity.runError ? <p className="text-red">Run could not be read: {activity.runError}</p> : null}
      {workflow.error ? <p className="text-red">Expected path could not be read: {workflow.error}</p>
        : workflow.pending && workflow.value === undefined ? <p className="text-subtext">Loading expected path…</p> : null}
      {steps.error ? <p className="text-red">Attempts could not be read: {steps.error}</p>
        : steps.value === undefined && steps.pending ? <p className="text-subtext">Loading attempts…</p>
          : steps.pending || ((steps.value?.length ?? 0) > 0 && projection.mismatch) ?
            <p className="text-subtext">Refreshing activity…</p> : null}
      {steps.value?.length === 0 ? <p className="text-subtext">No recorded attempts.</p> : null}
      {sessions.status === 'error' ? <p className="text-red">{sessions.message}</p> : null}
      {groupActivity(projection.rows, workflow.value).map(group => (
        <div key={group.rows[0]?.key} className="space-y-1">
          {group.label === undefined ? null : <h3 className="font-medium text-subtext">{group.label}</h3>}
          <ul className="space-y-1">
            {group.rows.map(row => <AttemptRow key={row.key} row={row} now={now}
              current={row.attempt !== undefined && row.attempt === projection.current}
              buffer={buffer} recordedSessions={placed.get(row.attempt?.id ?? '') ?? []}
              sessionsStatus={sessions.status}
              open={disclosures.get(row.key) ?? row.state === 'running'}
              onToggle={open => setDisclosures(previous => new Map(previous).set(row.key, open))} />)}
          </ul>
        </div>
      ))}
    </div>
  );
}

function AttemptRow({ row, now, current, buffer, recordedSessions, sessionsStatus, open, onToggle }: {
  row: ActivityRow; now: number; current: boolean; buffer: RunActivityBuffer;
  recordedSessions: readonly Session[]; sessionsStatus: SessionsFact['status'];
  open: boolean; onToggle(open: boolean): void;
}) {
  const [Icon, color, label] = markers[row.state];
  const timeId = useId();
  const attempt = row.attempt;
  const muted = row.state === 'skipped' || row.state === 'unreached';
  const elapsed = current && attempt ? now - Date.parse(attempt.startedAt) : attempt?.durationMs;
  const lines = attempt ? buffer.forAttempt(attempt.id) : [];
  const latest = lines.at(-1);
  const header = (
    <>
      <Icon size={14} className={`shrink-0 ${color}`} aria-hidden="true" />
      <span className="min-w-0 break-words font-mono">{row.step}</span>
      {attempt && attempt.occurrence.attempt > 1 ? <span className="shrink-0 text-xs text-subtext">Attempt {attempt.occurrence.attempt}</span> : null}
      {row.state === 'historical-stop' ? null : <span className="text-subtext">{label}</span>}
      {attempt ? <span id={timeId} data-testid="attempt-time" className="ml-auto shrink-0 tabular-nums text-subtext">
        {elapsed == null ? '—' : formatDurationMs(elapsed)}
      </span> : null}
    </>
  );
  const lineClass = 'flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-xs px-1 py-1 text-left';
  return (
    <li data-activity-step={row.step} data-activity-state={row.state}
      data-attempt-number={attempt?.occurrence.attempt} className={muted ? 'opacity-60' : undefined}>
      {attempt && row.disclose ? (
        <>
          <button type="button" aria-expanded={open}
            aria-label={`${row.step}${attempt.occurrence.attempt > 1 ? ` Attempt ${attempt.occurrence.attempt}` : ''} ${label}`}
            aria-describedby={timeId} className={`${lineClass} hover:bg-hover focus-visible:ring-1 focus-visible:ring-focus`}
            onClick={() => onToggle(!open)}>
            <ChevronRight size={14} aria-hidden="true" className={open ? 'rotate-90 text-subtext' : 'text-subtext'} />
            {header}
          </button>
          {open ? (
            <div className="space-y-2 border-l border-border pl-3 ml-3 py-1">
              <div>
                <h4 className="text-xs font-medium text-subtext">Sessions</h4>
                {recordedSessions.length > 0 ? <ul>{recordedSessions.map(session => <SessionLine key={session.id} session={session} />)}</ul>
                  : sessionsStatus === 'error' ? null : <p className="text-subtext">
                    {sessionsStatus === 'loading' ? 'Loading sessions…' : 'No recorded sessions'}
                  </p>}
              </div>
              <div>
                <h4 className="text-xs font-medium text-subtext">Events</h4>
                {current && latest ? <p data-testid="last-event" className="tabular-nums text-subtext">Last event {formatDurationMs(now - latest.time)} ago</p> : null}
                {buffer.lostEarlierEvents(attempt.id) ? <p className="text-subtext">Earlier events are not shown</p> : null}
                {lines.length === 0 ? <p className="text-subtext">{current ? 'No events yet' : 'No events held'}</p> : (
                  <ul>
                    {lines.map(line => <li key={line.id} className="break-words">
                      <time dateTime={line.createdAt} className="tabular-nums text-subtext">{new Date(line.time).toLocaleTimeString()}</time>
                      {' · '}{line.text}
                    </li>)}
                  </ul>
                )}
              </div>
            </div>
          ) : null}
        </>
      ) : <div className={lineClass}>{header}</div>}
      {attempt ? <PrSystemActivity step={attempt} /> : null}
    </li>
  );
}

function SessionLine({ session }: { session: Session }) {
  const { cost } = session;
  const tokens = summaryTokens([session]);
  const priced = 'basis' in cost ? cost : undefined;
  return (
    <li className="break-words tabular-nums">
      {session.role} · round {session.round} · {session.model.model} · {session.durationMs === null ? '—' : formatDurationMs(session.durationMs)}
      {' · '}<Tooltip label={tokens.detail} delay={0}><span tabIndex={0}>Tokens: {tokens.text}</span></Tooltip>
      {' · '}{priced?.usd == null ? 'Unknown' : formatNanoUsd(priced.usd)} API list price
      {priced && !priced.complete ? ' · Incomplete' : ''}
      {priced?.gaps.some(gap => gap.code === 'estimated_request_size') ? ' · Includes estimates' : ''}
      {' · '}{session.outcome}
    </li>
  );
}
