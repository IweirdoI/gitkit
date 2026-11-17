import { appendFile, copyFile, lstat, mkdir, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type Repo, inside } from './context.js';
import { GitError } from './process.js';

export const MiB = 1024 ** 2;
export const binary = /\.(?:png|jpe?g|gif|webp|ico|heic|psd|tiff?|raw|dng|exr|dds|fbx|obj|gltf|glb|blend|usd[zc]?|stl|mp[34]|m4[av]|wav|flac|ogg|aac|aiff|mov|avi|mkv|webm|zip|7z|rar|gz|tar|xz|bz2|zst|pdf|parquet|feather|arrow|npy|npz|hdf5?|sqlite3?|bin|exe|dll|iso)$/i;
export const split = (text: string) => text.split('\0').filter(Boolean);

export async function worktreeAssets(repo: Repo, paths: string[], threshold: number) {
  const assets: { path: string; size: number; large: boolean; binary: boolean }[] = [];
  for (const path of new Set(paths)) {
    const filename = inside(repo.root, path);
    const info = await lstat(filename).catch(error => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    });
    if (!info?.isFile()) continue;
    let isBinary = binary.test(path);
    if (!isBinary) {
      const handle = await open(filename, 'r');
      try {
        const sample = Buffer.alloc(8192);
        const { bytesRead } = await handle.read(sample);
        isBinary = sample.subarray(0, bytesRead).includes(0);
      } finally { await handle.close(); }
    }
    if (isBinary || info.size > threshold) assets.push({ path, size: info.size, binary: isBinary, large: info.size > threshold });
  }
  return assets;
}

export async function attrs(repo: Repo, path: string, cached = false) {
  const output = (await repo.git(['check-attr', ...(cached ? ['--cached'] : []), '-z', 'filter', 'text', 'diff', 'merge', '--', path])).stdout.split('\0');
  return { filter: output[2], text: output[5], diff: output[8], merge: output[11] };
}

export const lfsVersion = async (repo: Repo) => repo.output(['lfs', 'version']).catch(error => {
  if (error instanceof GitError && error.code === 'git_failed') return null;
  throw error;
});

async function backupAssets(repo: Repo) {
  const destination = await repo.output(['rev-parse', '--path-format=absolute', '--git-path', `gitkit-backups/${randomUUID()}`]);
  await mkdir(destination, { recursive: true });
  for (const name of ['.gitattributes', 'index', 'config', 'hooks/pre-push']) {
    const source = name === '.gitattributes' ? join(repo.root, name)
      : await repo.output(['rev-parse', '--path-format=absolute', '--git-path', name]);
    const backup = join(destination, name);
    await mkdir(dirname(backup), { recursive: true });
    await copyFile(source, backup).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return destination;
}

/** Attribute patterns use Git's wildcard escaping and C-style quoting separately. */
function exactPattern(path: string) {
  const pattern = '/' + path.replace(/[\\*?\[\]]/g, '\\$&');
  return JSON.stringify(pattern);
}

export async function assetPlan(repo: Repo, paths: string[], threshold: number) {
  const assets = await worktreeAssets(repo, paths, threshold);
  const changes: { path: string; lfs: boolean }[] = [];
  for (const asset of assets) {
    const attributes = await attrs(repo, asset.path);
    if (asset.large && attributes.filter !== 'lfs') changes.push({ path: asset.path, lfs: true });
    else if (asset.binary && attributes.filter === 'unspecified' &&
      ['auto', 'unspecified'].includes(attributes.text) &&
      attributes.diff === 'unspecified' && attributes.merge === 'unspecified') changes.push({ path: asset.path, lfs: false });
  }
  return { assets, changes, needsLfs: changes.some(change => change.lfs) };
}

export async function applyAssetPlan(repo: Repo, plan: Awaited<ReturnType<typeof assetPlan>>) {
  if (!plan.changes.length) return null;
  const file = join(repo.root, '.gitattributes');
  const info = await lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (info && !info.isFile()) throw new GitError('attributes_invalid', '.gitattributes 必须是普通文件');
  if ((await repo.statuses()).some(change => change.path === '.gitattributes')) {
    throw new GitError('attributes_dirty', '.gitattributes 有待提交的改动', '先单独提交属性改动，或手动设置并验证适用的 LFS 与二进制规则。');
  }
  if (plan.needsLfs && !await lfsVersion(repo)) throw new GitError('lfs_missing', '检测到应使用 LFS 的大文件',
    '安装 git-lfs、改用制品存储或减小文件体积，然后重试。');
  const backup = await backupAssets(repo);
  try {
    if (plan.needsLfs) await repo.write(['lfs', 'install', '--local']);
    const rules = plan.changes.map(change => `${exactPattern(change.path)} ${change.lfs ? 'filter=lfs diff=lfs merge=lfs -text' : 'binary'}`);
    await appendFile(file, '\n' + rules.join('\n') + '\n');
    for (const change of plan.changes) {
      const current = await attrs(repo, change.path);
      if (change.lfs ? current.filter !== 'lfs' : current.text !== 'unset') {
        throw new GitError('attributes_invalid', `属性规则被更高优先级的配置覆盖：${change.path}`);
      }
    }
    await repo.write(['add', '--', '.gitattributes']);
    return backup;
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    throw new GitError(error.code, error.message, `${error.suggestion} 备份目录：${backup}`, error.detail);
  }
}

export async function objectSizes(repo: Repo, objects: string[]) {
  if (!objects.length) return [];
  if (objects.length <= 20) return Promise.all(objects.map(async oid => ({ oid,
    type: await repo.output(['cat-file', '-t', oid]), size: Number(await repo.output(['cat-file', '-s', oid])),
  })));
  // --batch-all-objects lets the child keep stdin on DEVNULL. Filter to the
  // outgoing set before reporting any result, and handle partial clone misses.
  const format = '%(objectname) %(objecttype) %(objectsize)';
  const output = await repo.git(['cat-file', '--batch-all-objects', '--unordered', `--batch-check=${format}`]);
  const pending = new Set(objects);
  const found = [];
  for (const line of output.stdout.trimEnd().split('\n')) {
    const [oid, type, size] = line.split(' ');
    if (pending.delete(oid)) found.push({ oid, type, size: Number(size) });
  }
  for (const oid of pending) found.push({ oid, type: await repo.output(['cat-file', '-t', oid]),
    size: Number(await repo.output(['cat-file', '-s', oid])) });
  return found;
}

const secretPattern = '-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----|gh[pousr]_[a-zA-Z0-9_]{20,}|github_pat_[a-zA-Z0-9_]{20,}|AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9_-]{20,}|(api[_-]?key|access[_-]?token|client[_-]?secret)[[:space:]]*[:=][[:space:]]*["\x27][a-zA-Z0-9_./+=-]{16,}';
const secretFilename = /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$)[^/]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials\.json)$/i;
const streamingSecret = new RegExp(secretPattern.replaceAll('[[:space:]]', '\\s'), 'i');

/** Scan source bytes before the LFS clean filter replaces them with pointers. */
export async function scanLfsSource(repo: Repo, paths: string[]) {
  const findings = [];
  for (const path of paths) {
    if (secretFilename.test(path)) { findings.push(path); continue; }
    let tail = '';
    const signal = AbortSignal.any([AbortSignal.timeout(repo.timeout), ...(repo.signal ? [repo.signal] : [])]);
    try {
      for await (const chunk of createReadStream(inside(repo.root, path), { encoding: 'latin1', signal })) {
        const window = tail + chunk;
        if (streamingSecret.test(window)) { findings.push(path); break; }
        tail = window.slice(-512);
      }
    } catch (error) {
      if (repo.signal?.aborted) throw new GitError('cancelled', '凭据扫描已取消');
      if (signal.aborted) throw new GitError('timeout', '大文件凭据扫描超时');
      throw error;
    }
  }
  return findings;
}
export async function scanSecrets(repo: Repo, paths: string[]) {
  const findings = new Set(paths.filter(path => secretFilename.test(path)));
  for (let index = 0; index < paths.length; index += 100) {
    const output = await repo.git(['--literal-pathspecs', 'grep', '--cached', '-I', '-l', '-z', '-i', '-E', '-e', secretPattern,
      '--', ...paths.slice(index, index + 100)], [0, 1]);
    for (const path of split(output.stdout)) findings.add(path);
  }
  return [...findings];
}
