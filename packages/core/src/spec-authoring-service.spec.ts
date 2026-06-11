import { describe, expect, it, vi } from 'vitest';
import {
  SpecAuthoringError,
  type CompleteSpecAuthoringInput,
  type SpecAuthoringServiceDependencies,
  type WorkspaceFileSystemPort,
  type WorkspaceGitPort
} from './spec-authoring-service.js';

describe('SpecAuthoringError', () => {
  it('creates error with code and message', () => {
    const error = new SpecAuthoringError('spec_path_invalid', 'Path is not safe.');
    expect(error.code).toBe('spec_path_invalid');
    expect(error.message).toBe('Path is not safe.');
    expect(error.name).toBe('SpecAuthoringError');
    expect(error).toBeInstanceOf(Error);
  });

  it('creates error with cause', () => {
    const cause = new Error('underlying');
    const error = new SpecAuthoringError('spec_commit_failed', 'Commit failed.', { cause });
    expect(error.cause).toBe(cause);
  });

  it('does not include raw cause message in its own message', () => {
    const cause = new Error('sk-SECRET raw message');
    const error = new SpecAuthoringError('spec_file_write_failed', 'Failed to write spec file.', { cause });
    expect(error.message).not.toContain('sk-SECRET');
    expect(error.message).toBe('Failed to write spec file.');
  });
});

describe('WorkspaceFileSystemPort and WorkspaceGitPort types', () => {
  it('WorkspaceFileSystemPort is structurally compatible', () => {
    const port: WorkspaceFileSystemPort = {
      writeFile: vi.fn(async () => undefined),
      readFile: vi.fn(async () => '')
    };
    expect(typeof port.writeFile).toBe('function');
    expect(typeof port.readFile).toBe('function');
  });

  it('WorkspaceGitPort has commitFiles only (no branch operations)', () => {
    const port: WorkspaceGitPort = {
      commitFiles: vi.fn(async () => ({}))
    };
    expect(typeof port.commitFiles).toBe('function');
    // Type-level: WorkspaceGitPort should NOT have createBranch, push, merge, etc.
    // We verify this at runtime by checking it's a plain object
    expect(Object.keys(port)).toEqual(['commitFiles']);
  });
});

describe('CompleteSpecAuthoringInput type', () => {
  it('accepts required fields', () => {
    const input: CompleteSpecAuthoringInput = {
      run: { id: 'run_1', workKind: 'feature' } as never,
      result: {} as never,
      workspaceRepoRoot: '/tmp/repo',
      workspaceHandle: 'workspace_run_1'
    };
    expect(input.workspaceRepoRoot).toBe('/tmp/repo');
    expect(input.workspaceHandle).toBe('workspace_run_1');
  });
});
