import type { Artifact, ArtifactStatus } from '../types/artifact.js';
import { channelKey } from '../types/channel.js';
import type { Run } from '../types/runs.js';

export interface ArtifactRefs {
  artifact: Artifact;
  local_path: string;
  publication_ref: string;
}

export function artifactFromRun(run: Run): Artifact | undefined {
  return run.artifact;
}

export function artifactPath(run: Run): string | undefined {
  return artifactFromRun(run)?.local_path;
}

export function artifactPublisherId(run: Run): string | undefined {
  return artifactFromRun(run)?.published_ref?.id;
}

export function artifactPublishedUrl(run: Run): string | undefined {
  const artifact = artifactFromRun(run);
  return artifact?.published_ref?.url;
}

export function requireArtifactRefs(run: Run): ArtifactRefs | undefined {
  const artifact = artifactFromRun(run);
  const local_path = artifact?.local_path;
  const publication_ref = artifact?.published_ref?.id;
  if (!artifact || !local_path || !publication_ref) return undefined;

  return {
    artifact,
    local_path,
    publication_ref,
  };
}

export function markArtifactStatus(run: Run, status: ArtifactStatus, issue_number?: number): void {
  const artifact = artifactFromRun(run);
  if (!artifact) return;
  run.artifact = {
    ...artifact,
    status,
    // The active issue provider is selected by composition; this neutral ref
    // marks the linked issue without coupling core state to an implementation.
    ...(issue_number !== undefined ? { linked_issue: { provider: 'issue_tracker', number: issue_number } } : {}),
  };
}

export function runChannelKey(run: Run): string {
  if (run.channel) return channelKey(run.channel);
  if (run.conversation) {
    return channelKey({ provider: run.conversation.provider, id: run.conversation.channel_id });
  }
  throw new Error(`Run ${run.id} is missing channel routing metadata`);
}
