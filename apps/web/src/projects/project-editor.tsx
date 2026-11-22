import {
  createProjectRequestSchema,
  updateProjectRequestSchema,
  type Project
} from '@autocatalyst/api-contract';
import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { useControlPlaneClient } from '../client/client-provider.js';
import { SettingsPage } from '../settings/settings-page.js';
import { Button } from '../ui/button.js';
import { Field } from '../ui/field.js';
import { Input } from '../ui/input.js';
import { Select, type SelectOption } from '../ui/select.js';
import { WriteOnlySecretField } from '../ui/write-only-secret-field.js';
import {
  attachCredential,
  prepareSave,
  projectDraft,
  saveFailure,
  settingDraft,
  SETTING_KEYS,
  type FieldErrors,
  type FieldName,
  type SaveFailure,
  type SettingKey
} from './project-draft.js';
import { useProjectDirectory } from './project-directory.js';

const NOT_CONFIGURED = 'unconfigured';
const providerValue = (provider: string): string => `provider:${provider}`;
const GITHUB = { value: providerValue('github'), label: 'GitHub' };
export const providerLabel = (provider: string): string => provider === 'github' ? 'GitHub' : provider;

function ProviderSelect({
  label, provider, savedProvider, optional = false, disabled, error, onChange
}: {
  readonly label: string;
  readonly provider: string | null;
  readonly savedProvider?: string | undefined;
  readonly optional?: boolean;
  readonly disabled: boolean;
  readonly error: string | undefined;
  onChange(provider: string | null): void;
}): ReactNode {
  const options: SelectOption[] = optional ? [{ value: NOT_CONFIGURED, label: 'Not configured' }, GITHUB] : [GITHUB];
  if (savedProvider !== undefined && savedProvider !== 'github') {
    options.push({ value: providerValue(savedProvider), label: providerLabel(savedProvider) });
  }
  const value = provider === null ? NOT_CONFIGURED : provider === '' ? '' : providerValue(provider);
  return (
    <Select
      label={label}
      options={options}
      value={value}
      onValueChange={(next) => onChange(next === NOT_CONFIGURED ? null : next.slice('provider:'.length))}
      required={!optional}
      disabled={disabled}
      error={error}
      placeholder="Select a provider"
    />
  );
}

function TextField({
  label, value, error, disabled, required, type = 'text', onChange
}: {
  readonly label: string;
  readonly value: string;
  readonly error: string | undefined;
  readonly disabled: boolean;
  readonly required?: boolean;
  readonly type?: 'text' | 'url';
  onChange(next: string): void;
}): ReactNode {
  return (
    <Field label={label} {...(error !== undefined ? { error } : {})}>
      <Input value={value} onValueChange={onChange} disabled={disabled} required={required} type={type} />
    </Field>
  );
}

function FormGroup({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactNode {
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 border-t border-border pt-2">
      <legend className="pr-2 text-sm font-semibold text-text">{title}</legend>
      {children}
    </fieldset>
  );
}

type SaveResult = { phase: 'idle' | 'saving' | 'saved' } | { phase: 'failed'; failure: SaveFailure };

function SaveStatus({ result }: { readonly result: SaveResult }): ReactNode {
  const phase = result.phase;
  return (
    <div role="status" className="text-sm">
      {phase === 'idle' ? null : (
        <div className="flex items-start gap-2">
          <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${phase === 'saving' ? 'bg-overlay' : phase === 'saved' ? 'bg-green' : 'bg-red'}`} />
          <div>
            {phase === 'failed' ? (
              <>
                <p className="text-red">{result.failure.message}</p>
                <p className="text-subtext">{result.failure.fix}</p>
              </>
            ) : <p className={phase === 'saved' ? 'text-green' : 'text-subtext'}>{phase === 'saved' ? 'Saved' : 'Saving'}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

interface Props {
  readonly initialProject?: Project;
  readonly fromRuns: boolean;
  onCreated(id: string): void;
  onCancel(): void;
  onDone(): void;
}

export function ProjectEditor({ initialProject, fromRuns, onCreated, onCancel, onDone }: Props): ReactNode {
  const client = useControlPlaneClient();
  const { publish } = useProjectDirectory();
  const [saved, setSaved] = useState(initialProject);
  const [draft, setDraft] = useState(() => projectDraft(initialProject));
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [result, setResult] = useState<SaveResult>({ phase: 'idle' });
  const staged = useRef<Partial<Record<SettingKey, string>>>({});
  const busy = useRef(false);
  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      staged.current = {};
    };
  }, []);

  const { plan, errors } = prepareSave(draft, saved);
  const saving = result.phase === 'saving';
  const canSave = plan !== undefined && !Object.keys(errors).length && !saving;
  const fieldError = (name: FieldName, showLocal = true): string | undefined =>
    serverErrors[name] ?? (showLocal ? errors[name] : undefined);

  function clearErrors(predicate: (field: FieldName) => boolean): void {
    setServerErrors((current) => {
      const next = { ...current };
      for (const field of Object.keys(next) as FieldName[]) {
        if (predicate(field)) delete next[field];
      }
      return next;
    });
    setResult((current) => current.phase === 'saved' ? { phase: 'idle' } : current);
  }

  function setProjectField(key: 'displayName' | 'repoUrl', value: string): void {
    if (busy.current) return;
    setDraft((current) => ({ ...current, [key]: value }));
    clearErrors((field) => field === key);
  }

  function setHostField(key: keyof typeof draft.hostRepository, value: string): void {
    if (busy.current) return;
    setDraft((current) => ({ ...current, hostRepository: { ...current.hostRepository, [key]: value } }));
    clearErrors((field) => field.startsWith('hostRepository.'));
  }

  function changeProvider(key: SettingKey, provider: string | null): void {
    if (busy.current || provider === draft[key].provider) return;
    delete staged.current[key];
    // Reselecting the saved provider restores only its public fields, never discarded input.
    const previous = saved?.[key] ?? null;
    setDraft((current) => ({
      ...current,
      [key]: settingDraft(provider === previous?.provider ? previous : provider === null ? null : { provider })
    }));
    clearErrors((field) => field.startsWith(`${key}.`));
  }

  function setSettingField(key: SettingKey, field: 'projectKey' | 'url' | 'credential', value: string): void {
    if (busy.current || draft[key].provider === null || draft[key][field] === value) return;
    if (field === 'credential') delete staged.current[key];
    setDraft((current) => ({ ...current, [key]: { ...current[key], [field]: value } }));
    clearErrors((name) => name === `${key}.${field === 'credential' ? 'credentialRef' : field}`);
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSave || plan === undefined || busy.current) return;
    busy.current = true;
    setResult({ phase: 'saving' });
    setServerErrors({});
    try {
      // The draft and validated request belong to this attempt. The inputs are locked
      // until it settles. A staged handle is valid only until its input is changed.
      for (const key of SETTING_KEYS) {
        const value = draft[key].credential;
        if (draft[key].provider === null || value === '') continue;
        let handle = staged.current[key];
        if (handle === undefined) {
          ({ handle } = await client.createSecret({ value }));
          if (!active.current) return;
          staged.current[key] = handle;
        }
        attachCredential(plan.request, key, handle, saved?.[key]?.credentialRef?.label);
      }
      const project = plan.mode === 'create'
        ? await client.createProject(createProjectRequestSchema.parse(plan.request))
        : await client.updateProject(plan.id, updateProjectRequestSchema.parse(plan.request));
      if (active.current) {
        staged.current = {};
        setSaved(project);
        setDraft(projectDraft(project));
        setResult({ phase: 'saved' });
      }
      publish(project);
      if (active.current && plan.mode === 'create') onCreated(project.id);
    } catch (error) {
      if (!active.current) return;
      const failure = saveFailure(error);
      for (const key of failure.rejected ?? []) delete staged.current[key];
      setServerErrors(failure.errors ?? {});
      setResult({ phase: 'failed', failure });
    } finally {
      busy.current = false;
    }
  }

  function renderSetting(key: SettingKey, title: string): ReactNode {
    const section = draft[key];
    const configured = section.provider !== null;
    const disabled = saving || !configured;
    const hasStoredValue = configured && saved?.[key]?.credentialRef !== undefined;
    return (
      <FormGroup title={title}>
        <ProviderSelect
          label={`${title} provider`}
          provider={section.provider}
          savedProvider={saved?.[key]?.provider}
          optional
          disabled={saving}
          error={fieldError(`${key}.provider`)}
          onChange={(provider) => changeProvider(key, provider)}
        />
        {key === 'issueTrackerSetting' ? (
          <TextField
            label="Project key" value={section.projectKey} disabled={disabled}
            error={fieldError('issueTrackerSetting.projectKey')} onChange={(value) => setSettingField(key, 'projectKey', value)}
          />
        ) : null}
        <TextField
          label={`${title} URL`} value={section.url} type="url" disabled={disabled}
          error={fieldError(`${key}.url`)} onChange={(value) => setSettingField(key, 'url', value)}
        />
        <WriteOnlySecretField
          secretName="Credential"
          hasStoredValue={hasStoredValue}
          required={configured && !hasStoredValue}
          disabled={disabled}
          value={section.credential}
          error={fieldError(`${key}.credentialRef`)}
          onValueChange={(value) => setSettingField(key, 'credential', value)}
        />
      </FormGroup>
    );
  }

  return (
    <SettingsPage title={saved === undefined ? 'Add project' : 'Edit project'} focusTitle>
      <form noValidate className="flex flex-col gap-4" onSubmit={(event) => { void save(event); }}>
        <FormGroup title="Project">
          <TextField
            label="Display name" value={draft.displayName} disabled={saving} required
            error={fieldError('displayName', draft.displayName !== '')} onChange={(value) => setProjectField('displayName', value)}
          />
          {saved === undefined ? (
            <TextField
              label="Repository URL" value={draft.repoUrl} type="url" disabled={saving} required
              error={fieldError('repoUrl', draft.repoUrl !== '')} onChange={(value) => setProjectField('repoUrl', value)}
            />
          ) : <dl className="text-sm"><dt className="font-medium">Repository URL</dt><dd className="break-all text-subtext">{saved.repoUrl}</dd></dl>}
        </FormGroup>
        <FormGroup title="Host repository">
          {saved === undefined ? (
            <>
              <ProviderSelect
                label="Repository provider" provider={draft.hostRepository.provider} disabled={saving}
                error={fieldError('hostRepository.provider', false)} onChange={(value) => setHostField('provider', value ?? '')}
              />
              <TextField
                label="Repository owner" value={draft.hostRepository.owner} disabled={saving} required
                error={fieldError('hostRepository.owner', draft.hostRepository.owner !== '')} onChange={(value) => setHostField('owner', value)}
              />
              <TextField
                label="Repository name" value={draft.hostRepository.name} disabled={saving} required
                error={fieldError('hostRepository.name', draft.hostRepository.name !== '')} onChange={(value) => setHostField('name', value)}
              />
            </>
          ) : (
            <>
              <p className="break-all text-sm">{providerLabel(saved.hostRepository.provider)} · {saved.hostRepository.owner}/{saved.hostRepository.name}</p>
              <p className="text-xs text-subtext">The repository binding cannot change.</p>
              {serverErrors['hostRepository.provider'] ? <p className="text-sm text-red">{serverErrors['hostRepository.provider']}</p> : null}
            </>
          )}
        </FormGroup>
        {renderSetting('issueTrackerSetting', 'Issue tracker')}
        {renderSetting('codeHostSetting', 'Code host')}
        {SETTING_KEYS.every((key) => draft[key].provider === null) ? (
          <p className="text-sm text-subtext">Runs cannot read issues or open pull requests for this project.</p>
        ) : null}
        <SaveStatus result={result} />
        <div className="flex justify-end gap-2">
          <Button
            type="button" variant="secondary" disabled={saving}
            onClick={() => {
              if (!busy.current) {
                if (result.phase === 'saved') onDone();
                else onCancel();
              }
            }}
          >
            {result.phase === 'saved' ? fromRuns ? 'Back to runs' : 'Done' : 'Cancel'}
          </Button>
          <Button type="submit" disabled={!canSave}>Save</Button>
        </div>
      </form>
    </SettingsPage>
  );
}
