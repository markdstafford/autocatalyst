import type { Project } from '@autocatalyst/api-contract';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import { hasBearerToken } from '../auth/token-store.js';
import { useControlPlaneConnection } from '../client/client-provider.js';
import { SettingsPage } from '../settings/settings-page.js';
import { CONNECTION_PATH, NEW_PROJECT_PATH, PROJECTS_PATH, RUNS_PATH, projectPath } from '../shell/navigation.js';
import { Button } from '../ui/button.js';
import { EmptyState } from '../ui/empty-state.js';
import { useProjectDirectory } from './project-directory.js';
import { ProjectEditor, providerLabel } from './project-editor.js';
import { ProjectEmptyState } from './project-empty-state.js';

const ADD_FOCUS = 'add-project';
const rowFocus = (id: string): string => `edit-project-${id}`;

export function ProjectsPage(): ReactNode {
  const { client, authorization } = useControlPlaneConnection();
  const navigate = useNavigate();
  const [scope, setScope] = useState({ client, key: 0 });
  // A different client cannot reuse any loaded record, local draft, or staged upload.
  if (scope.client !== client) setScope({ client, key: scope.key + 1 });

  useEffect(() => {
    if (authorization === 'unauthorized') navigate(CONNECTION_PATH, { replace: true });
  }, [authorization, navigate]);

  if (!hasBearerToken()) {
    return (
      <SettingsPage>
        <EmptyState
          title="Connect to the control plane"
          message="Enter a bearer token in Connection settings to manage projects."
          action={{ label: 'Open connection settings', onClick: () => navigate(CONNECTION_PATH) }}
        />
      </SettingsPage>
    );
  }
  return <ProjectRoute key={scope.key} />;
}

function ProjectRoute(): ReactNode {
  const { projectId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const restoreFocus = useRef<string | undefined>(undefined);
  const [created, setCreated] = useState<{ id: string; entryKey: string }>();
  // Keep the editor mounted for the one /new → saved address replacement only.
  useLayoutEffect(() => {
    if (created !== undefined && projectId !== created.id && location.key !== created.entryKey) setCreated(undefined);
  }, [created, projectId, location.key]);

  if (projectId === undefined) {
    return <ProjectsList restoreFocus={restoreFocus} />;
  }

  const isNew = projectId === 'new';
  const fromCreate = !isNew && created?.id === projectId;
  const entryKey = isNew ? location.key : fromCreate ? created?.entryKey : undefined;
  const fromRuns = location.state?.fromRuns === true;
  const actions = {
    onCancel: () => {
      restoreFocus.current = isNew || fromCreate ? ADD_FOCUS : rowFocus(projectId);
      navigate(PROJECTS_PATH);
    },
    onDone: () => navigate(fromRuns ? RUNS_PATH : PROJECTS_PATH),
    onCreated: (id: string) => {
      setCreated({ id, entryKey: location.key });
      navigate(projectPath(id), { replace: true, ...(fromRuns ? { state: { fromRuns: true } } : {}) });
    }
  };

  return entryKey !== undefined
    ? <ProjectEditor key={`create:${entryKey}`} fromRuns={fromRuns} {...actions} />
    : <EditProject key={projectId} id={projectId} {...actions} />;
}

type EditorActions = Pick<Parameters<typeof ProjectEditor>[0], 'onCreated' | 'onCancel' | 'onDone'>;

function EditProject({ id, ...actions }: EditorActions & { readonly id: string }): ReactNode {
  const { client } = useControlPlaneConnection();
  const [record, setRecord] = useState<Project | null>();
  useEffect(() => {
    let active = true;
    void client.getProject(id).then(
      (project) => { if (active) setRecord(project); },
      () => { if (active) setRecord(null); }
    );
    return () => { active = false; };
  }, [client, id]);

  if (record === undefined) return <SettingsPage title="Edit project"><p className="text-sm text-subtext">Loading project…</p></SettingsPage>;
  if (record === null) {
    return (
      <SettingsPage title="Project could not be loaded">
        <p className="text-sm text-subtext">Check the address and your access, then open the project again.</p>
        <Link className="text-sm text-primary underline" to={PROJECTS_PATH}>Back to projects</Link>
      </SettingsPage>
    );
  }
  return <ProjectEditor initialProject={record} fromRuns={false} {...actions} />;
}

function ProjectsList({ restoreFocus }: { readonly restoreFocus: { current: string | undefined } }): ReactNode {
  const { phase, projects, refresh } = useProjectDirectory();
  const navigate = useNavigate();
  const empty = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const target = restoreFocus.current;
    if (phase !== 'ready' || target === undefined) return;
    restoreFocus.current = undefined;
    if (target === ADD_FOCUS && projects.length === 0) empty.current?.querySelector('button')?.focus();
    else document.getElementById(target)?.focus();
  }, [phase, projects, restoreFocus]);

  if (phase === 'ready' && projects.length === 0) {
    return <SettingsPage><div ref={empty} className="h-full"><ProjectEmptyState /></div></SettingsPage>;
  }

  return (
    <SettingsPage title="Projects">
      {phase === 'loading' ? <p className="text-sm text-subtext">Loading projects…</p> : phase === 'error' ? (
        <div className="flex flex-col items-start gap-2 text-sm">
          <p>Projects could not be loaded.</p>
          <Button variant="secondary" onClick={() => { void refresh(); }}>Retry</Button>
        </div>
      ) : (
        <>
          <ul className="mb-4 divide-y divide-border border-y border-border">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  id={rowFocus(project.id)}
                  className="flex flex-col gap-1 rounded-sm px-2 py-2 text-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
                  to={projectPath(project.id)}
                >
                  <span className="break-all font-medium">{project.displayName}</span>
                  <span className="break-all text-subtext">{project.hostRepository.owner}/{project.hostRepository.name}</span>
                  <span className="break-all text-xs text-subtext">
                    Issue tracker: {project.issueTrackerSetting === null ? '—' : providerLabel(project.issueTrackerSetting.provider)}
                    {' · '}
                    Code host: {project.codeHostSetting === null ? '—' : providerLabel(project.codeHostSetting.provider)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button id={ADD_FOCUS} onClick={() => navigate(NEW_PROJECT_PATH)}>Add project</Button>
          </div>
        </>
      )}
    </SettingsPage>
  );
}
