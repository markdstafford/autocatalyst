import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fullGitSha, type PublicationGitPort, type PublicationWorkspace } from '@autocatalyst/core';

const exec = promisify(execFile);
const timeoutMs = 25_000;
const operationMarkers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START', 'index.lock'];

function ref(branch: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,249}$/u.test(branch) || branch.includes('..')) throw new Error('publication_ref_invalid');
  return `refs/heads/${branch}`;
}

function sha(stdout: string): string {
  return fullGitSha.parse(stdout.trim());
}

function safePath(path: string): boolean {
  return path.length > 0 && path.length <= 240 && !/[\\\p{C}]/u.test(path) &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..') &&
    !/(?:gh[pousr]_|github_pat_|sk-|AKIA)[a-z\d_-]{8,}/iu.test(path);
}

export function createPublicationGit(workspacesRoot: string): PublicationGitPort {
  async function git(input: PublicationWorkspace, args: readonly string[], remote = false, authorize?: () => Promise<boolean>): Promise<string> {
    const [root, cwd] = await Promise.all([realpath(input.workspaceRootOverride ?? workspacesRoot), realpath(input.workspaceRepoRoot)]);
    const contained = relative(root, cwd);
    if (contained === '' || contained === '..' || contained.startsWith(`..${sep}`)) throw new Error('publication_workspace_outside_root');
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const config = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'gc.auto=0', '-c', 'rerere.enabled=false'];
    if (remote) {
      if (!/^(?:https:\/\/[^\s]+|ssh:\/\/[^\s]+|git@[\w.-]+:[\w./-]+|file:\/\/\/[^\r\n]+|\/[^\r\n]+)$/u.test(input.remote)) {
        throw new Error('publication_remote_invalid');
      }
      if (/^(?:https|ssh|file):/u.test(input.remote)) {
        const url = new URL(input.remote);
        if (url.password !== '' || url.search !== '' || url.hash !== '' ||
            (url.username !== '' && (url.protocol !== 'ssh:' || url.username !== 'git'))) throw new Error('publication_remote_invalid');
        if (url.protocol === 'https:' && url.hostname === 'github.com' &&
            url.pathname.replace(/\.git$/u, '').toLowerCase() !== `/${input.repository}`.toLowerCase()) {
          throw new Error('publication_remote_binding_changed');
        }
      }
      const normalized = input.remote.toLowerCase();
      const bound = `https://github.com/${input.repository}`.toLowerCase();
      if (normalized === bound || normalized === `${bound}.git`) {
        Object.assign(env, {
          GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${input.token}`).toString('base64')}`
        });
      }
      config.push('-c', 'protocol.ext.allow=never', '-c', 'http.followRedirects=false');
    }
    if (authorize !== undefined && !await authorize()) throw new Error('repair_claim_retired');
    return (await exec('git', [...config, ...args], { cwd, env, timeout: timeoutMs, maxBuffer: 1024 * 1024 })).stdout;
  }

  async function candidate(input: PublicationWorkspace): Promise<string> {
    if ((await git(input, ['symbolic-ref', '-q', 'HEAD'])).trim() !== ref(input.branch)) throw new Error('publication_branch_changed');
    if ((await git(input, ['rev-parse', '--show-prefix'])).trim() !== '') throw new Error('publication_workspace_not_root');
    if ((await git(input, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length !== 0) throw new Error('publication_workspace_dirty');
    for (const marker of operationMarkers) {
      const path = (await git(input, ['rev-parse', '--git-path', marker])).trim();
      try {
        await access(resolve(input.workspaceRepoRoot, path));
        throw new Error('publication_workspace_busy');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return sha(await git(input, ['rev-parse', '--verify', 'HEAD^{commit}']));
  }

  async function remoteHead(input: PublicationWorkspace, branch: string): Promise<string | null> {
    const expectedRef = ref(branch);
    const output = await git(input, ['ls-remote', '--refs', '--', input.remote, expectedRef], true);
    if (output === '') return null;
    const [head, reported, ...rest] = output.trimEnd().split('\t');
    if (reported !== expectedRef || rest.length > 0) throw new Error('publication_remote_ref_invalid');
    return sha(head ?? '');
  }

  const readCandidate: PublicationGitPort['readCandidate'] = async input => candidate(input).catch(() => null);
  return {
    readCandidate,
    async readTarget(input) {
      return remoteHead(input, input.base).catch(() => null);
    },
    async readSource(input) {
      return remoteHead(input, input.branch).catch(() => null);
    },
    async integrate(input) {
      const sourceSha = await readCandidate(input);
      if (sourceSha === null) return { kind: 'workspace_unavailable' };
      const pin = `refs/autocatalyst/integration/${randomUUID()}`;
      let targetSha: string;
      try {
        await git(input, ['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--refmap=', '--', input.remote, `${ref(input.base)}:${pin}`], true);
        targetSha = sha(await git(input, ['rev-parse', '--verify', `${pin}^{commit}`]));
      } catch {
        return { kind: 'target_unverified', sourceSha };
      } finally {
        await git(input, ['update-ref', '-d', pin]).catch(() => undefined);
      }
      if (await readCandidate(input) !== sourceSha) return { kind: 'workspace_unavailable' };
      try {
        // Merge strategies do not consistently honor --no-overwrite-ignore. Check for
        // incoming paths colliding with ignored untracked files or directories first.
        const mergeBase = sha(await git(input, ['merge-base', sourceSha, targetSha]));
        if (mergeBase === targetSha) return { kind: 'integrated', sourceSha, targetSha, headSha: sourceSha };
        const ignored = new Set((await git(input, [
          'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'
        ])).split('\0').filter(Boolean).map(path => path.replace(/\/$/u, '')));
        if (ignored.size > 0) {
          const incoming = (await git(input, [
            'diff', '--name-only', '--no-renames', '--diff-filter=ACMRT', '-z', mergeBase, targetSha, '--'
          ])).split('\0').filter(Boolean);
          const writes = new Set(incoming);
          const overlaps = (path: string, paths: ReadonlySet<string>) => {
            for (let prefix = path; prefix !== ''; prefix = prefix.slice(0, Math.max(0, prefix.lastIndexOf('/')))) {
              if (paths.has(prefix)) return true;
            }
            return false;
          };
          if (incoming.some(path => overlaps(path, ignored)) || [...ignored].some(path => overlaps(path, writes))) {
            return { kind: 'workspace_unavailable' };
          }
        }
        await git(input, ['merge', '--ff', '--no-edit', '--no-autostash', '--no-overwrite-ignore', '--no-verify', '--', targetSha]);
        const headSha = await candidate(input);
        return { kind: 'integrated', sourceSha, targetSha, headSha };
      } catch {
        const unmerged = await git(input, ['diff', '--name-only', '--diff-filter=U', '-z']).catch(() => '');
        if (unmerged === '') return { kind: 'workspace_unavailable' };
        const paths = [...new Set(unmerged.split('\0').filter(safePath))].sort().slice(0, 100);
        let cleanup: 'restored' | 'inspection_required' = 'inspection_required';
        try {
          const mergeHead = sha(await git(input, ['rev-parse', '--verify', 'MERGE_HEAD']));
          const head = sha(await git(input, ['rev-parse', '--verify', 'HEAD']));
          if (mergeHead === targetSha && head === sourceSha) {
            await git(input, ['merge', '--abort']);
            if (await readCandidate(input) === sourceSha) cleanup = 'restored';
          }
        } catch { /* Keep the workspace for host inspection. */ }
        return { kind: 'conflict', sourceSha, targetSha, paths, cleanup };
      }
    },
    async verifyFreeze(input, reviewedSha, freeze) {
      const publishSha = await readCandidate(input);
      if (freeze.commitSha === null) return publishSha === reviewedSha;
      if (publishSha !== freeze.commitSha || !fullGitSha.safeParse(publishSha).success || !safePath(freeze.artifactPath) ||
          freeze.expectedContents === undefined) return false;
      try {
        const parents = (await git(input, ['rev-list', '--parents', '-n', '1', publishSha])).trim();
        if (parents !== `${publishSha} ${reviewedSha}`) return false;
        const paths = await git(input, ['diff', '--no-renames', '--name-only', '-z', reviewedSha, publishSha, '--']);
        if (paths !== `${freeze.artifactPath}\0`) return false;
        const mode = async (commit: string) => (await git(input, ['--literal-pathspecs', 'ls-tree', commit, '--', freeze.artifactPath])).split(' ', 1)[0];
        const priorMode = await mode(reviewedSha);
        return (priorMode === '100644' || priorMode === '100755') && priorMode === await mode(publishSha) &&
          await git(input, ['show', `${publishSha}:${freeze.artifactPath}`]) === freeze.expectedContents;
      } catch { return false; }
    },
    async sameTree(input, first, second) {
      const tree = async (commit: string) => sha(await git(input, ['rev-parse', '--verify', `${fullGitSha.parse(commit)}^{tree}`]));
      return await tree(first) === await tree(second);
    },
    async pushCandidate(input, headSha, expectedOldHead, authorize) {
      try {
        if (await readCandidate(input) !== headSha) return 'unverified';
        const old = await remoteHead(input, input.branch);
        if (old === headSha) return 'already_present';
        if (expectedOldHead !== undefined) {
          if (old !== expectedOldHead) return 'unverified';
          await git(input, ['merge-base', '--is-ancestor', fullGitSha.parse(expectedOldHead), fullGitSha.parse(headSha)]);
        }
        const remoteRef = ref(input.branch);
        const report = await git(input, ['push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no',
          ...(expectedOldHead !== undefined ? [`--force-with-lease=${remoteRef}:${expectedOldHead}`] : []),
          '--', input.remote, `${fullGitSha.parse(headSha)}:${remoteRef}`], true, authorize)
          .catch(error => typeof error?.stdout === 'string' ? error.stdout as string : '');
        const update = report.split('\n').map(line => line.split('\t'))
          .find(([, updateRef]) => updateRef === `${headSha}:${remoteRef}`);
        // A head read by itself does not prove that this process wrote it. Require
        // Git's update acknowledgment too, even when the process exited with an error.
        if (update === undefined || await remoteHead(input, input.branch) !== headSha) return 'unverified';
        if (update[0] === '=') return 'already_present';
        return update[0] === ' ' || update[0] === '*' ? 'pushed' : 'unverified';
      } catch { return 'unverified'; }
    }
  };
}
