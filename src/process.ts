import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export const redact = (value: string) => value
  .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
  .replace(/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})/g, '[redacted]');

export class GitError extends Error {
  constructor(public code: string, message: string, public suggestion = '', public detail = '') {
    super(message);
  }
}

export interface Output { status: number; stdout: string; stderr: string }

/** Inherit neither the MCP input nor an interactive terminal. Kill descendants on timeout,
 * including hooks, LFS, credential helpers and pinentry spawned by Git. */
export function run(cwd: string, args: string[], timeout: number, accepted = [0],
  options: { extra?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<Output> {
  const cancelled = () => new GitError('cancelled', '操作已取消', '检查仓库状态后决定是否继续。');
  if (options.signal?.aborted) return Promise.reject(cancelled());
  const windows = process.platform === 'win32';
  const env = { ...process.env };
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'GITEE_TOKEN']) delete env[key];
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CONFIG(?:_.*)?|EXTERNAL_DIFF|GRAFT_FILE|REPLACE_REF_BASE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|TRACE.*|CURL_VERBOSE)$/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', SSH_ASKPASS_REQUIRE: 'never',
    GIT_SSH_COMMAND: `${process.env.GIT_SSH_COMMAND || 'ssh'} -o BatchMode=yes -o StrictHostKeyChecking=yes`,
    GCM_INTERACTIVE: 'never', GIT_EDITOR: 'false', GIT_SEQUENCE_EDITOR: 'false',
    GIT_MERGE_AUTOEDIT: 'no', GIT_PAGER: 'cat', LC_ALL: 'C',
  }, options.extra);
  return new Promise((resolve, reject) => {
    const child = spawn('git', [
      '--no-pager', '--no-replace-objects', '-c', 'core.askPass=', '-c', 'core.quotepath=false',
      '-c', 'credential.interactive=false', '-c', 'protocol.ext.allow=never', ...args,
    ], { cwd, env, detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let stopped = false;
    let cleanupTimer: NodeJS.Timeout | undefined;
    const detail = () => redact([Buffer.concat(stderr).toString(), Buffer.concat(stdout).toString()].filter(Boolean).join('\n'));
    const stop = (reason: GitError) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const finish = () => {
        clearTimeout(cleanupTimer);
        child.stdout?.destroy();
        child.stderr?.destroy();
        reject(reason);
      };
      if (windows && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        cleanupTimer = setTimeout(() => { killer.kill(); child.kill(); finish(); }, 2000);
        killer.once('error', () => { child.kill(); finish(); });
        killer.once('close', () => { child.kill(); finish(); });
      } else {
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
        finish();
      }
    };
    const timer = setTimeout(() => stop(new GitError('timeout', 'Git 子进程超时', '检查网络、凭据或钩子，再提高 --timeout-ms 后重试。', detail())), timeout);
    const onAbort = () => stop(cancelled());
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) stop(new GitError('output_limit', 'Git 输出超过 32 MiB', '缩小文件、提交范围或历史深度。'));
      else target.push(chunk);
    };
    child.stdout?.on('data', collect(stdout));
    child.stderr?.on('data', collect(stderr));
    child.once('error', error => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(new GitError('spawn_failed', error.message, '检查 Git 是否在 PATH 中，以及工作目录是否存在。'));
    });
    child.once('close', code => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (stopped) return;
      const status = code ?? -1;
      if (!accepted.includes(status)) return reject(classify(detail()));
      resolve({ status, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
    });
  });
}

export function classify(detail: string): GitError {
  const rules: [RegExp, string, string][] = [
    [/dubious ownership|unsafe repository/i, 'unsafe_repository', '核实仓库所有者。确认信任后，在终端显式配置对应绝对路径的 safe.directory。'],
    [/index\.lock|cannot lock ref|packed-refs\.lock/i, 'index_lock', '等待其他 Git 任务结束。确认锁无持有者后，可用 doctor unlock 清理陈旧的 index.lock。'],
    [/gpg failed|signing failed|failed to sign|pinentry/i, 'signing_failed', '解锁签名代理后重试。若用户明确同意，使用 --unsigned --yes。'],
    [/could not resolve host|couldn't resolve host|failed to connect|couldn't connect|connection (?:timed out|reset|refused)|recv failure|remote end hung up|RPC failed.*(?:curl|HTTP)|TLS.*(?:failed|error)/i,
      'network_error', '检查网络、代理与远端地址。可重试只读连接探测；SSH 用户可核验 ssh.github.com:443。已推送的分支可用 push --pr-only 经 API 同步 PR。'],
    [/authentication failed|authorization failed|permission denied|could not read username|terminal prompts disabled|host key verification|publickey|invalid credentials|askpass|repository not found|cannot prompt|HTTP (401|403)/i, 'credentials_required', '配置 HTTPS credential helper 或预先解锁的 SSH agent，并确认仓库权限与 known_hosts。'],
    [/lfs.*(?:unsupported|not support|quota|bandwidth|batch response)|batch response/i, 'lfs_remote', '确认目标仓库支持 LFS、配额充足且当前凭据有权限。'],
    [/conflict|unmerged/i, 'conflict', '解决冲突后执行 integrate continue，或确认后执行 integrate abort。'],
    [/non-fast-forward|not possible to fast-forward|fetch first|stale info/i, 'non_fast_forward', '先 fetch 并检查远端差异。'],
    [/not a git repository/i, 'not_repository', '用 --cwd 指向 Git 仓库。'],
  ];
  const match = rules.find(([pattern]) => pattern.test(detail));
  return new GitError(match?.[1] ?? 'git_failed', 'Git 操作失败', match?.[2] ?? '查看 Git 的输出并检查仓库状态。', detail);
}

export async function retryLocks<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof GitError) || error.code !== 'index_lock' || attempt === 3) throw error;
      await delay(100 * 2 ** attempt);
    }
  }
}
