import {
  conflictErrorCode,
  createProjectRequestSchema,
  secretStoreLockedErrorCode,
  unknownCredentialReferenceErrorCode,
  updateProjectRequestSchema,
  validationErrorCode,
  type CreateProjectRequest,
  type Project,
  type ProjectSettingReference,
  type UpdateProjectRequest
} from '@autocatalyst/api-contract';
import { ControlPlaneClientError } from '@autocatalyst/sdk';

export const SETTING_KEYS = ['issueTrackerSetting', 'codeHostSetting'] as const;
export type SettingKey = typeof SETTING_KEYS[number];

export interface SettingDraft {
  readonly provider: string | null;
  readonly projectKey: string;
  readonly url: string;
  readonly credential: string;
}

export interface ProjectDraft {
  readonly displayName: string;
  readonly repoUrl: string;
  readonly hostRepository: { readonly provider: string; readonly owner: string; readonly name: string };
  readonly issueTrackerSetting: SettingDraft;
  readonly codeHostSetting: SettingDraft;
}

export function settingDraft(saved: ProjectSettingReference | null): SettingDraft {
  return {
    provider: saved?.provider ?? null,
    projectKey: saved?.projectKey ?? '',
    url: saved?.url ?? '',
    credential: ''
  };
}

export function projectDraft(saved?: Project): ProjectDraft {
  const host = saved?.hostRepository;
  return {
    displayName: saved?.displayName ?? '',
    repoUrl: saved?.repoUrl ?? '',
    hostRepository: { provider: host?.provider ?? '', owner: host?.owner ?? '', name: host?.name ?? '' },
    issueTrackerSetting: settingDraft(saved?.issueTrackerSetting ?? null),
    codeHostSetting: settingDraft(saved?.codeHostSetting ?? null)
  };
}

const FIELD_COPY = {
  displayName: 'Enter a display name.',
  repoUrl: 'Enter a valid HTTPS URL.',
  'hostRepository.provider': 'Select a repository provider.',
  'hostRepository.owner': 'Enter the repository owner.',
  'hostRepository.name': 'Enter the repository name.',
  'issueTrackerSetting.provider': 'Select an issue tracker provider.',
  'issueTrackerSetting.projectKey': 'Enter a valid project key.',
  'issueTrackerSetting.url': 'Enter a valid HTTPS URL.',
  'issueTrackerSetting.credentialRef': 'Enter a credential.',
  'codeHostSetting.provider': 'Select a code host provider.',
  'codeHostSetting.url': 'Enter a valid HTTPS URL.',
  'codeHostSetting.credentialRef': 'Enter a credential.'
} as const;

export type FieldName = keyof typeof FIELD_COPY;
export type FieldErrors = Partial<Record<FieldName, string>>;

type SavePlan =
  | { readonly mode: 'create'; readonly request: CreateProjectRequest }
  | { readonly mode: 'edit'; readonly id: string; readonly request: UpdateProjectRequest };

function isFieldName(path: string): path is FieldName {
  return Object.hasOwn(FIELD_COPY, path);
}

/** Accept only allowlisted control paths. Never render messages from validation details. */
function issueFields(issues: unknown): FieldErrors {
  const errors: FieldErrors = {};
  if (!Array.isArray(issues)) return errors;
  for (const issue of issues) {
    if (typeof issue !== 'object' || issue === null || !('path' in issue)) continue;
    const path: unknown = issue.path;
    if (!Array.isArray(path) || !path.every((part) => typeof part === 'string')) continue;
    const name = path.join('.').replace(/\.credentialRef\..*$/u, '.credentialRef');
    if (isFieldName(name)) errors[name] = FIELD_COPY[name];
  }
  return errors;
}

function settingRequest(
  draft: SettingDraft,
  saved: ProjectSettingReference | null,
  key: SettingKey,
  errors: FieldErrors
): ProjectSettingReference | null | undefined {
  if (draft.provider === null) return saved === null ? undefined : null;
  const projectKey = (key === 'codeHostSetting' ? saved?.projectKey : draft.projectKey.trim()) || undefined;
  const url = draft.url.trim() || undefined;
  if (draft.credential === '' && saved?.credentialRef === undefined) {
    errors[`${key}.credentialRef`] = FIELD_COPY[`${key}.credentialRef`];
  }
  if (
    draft.credential === '' && draft.provider === saved?.provider &&
    (key === 'codeHostSetting' || draft.projectKey === (saved.projectKey ?? '') || projectKey === saved.projectKey) &&
    (draft.url === (saved.url ?? '') || url === saved.url)
  ) return undefined;
  return {
    provider: draft.provider,
    ...(projectKey !== undefined ? { projectKey } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(draft.credential === '' && saved?.credentialRef !== undefined ? { credentialRef: saved.credentialRef } : {})
  };
}

/** Validate and diff the exact non-secret shape that will be written. */
export function prepareSave(draft: ProjectDraft, saved?: Project): { plan?: SavePlan; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const displayName = draft.displayName.trim();
  const issueTrackerSetting = settingRequest(draft.issueTrackerSetting, saved?.issueTrackerSetting ?? null, 'issueTrackerSetting', errors);
  const codeHostSetting = settingRequest(draft.codeHostSetting, saved?.codeHostSetting ?? null, 'codeHostSetting', errors);
  if (saved === undefined) {
    const result = createProjectRequestSchema.safeParse({
      displayName,
      repoUrl: draft.repoUrl.trim(),
      hostRepository: {
        provider: draft.hostRepository.provider,
        owner: draft.hostRepository.owner.trim(),
        name: draft.hostRepository.name.trim()
      },
      issueTrackerSetting: issueTrackerSetting ?? null,
      codeHostSetting: codeHostSetting ?? null
    });
    if (!result.success) return { errors: { ...errors, ...issueFields(result.error.issues) } };
    return { plan: { mode: 'create', request: result.data }, errors };
  }

  const patch: UpdateProjectRequest = {
    ...(draft.displayName !== saved.displayName && displayName !== saved.displayName ? { displayName } : {}),
    ...(issueTrackerSetting !== undefined ? { issueTrackerSetting } : {}),
    ...(codeHostSetting !== undefined ? { codeHostSetting } : {})
  };
  if (Object.keys(patch).length === 0) return { errors };
  const result = updateProjectRequestSchema.safeParse(patch);
  if (!result.success) return { errors: { ...errors, ...issueFields(result.error.issues) } };
  return { plan: { mode: 'edit', id: saved.id, request: result.data }, errors };
}

export function attachCredential(
  request: CreateProjectRequest | UpdateProjectRequest, key: SettingKey, handle: string, label?: string
): void {
  const setting = request[key];
  if (setting != null) {
    request[key] = {
      ...setting,
      credentialRef: {
        id: handle,
        purpose: key === 'issueTrackerSetting' ? 'issue_tracker' : 'code_host',
        ...(label !== undefined ? { label } : {})
      }
    };
  }
}

export interface SaveFailure {
  readonly message: string;
  readonly fix: string;
  readonly errors?: FieldErrors;
  readonly rejected?: readonly SettingKey[];
}

export function saveFailure(error: unknown): SaveFailure {
  if (error instanceof ControlPlaneClientError) {
    const { code, details } = error.response.error;
    const info = typeof details === 'object' && details !== null ? details : {};
    if (error.status === 400 && code === validationErrorCode) {
      const errors = issueFields('issues' in info ? info.issues : undefined);
      return {
        message: 'Failed',
        fix: Object.keys(errors).length ? 'Correct the marked fields and try again.' : 'Check the project settings and try again.',
        errors
      };
    }
    if (error.status === 422 && code === unknownCredentialReferenceErrorCode) {
      const fields = 'fields' in info ? info.fields : undefined;
      const rejected = SETTING_KEYS.filter((key) => Array.isArray(fields) && fields.includes(`${key}.credentialRef`));
      const errors: FieldErrors = {};
      for (const key of rejected) errors[`${key}.credentialRef`] = 'Enter this credential again.';
      return { message: 'Failed: a credential was not found', fix: 'Enter the credential again and save.', errors, rejected };
    }
    if (error.status === 409 && code === conflictErrorCode) {
      const message = 'This repository already has a project.';
      return {
        message: 'Failed: a project for this repository already exists',
        fix: 'Edit the existing project instead.',
        errors: { 'hostRepository.provider': message, 'hostRepository.owner': message, 'hostRepository.name': message }
      };
    }
    if (error.status === 400 && code === secretStoreLockedErrorCode) {
      return {
        message: "Failed: the control plane's secret store is locked",
        fix: 'Ask the control plane operator to unlock it, then try again.'
      };
    }
    if (error.status === 403) return { message: 'Failed: access denied', fix: 'Check your permissions and try again.' };
  } else if (error instanceof TypeError) {
    return { message: 'Failed: Connection lost', fix: 'Check your connection and try again.' };
  }
  return { message: 'Failed', fix: 'Try saving again. If the problem persists, contact the control plane operator.' };
}
