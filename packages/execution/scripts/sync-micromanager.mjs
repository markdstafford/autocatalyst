/** Pinned upstream synchronization and verification. No operator plugin cache is used. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptRoot, '../../..');
const selection = JSON.parse(readFileSync(path.join(scriptRoot, 'micromanager-selection.json'), 'utf8'));
const assetRoot = path.join(workspaceRoot, 'packages/execution/src/skills/assets/mm');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 16 * 1024 * 1024 });
const fail = (message) => { throw new Error(message); };

function files(root, prefix = '') {
  return readdirSync(path.join(root, prefix)).flatMap((name) => {
    const relative = path.posix.join(prefix, name);
    const stat = lstatSync(path.join(root, relative));
    if (stat.isSymbolicLink()) fail(`Unexpected symlink: ${relative}`);
    return stat.isDirectory() ? files(root, relative) : [relative];
  }).sort();
}

export function verifyTree(root, manifest) {
  const expected = [...Object.keys(manifest.files), 'SOURCE.json'].sort();
  const actual = files(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`Missing or unexpected Micromanager files in ${root}`);
  for (const [file, digest] of Object.entries(manifest.files)) {
    if (hash(readFileSync(path.join(root, file))) !== digest) fail(`Micromanager content mismatch: ${file}`);
  }
  if (readFileSync(path.join(root, 'SOURCE.json'), 'utf8') !== JSON.stringify(manifest, null, 2) + '\n') {
    fail(`Micromanager provenance mismatch: ${root}/SOURCE.json`);
  }
}

function upstreamFiles(repo) {
  // Read immutable Git blobs, never a potentially dirty upstream working tree.
  const entries = git(repo, 'ls-tree', '-r', '--full-tree', selection.commit).toString().trim().split('\n');
  const selected = entries.map((line) => {
    const [meta, file] = line.split('\t');
    const [mode, type, oid] = meta.split(' ');
    return { mode, type, oid, file };
  }).filter(({ file }) => selection.resources.includes(file) || Object.values(selection.skills).some(({ path: p }) => file.startsWith(p + '/')));
  for (const resource of selection.resources) {
    if (!selected.some(({ file }) => file === resource)) fail(`Missing upstream resource: ${resource}`);
  }
  const result = new Map();
  for (const { mode, type, oid, file } of selected) {
    if (type !== 'blob' || mode !== '100644') fail(`Unsupported upstream entry: ${file} (${mode})`);
    result.set(file, git(repo, 'cat-file', 'blob', oid));
  }
  const plugin = JSON.parse(result.get('plugins/mm/.claude-plugin/plugin.json'));
  if (plugin.version !== selection.pluginVersion) fail('Pinned plugin version does not match selection');
  const missing = new Set();
  const mentionedSkills = new Set();
  for (const [file, bytes] of result) {
    if (!file.endsWith('.md')) continue;
    const skill = Object.values(selection.skills).find(({ path: p }) => file.startsWith(p + '/'));
    if (!skill) continue;
    const content = bytes.toString();
    for (const match of content.matchAll(/\b(?:mm|superpowers):[a-z][a-z-]+/g)) mentionedSkills.add(match[0]);
    for (const match of content.matchAll(/\breferences\/[a-zA-Z0-9_./-]+\.(?:md|yaml)\b/g)) {
      const target = `${skill.path}/${match[0]}`;
      if (!result.has(target)) missing.add(target);
    }
    for (const [name, target] of Object.entries(selection.supplementalReferences)) {
      if (content.includes(name) && !result.has(target)) fail(`Missing upstream supplemental reference: ${name} -> ${target}`);
    }
  }
  const knownMissing = [...selection.missingUpstreamReferences].sort();
  if (JSON.stringify([...missing].sort()) !== JSON.stringify(knownMissing)) {
    fail(`Upstream missing references changed. Review selection: ${JSON.stringify([...missing].sort())}`);
  }
  for (const ref of mentionedSkills) {
    if (!selection.skills[ref] && !selection.excludedSkillReferences[ref]) fail(`Unresolved upstream skill dependency: ${ref}`);
  }
  for (const [ref, skill] of Object.entries(selection.skills)) {
    if (!result.has(`${skill.path}/SKILL.md`)) fail(`Missing upstream skill: ${ref}`);
    for (const dependency of skill.dependencies) {
      if (!selection.skills[dependency]) fail(`Missing selected dependency: ${ref} -> ${dependency}`);
    }
  }
  return result;
}

export function run(args = process.argv.slice(2)) {
  const sync = args.includes('--sync');
  const upstream = sync || args.includes('--upstream');
  const dist = args.includes('--dist');
  const repoIndex = args.indexOf('--upstream-repo');
  let temporary;
  try {
    let manifest;
    if (upstream) {
      let repo = repoIndex >= 0 ? path.resolve(args[repoIndex + 1]) : undefined;
      if (!/^[a-f0-9]{40}$/.test(selection.commit)) fail('Pin must be a full immutable commit SHA');
      if (!repo) {
        temporary = mkdtempSync(path.join(tmpdir(), 'autocatalyst-mm-'));
        repo = temporary;
        git(repo, 'init', '--quiet');
        git(repo, 'fetch', '--quiet', '--depth=1', selection.repository, selection.commit);
      }
      if (git(repo, 'rev-parse', `${selection.commit}^{commit}`).toString().trim() !== selection.commit) fail('Upstream commit mismatch');
      const content = upstreamFiles(repo);
      manifest = { ...selection, files: Object.fromEntries([...content].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([file, bytes]) => [file, hash(bytes)])) };
      if (sync) {
        rmSync(assetRoot, { recursive: true, force: true });
        for (const [file, bytes] of content) {
          mkdirSync(path.dirname(path.join(assetRoot, file)), { recursive: true });
          writeFileSync(path.join(assetRoot, file), bytes);
        }
        writeFileSync(path.join(assetRoot, 'SOURCE.json'), JSON.stringify(manifest, null, 2) + '\n');
      }
    } else {
      manifest = JSON.parse(readFileSync(path.join(assetRoot, 'SOURCE.json'), 'utf8'));
      const { files: digests, ...recordedSelection } = manifest;
      if (JSON.stringify(recordedSelection) !== JSON.stringify(selection)) fail('Selection and provenance differ; synchronize from upstream');
      if (!digests || !Object.keys(digests).length) fail('Missing upstream content hashes');
    }
    verifyTree(assetRoot, manifest);
    if (dist) verifyTree(path.join(workspaceRoot, 'packages/execution/dist/src/skills/assets/mm'), manifest);
    for (const file of selection.missingUpstreamReferences) console.warn(`UPSTREAM MISSING (optional example; not fabricated): ${file}`);
    console.log(`Micromanager ${selection.pluginVersion} @ ${selection.commit}: ${Object.keys(manifest.files).length} files verified${upstream ? ' against upstream Git blobs' : ' against pinned hashes'}${dist ? ' (source + dist)' : ''}`);
  } finally {
    if (temporary && existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
