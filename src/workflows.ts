import { lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { confirm, operand, Repo } from './context.js';
import { attrs, lfsVersion, MiB, split, worktreeAssets } from './assets.js';
import { GitError, redact } from './process.js';

export async function exists(path: string) {
  return Boolean(await lstat(path).catch(error => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }));
}
export const gitPath = (repo: Repo, path: string) => repo.output(['rev-parse', '--path-format=absolute', '--git-path', path]);
export const resolveRef = (repo: Repo, value: string | undefined) =>
  repo.output(['rev-parse', '--verify', '--end-of-options', operand(value, '引用') + '^{commit}']);
export async function active(repo: Repo) {
  const markers = [['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']];
  const files = [...markers.map(([file]) => file), 'sequencer/todo'];
  const batch = (await repo.output(['rev-parse', '--path-format=absolute',
    ...files.flatMap(file => ['--git-path', file])])).split('\n');
  const paths = batch.length === files.length ? batch : await Promise.all(files.map(file => gitPath(repo, file)));
  const present = await Promise.all(paths.map(exists));
  const first = present.findIndex(Boolean);
  if (first < 0) return null;
  if (first < markers.length) return markers[first][1];
  try {
    return (await readFile(paths[first], 'utf8')).startsWith('revert ') ? 'revert' : 'cherry-pick';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export async function idle(repo: Repo) {
  const operation = await active(repo);
  if (operation) throw new GitError('operation_in_progress', `${operation} 尚未结束`, '处理冲突后运行 integrate continue 或 integrate abort。');
}

type Entry = { path: string; commit: string; branch: string | null };
async function manifest(repo: Repo) {
  const common = await repo.output(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const path = resolve(common, 'gitkit-worktrees.json');
  const entries: Entry[] = await exists(path) ? JSON.parse(await readFile(path, 'utf8')) : [];
  return { common, entries, async save() {
    const temporary = path + '.' + randomUUID();
    await writeFile(temporary, JSON.stringify(entries, null, 2), { flag: 'wx' });
    try { await rename(temporary, path); } finally { if (await exists(temporary)) await unlink(temporary); }
  }};
}
const sign = (unsigned?: boolean) => unsigned ? ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'] : [];

async function protectIgnoredFiles(repo: Repo, target: string) {
  const relevant = split((await repo.git(['diff', '--name-only', '--no-renames', '--diff-filter=AMT', '-z', 'HEAD', target])).stdout);
  if (!relevant.length) return;
  const ignored = split((await repo.git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])).stdout);
  const ignoreCase = await repo.output(['config', '--bool', '--get', 'core.ignorecase'], [0, 1]) === 'true';
  const key = (path: string) => (ignoreCase ? path.toLowerCase() : path).replace(/\/$/, '');
  const ignoredKeys = new Set(ignored.map(key));
  const parents = new Set<string>();
  for (const path of ignoredKeys) {
    for (let slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1)) parents.add(path.slice(0, slash));
  }
  for (const path of relevant.map(key)) {
    let candidate = path;
    while (candidate) {
      if (ignoredKeys.has(candidate) || (candidate === path && parents.has(candidate))) {
        throw new GitError('ignored_file_collision', `硬重置可能覆盖忽略的文件或目录：${path}`,
          '先将相关文件移到安全位置，再重试。');
      }
      candidate = candidate.includes('/') ? candidate.slice(0, candidate.lastIndexOf('/')) : '';
    }
  }
}

export const workflows = {
  async branch(repo: Repo, args: { action?: string; name?: string; start?: string }) {
    if (!args.action || args.action === 'list') {
      const refs = await repo.output(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
      return repo.result('已读取本地分支', { branches: refs.split('\n').filter(Boolean) });
    }
    const name = operand(args.name, '分支名');
    await repo.git(['check-ref-format', `refs/heads/${name}`]);
    await idle(repo);
    await repo.clean();
    const previous = { branch: repo.branch, commit: await repo.head() };
    const command = args.action === 'create' ? ['switch', '--no-overwrite-ignore', '-c', name, ...(args.start ? [await resolveRef(repo, args.start)] : [])]
      : ['switch', '--no-overwrite-ignore', '--no-guess', '--', name];
    const planned = repo.plan('切换分支预演', { command, previous });
    if (planned) return planned;
    await repo.write(command);
    await repo.updateBranch();
    return repo.result('已切换分支', { previous });
  },
  async merge(repo: Repo, args: { target?: string; ffOnly?: boolean; unsigned?: boolean }) {
    repo.requireBranch();
    await idle(repo);
    await repo.clean();
    if (args.unsigned) confirm(repo.options, '允许本次合并禁用签名');
    const target = await resolveRef(repo, args.target);
    const command = [...sign(args.unsigned), 'merge', '--no-overwrite-ignore', '--no-edit', ...(args.ffOnly ? ['--ff-only'] : []), target];
    const planned = repo.plan('合并预演', command);
    if (planned) return planned;
    const backup = await repo.backup();
    await repo.write(command);
    return repo.result('合并完成', { backup });
  },
  async stash(repo: Repo, args: { action?: string; name?: string; message?: string }) {
    const action = args.action ?? 'list';
    if (action === 'list') return repo.result('已读取暂存记录', { output: redact(await repo.output(['stash', 'list'])) });
    await idle(repo);
    const name = args.name ?? 'stash@{0}';
    if (!/^stash@\{\d+\}$/.test(name)) throw new GitError('invalid_input', '暂存引用应形如 stash@{0}');
    if (action === 'save' && !(await repo.statuses()).length) return repo.result('无改动');
    if (action === 'pop' || action === 'apply') await repo.clean();
    if (action === 'drop') confirm(repo.options, '删除指定 stash');
    const command = action === 'save' ? ['stash', 'push', '--include-untracked', '-m', args.message ?? 'gitkit: save changes']
      : ['stash', action, ...(['apply', 'pop'].includes(action) ? ['--index'] : []), name];
    const planned = repo.plan('暂存操作预演', command);
    if (planned) return planned;
    await repo.write(command);
    return repo.result('暂存操作完成', { stash: action === 'save' ? await repo.output(['rev-parse', 'refs/stash']) : name });
  },
  async tag(repo: Repo, args: { action?: string; name?: string; target?: string; message?: string; unsigned?: boolean }) {
    if (!args.action || args.action === 'list') return repo.result('已读取标签', { tags: (await repo.output(['tag', '--list'])).split('\n').filter(Boolean) });
    const name = operand(args.name, '标签名');
    await repo.git(['check-ref-format', `refs/tags/${name}`]);
    if (args.unsigned) confirm(repo.options, '允许本次标签禁用签名');
    const command = [...sign(args.unsigned), 'tag', ...(args.message ? ['-m', args.message] : []), '--', name, await resolveRef(repo, args.target ?? 'HEAD')];
    const planned = repo.plan('打标签预演', command);
    if (planned) return planned;
    await repo.write(command);
    return repo.result('已创建标签', { tag: name });
  },
  async rollback(repo: Repo, args: { action?: string; target?: string; paths?: string[]; hard?: boolean; unsigned?: boolean }) {
    await idle(repo);
    repo.requireBranch();
    if (args.unsigned) confirm(repo.options, '允许本次撤销提交禁用签名');
    if (args.action === 'worktree') {
      if (!(await repo.statuses()).length) return repo.result('无改动');
      confirm(repo.options, '从工作区移除改动并保存到可恢复的 stash');
      if (!await repo.head()) throw new GitError('no_commits', '首个提交前 Git 无法创建 stash', '将未跟踪或仅暂存的文件复制到仓库外后再处理。');
      const paths = args.paths ?? [];
      const command = ['--literal-pathspecs', 'stash', 'push', '-u', '-m', 'gitkit: worktree rollback', ...(paths.length ? ['--', ...paths] : [])];
      const planned = repo.plan('撤销工作区改动预演', command, paths);
      if (planned) return planned;
      const before = await repo.output(['rev-parse', '--verify', '-q', 'refs/stash'], [0, 1]);
      await repo.write(command);
      const after = await repo.output(['rev-parse', '--verify', '-q', 'refs/stash'], [0, 1]);
      return repo.result(before === after ? '无改动' : '已撤销改动并保存在 stash', { stash: before === after ? null : after }, paths);
    }
    if (args.action !== 'commit') throw new GitError('invalid_input', '请选择 rollback commit 或 rollback worktree');
    await repo.clean();
    if (args.hard) confirm(repo.options, '将当前分支重置到指定提交并改写本地历史');
    const target = await resolveRef(repo, args.target ?? (args.hard ? 'HEAD^' : 'HEAD'));
    if (args.hard) await protectIgnoredFiles(repo, target);
    const command = args.hard ? ['reset', '--hard', target] : [...sign(args.unsigned), 'revert', '--no-edit', target];
    const planned = repo.plan('提交回滚预演', command);
    if (planned) return planned;
    const backup = await repo.backup();
    await repo.write(command);
    return repo.result('回滚完成', { commit: await repo.head(), backup });
  },
  async integrate(repo: Repo, args: { action?: string; target?: string; unsigned?: boolean }) {
    const action = args.action;
    if (!action) throw new GitError('invalid_input', '请选择冲突处理动作');
    let command: string[];
    if (action === 'continue' || action === 'abort') {
      const operation = await active(repo);
      if (!operation) throw new GitError('no_operation', '当前没有可继续或中止的操作');
      if (action === 'abort') confirm(repo.options, '中止当前操作，可能还原已手动解决的冲突');
      command = [...sign(args.unsigned), operation, `--${action}`];
    } else {
      repo.requireBranch();
      await idle(repo);
      await repo.clean();
      if (action === 'rebase') confirm(repo.options, 'rebase 将改写当前分支历史');
      const target = await resolveRef(repo, args.target);
      command = [...sign(args.unsigned), action, target];
    }
    if (args.unsigned) confirm(repo.options, '允许本次操作禁用签名');
    const planned = repo.plan('整合操作预演', command);
    if (planned) return planned;
    const backup = await repo.backup();
    await repo.write(command);
    await repo.updateBranch();
    return repo.result('整合操作完成', { backup });
  },
  async doctor(repo: Repo, args: { action?: string; remote?: string; thresholdMb?: number }) {
    if (args.action === 'unlock') return repo.unlock();
    const remote = operand(args.remote ?? 'origin', '远端');
    const remotes = (await repo.output(['remote'])).split('\n');
    let credentials: unknown = { status: 'not_configured' };
    if (remotes.includes(remote)) {
      credentials = repo.options.dryRun ? { status: 'skipped' }
        : await repo.git(['ls-remote', remote, 'HEAD']).then(() => ({ status: 'read_access' }),
          (error: GitError) => ({ status: error.code, suggestion: error.suggestion, detail: error.detail }));
    }
    const paths = split((await repo.git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout);
    const assets = await worktreeAssets(repo, paths, (args.thresholdMb ?? 10) * MiB);
    const files = [];
    for (const asset of assets) {
      const properties = await attrs(repo, asset.path);
      files.push({ ...asset, attributes: properties,
        compliant: asset.large ? properties.filter === 'lfs' && properties.text === 'unset' : properties.text === 'unset' });
    }
    const hookNames = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'pre-push', 'post-merge', 'post-checkout'];
    const hooks = [];
    for (const name of hookNames) {
      const path = await gitPath(repo, 'hooks/' + name);
      hooks.push({ name, path, exists: await exists(path) });
    }
    const config = (key: string) => repo.output(['config', '--get', key], [0, 1]);
    return repo.result('仓库体检完成', { git: await repo.output(['--version']), lfs: await lfsVersion(repo), safe_directory: 'accepted',
      credentials, assets: files, hooks, core_autocrlf: await config('core.autocrlf'), core_ignorecase: await config('core.ignorecase'),
      gpgsign: await config('commit.gpgsign'), submodules: await exists(resolve(repo.root, '.gitmodules')),
      shallow: await repo.output(['rev-parse', '--is-shallow-repository']), operation: await active(repo),
      gitkit_lock: await exists(await gitPath(repo, 'gitkit-operation.lock')), index_lock: await exists(await gitPath(repo, 'index.lock')) },
    files.filter(file => file.large || !file.compliant).map(file => file.path));
  },
  async worktree(repo: Repo, args: { action?: string; path?: string; target?: string }) {
    const registry = await manifest(repo);
    const action = args.action ?? 'list';
    if (action === 'list') return repo.result('已读取工作树清单', { managed: registry.entries,
      git: await repo.output(['worktree', 'list', '--porcelain']) });
    const requested = resolve(repo.root, operand(args.path, '工作树路径'));
    if (action === 'create') {
      if (await exists(requested)) throw new GitError('invalid_input', '工作树目标必须为尚不存在的路径');
      const path = resolve(await realpath(dirname(requested)), basename(requested));
      const entry = { path, commit: await resolveRef(repo, args.target ?? 'HEAD'), branch: repo.branch };
      const planned = repo.plan('创建独立工作树预演', entry);
      if (planned) return planned;
      registry.entries.push(entry);
      await registry.save();
      try { await repo.write(['worktree', 'add', '--detach', '--', entry.path, entry.commit]); }
      catch (error) {
        if (!await exists(entry.path)) { registry.entries.pop(); await registry.save(); }
        throw error;
      }
      return repo.result('已创建独立工作树', entry);
    }
    // Match the same filesystem path when Windows returns a different drive
    // letter casing or the requested path uses an alias for its parent.
    const canonical = await realpath(requested).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return requested;
      throw error;
    });
    const index = registry.entries.findIndex(entry => relative(entry.path, canonical) === '');
    if (index < 0) throw new GitError('invalid_input', '该工作树没有 GitKit 创建记录');
    const { path } = registry.entries[index];
    if (relative(repo.root, canonical) === '') throw new GitError('invalid_input', '请从主工作树移除该工作树');
    confirm(repo.options, '移除已登记的工作树');
    const planned = repo.plan('移除工作树预演', { path });
    if (planned) return planned;
    if (await exists(path)) {
      const tree = new Repo({ ...repo.options, cwd: path });
      await tree.discover();
      await tree.clean();
      if (await tree.head() !== registry.entries[index].commit || tree.branch) throw new GitError('worktree_changed',
        '该工作树的提交或分支已变更', '确认提交已保存到持久分支后，再由 Git 手动移除该工作树。');
    }
    await repo.write(['worktree', 'remove', '--', path]);
    registry.entries.splice(index, 1);
    await registry.save();
    return repo.result('已移除工作树');
  },
  async maintenance(repo: Repo, args: { action?: string; paths?: string[] }) {
    const action = args.action;
    if (action === 'gc') {
      return repo.plan('仓库整理预演', ['gc', '--no-prune']) ?? (await repo.write(['gc', '--no-prune']), repo.result('仓库整理完成'));
    }
    if (action !== 'sparse-set' && action !== 'sparse-disable') throw new GitError('invalid_input', '请选择仓库维护动作');
    await idle(repo);
    await repo.clean();
    const paths = args.paths?.map(path => operand(path, 'sparse 目录')) ?? [];
    if (action === 'sparse-set' && !paths.length) throw new GitError('invalid_input', 'sparse-set 需要 paths');
    const previous = await repo.output(['sparse-checkout', 'list'], [0, 128]);
    const command = action === 'sparse-set' ? ['sparse-checkout', 'set', '--cone', '--', ...paths] : ['sparse-checkout', 'disable'];
    const planned = repo.plan('稀疏检出预演', { command, previous });
    if (planned) return planned;
    await repo.write(command);
    return repo.result('稀疏检出配置已更新', { previous });
  },
};
