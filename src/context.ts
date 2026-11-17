import { open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GitError, retryLocks, run } from './process.js';

export interface Options { cwd?: string; timeoutMs?: number; yes?: boolean; dryRun?: boolean }
export interface Result {
  ok: boolean; message: string; files: string[]; branch: string | null;
  error_code: string | null; suggestion: string | null; data?: unknown;
}
export type Change = { state: string; path: string; from?: string };

export function parseStatus(raw: string): Change[] {
  const entries = raw.split('\0');
  const changes: Change[] = [];
  for (let index = 0; entries[index]; index++) {
    const entry = entries[index];
    const state = entry.slice(0, 2);
    const change: Change = { state, path: entry.slice(3) };
    if (/[RC]/.test(state)) change.from = entries[++index];
    changes.push(change);
  }
  return changes;
}

export function confirm(options: Options, action: string) {
  if (!options.yes && !options.dryRun) {
    throw new GitError('confirmation_required', action, '得到用户明确同意后，用 --yes 或 yes:true 重新执行。');
  }
}
export function operand(value: string | undefined, name: string): string {
  if (!value || value.startsWith('-') || /[\x00-\x1f]/.test(value)) {
    throw new GitError('invalid_input', `请提供有效的 ${name}`);
  }
  return value;
}

export class Repo {
  root: string;
  branch: string | null = null;
  private commonDir = '';
  private recovery: string | null = null;
  constructor(readonly options: Options, readonly signal?: AbortSignal) {
    this.root = resolve(options.cwd ?? process.cwd());
  }
  get timeout() { return this.options.timeoutMs ?? 30_000; }
  git(args: string[], accepted = [0]) {
    return run(this.root, args, this.timeout, accepted, { signal: this.signal, extra: this.options.dryRun
      ? { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' } : undefined });
  }
  write(args: string[]) { return retryLocks(() => this.git(args)); }
  async output(args: string[], accepted = [0]) { return (await this.git(args, accepted)).stdout.replace(/\r?\n$/, ''); }

  async discover(readBranch = true) {
    const locations = (await this.output(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'])).split('\n');
    // Git prints paths verbatim. Preserve repositories with newline-containing paths.
    const [root, common] = locations.length === 2 ? locations : await Promise.all([
      this.output(['rev-parse', '--show-toplevel']),
      this.output(['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ]);
    this.root = await realpath(root);
    this.commonDir = common;
    if (readBranch) await this.updateBranch();
  }

  async updateBranch() {
    this.branch = (await this.output(['symbolic-ref', '-q', '--short', 'HEAD'], [0, 1])) || null;
  }
  requireBranch() {
    if (!this.branch) throw new GitError('detached_head', '当前为 detached HEAD', '使用 branch create 创建分支或 branch switch 切换分支。');
    return this.branch;
  }
  async head() {
    return (await this.output(['rev-parse', '--verify', '-q', 'HEAD'], [0, 1])) || null;
  }
  async statuses() {
    return parseStatus((await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'])).stdout);
  }
  async clean() {
    if ((await this.statuses()).length) throw new GitError('dirty_worktree', '工作区有改动', '先提交或用 stash save 保存改动后重试。');
  }
  plan(message: string, data?: unknown, files: string[] = []): Result | undefined {
    if (this.options.dryRun) return this.result(message, { dry_run: true, plan: data }, files);
  }
  result(message: string, data?: unknown, files: string[] = []): Result {
    return { ok: true, message, files, branch: this.branch, error_code: null, suggestion: null, data };
  }
  async backup() {
    if (this.recovery) return this.recovery;
    const head = await this.head();
    if (!head) return null;
    const ref = `refs/gitkit/backups/${randomUUID()}`;
    await this.write(['update-ref', ref, head]);
    this.recovery = ref;
    return ref;
  }
  backupRef() { return this.recovery; }

  /** Serializes GitKit callers sharing a local Git common directory. Git's index.lock
   * still protects the index from external Git processes. A dead PID is diagnostic. */
  async locked<T>(operation: () => Promise<T>): Promise<T> {
    if (this.options.dryRun) return operation();
    const lock = resolve(this.commonDir, 'gitkit-operation.lock');
    const handle = await retryLocks(async () => {
      try { return await open(lock, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        throw new GitError('index_lock', '另一个 GitKit 操作占用仓库', '等待操作结束。进程异常退出时，用 doctor unlock 检查陈旧锁。');
      }
    });
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, started: Date.now() }));
      return await operation();
    } finally {
      await handle.close();
      await unlink(lock);
    }
  }

  async unlock() {
    confirm(this.options, '清理已核实的陈旧 Git 锁');
    const locks = [resolve(this.commonDir, 'gitkit-operation.lock'),
      await this.output(['rev-parse', '--path-format=absolute', '--git-path', 'index.lock'])];
    const planned = this.plan('清理陈旧锁预演', locks);
    if (planned) return planned;
    const removed: string[] = [];
    for (const path of locks) {
      const info = await stat(path).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (!info || Date.now() - info.mtimeMs < 600_000) continue;
      if (path === locks[0]) {
        const { pid } = JSON.parse(await readFile(path, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        try { process.kill(pid, 0); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      }
      const current = await stat(path);
      if (current.ino !== info.ino || current.mtimeMs !== info.mtimeMs || current.size !== info.size) continue;
      await unlink(path);
      removed.push(path);
    }
    return this.result(removed.length ? '已清理陈旧锁' : '没有符合条件的陈旧锁', undefined, removed);
  }
}

export function inside(root: string, path: string): string {
  const resolved = resolve(root, path);
  const rel = relative(root, resolved);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) {
    throw new GitError('invalid_input', '路径须位于仓库内');
  }
  return resolved;
}
