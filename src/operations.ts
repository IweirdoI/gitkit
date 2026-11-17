import { basename, relative, resolve, sep } from 'node:path';
import { assetPlan, applyAssetPlan, attrs, binary, lfsVersion, MiB, objectSizes, scanLfsSource, scanSecrets, split } from './assets.js';
import { confirm, inside, operand, type Repo } from './context.js';
import { GitError, redact } from './process.js';
import { provider, upsertPr } from './providers.js';
import { exists, idle } from './workflows.js';

const literal = '--literal-pathspecs';
const parts = (paths?: string[]) => paths?.length ? ['--', ...paths] : [];
const integrity = ['--no-ext-diff', '--no-textconv'];
const noSign = (unsigned?: boolean) => unsigned ? ['--no-gpg-sign'] : [];
const changed = async (repo: Repo, hasContent = false) => split((await repo.git([
  'diff', '--cached', '--name-only', '-z', ...(hasContent ? ['--diff-filter=ACMRT'] : []),
])).stdout);
const conflicts = async (repo: Repo) => split((await repo.git(['diff', '--name-only', '--diff-filter=U', '-z'])).stdout);
const isGitError = (error: unknown, code: string) => error instanceof GitError && error.code === code;

export async function conflictReport(repo: Repo) {
  const files = await conflicts(repo).catch(() => []);
  const binaryFiles = [];
  for (const path of files) {
    const properties = await attrs(repo, path);
    if (binary.test(path) || properties.merge === 'unset' || properties.merge === 'lfs' || properties.diff === 'unset') {
      binaryFiles.push(path);
      continue;
    }
    const stage = await repo.output(['ls-files', '-u', '--', path]);
    for (const oid of stage.split('\n').map(line => /^[0-7]+ ([\da-f]+) [123]\t/.exec(line)?.[1]).filter(Boolean)) {
      const size = Number(await repo.output(['cat-file', '-s', oid!]));
      if (size <= MiB && (await repo.git(['cat-file', 'blob', oid!])).stdout.includes('\0')) {
        binaryFiles.push(path);
        break;
      }
    }
  }
  return { files, binary_files: binaryFiles };
}

async function ref(repo: Repo, value: string | undefined, name = '提交或分支') {
  return repo.output(['rev-parse', '--verify', '--end-of-options', operand(value, name) + '^{commit}']);
}
async function checkBranch(repo: Repo, name: string | undefined) {
  const value = operand(name, '分支名');
  await repo.git(['check-ref-format', `refs/heads/${value}`]);
  return value;
}
const noConflict = async (repo: Repo) => {
  if ((await conflicts(repo)).length) throw new GitError('conflict', '索引中存在冲突');
};

export const operations = {
  async status(repo: Repo) {
    const changes = await repo.statuses();
    return repo.result(changes.length ? '工作区有改动' : '工作区干净',
      { detached: repo.branch === null, changes }, changes.map(change => change.path));
  },
  async diff(repo: Repo, args: { area?: string; paths?: string[] }) {
    const base = [literal, 'diff', ...integrity, ...(args.area === 'staged' ? ['--cached'] : [])];
    const paths = parts(args.paths);
    const names = split((await repo.git([...base, '--name-only', '-z', ...paths])).stdout);
    const patch = redact((await repo.git([...base, ...paths])).stdout);
    return repo.result(names.length ? '已读取差异' : '没有差异', { area: args.area ?? 'worktree', patch }, names);
  },
  async log(repo: Repo, args: { limit?: number }) {
    if (!await repo.head()) return repo.result('没有提交历史', { commits: [] });
    const data = (await repo.git(['log', '-z', `-${args.limit ?? 20}`, '--format=%H%x00%aI%x00%an%x00%s'])).stdout.split('\0');
    data.pop();
    const commits = [];
    for (let i = 0; i < data.length; i += 4) {
      commits.push({ hash: data[i], date: data[i + 1], author: data[i + 2], subject: redact(data[i + 3] ?? '') });
    }
    return repo.result('已读取提交记录', { commits });
  },
  async fetch(repo: Repo, args: { remote?: string; prune?: boolean; depth?: number }) {
    if (args.depth) confirm(repo.options, '更改仓库 shallow 边界');
    const remote = operand(args.remote ?? 'origin', '远端');
    const command = ['fetch', '--no-recurse-submodules', ...(args.prune ? ['--prune'] : []),
      ...(args.depth ? [`--depth=${args.depth}`] : []), remote];
    return repo.plan('同步远端分支预演', command) ?? (
      await repo.write(command), repo.result('已同步远端分支', {
        refs: (await repo.output(['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remote}`])).split('\n').filter(Boolean),
      }));
  },
  async pull(repo: Repo, args: { remote?: string; source?: string; ffOnly?: boolean; unsigned?: boolean }) {
    const branch = repo.requireBranch();
    if (args.unsigned) confirm(repo.options, '允许本次合并生成未签名提交');
    await idle(repo);
    const [configured, tracked] = await Promise.all([
      repo.output(['config', '--get', `branch.${branch}.remote`], [0, 1]),
      repo.output(['config', '--get', `branch.${branch}.merge`], [0, 1]),
      repo.clean(),
    ]);
    const remote = operand(args.remote ?? (configured || 'origin'), '远端');
    const source = await checkBranch(repo, args.source ?? (remote === configured && tracked.startsWith('refs/heads/') ? tracked.slice(11) : branch));
    const fetch = ['fetch', '--recurse-submodules=on-demand', remote, `refs/heads/${source}`];
    const planned = repo.plan('拉取预演', { fetch, fallback: args.ffOnly ? null : 'merge', submodules: 'update --init --recursive' });
    if (planned) return planned;
    await repo.write(fetch);
    const oid = await ref(repo, 'FETCH_HEAD');
    const backup = await repo.backup();
    try { await repo.write(['merge', '--no-overwrite-ignore', '--ff-only', oid]); }
    catch (error) {
      if (args.ffOnly || !(error instanceof GitError) || !/not possible to fast-forward/i.test(error.detail)) throw error;
      await repo.write(['merge', '--no-overwrite-ignore', '--ff', '--no-edit', ...noSign(args.unsigned), oid]);
    }
    await repo.write(['submodule', 'update', '--init', '--recursive', '--checkout']);
    const [commit, subject] = (await repo.output(['log', '-1', '--format=%H%x00%s', 'HEAD'])).split('\0');
    return repo.result('已同步工作区与子模块', { backup, remote, source, commit, subject: redact(subject ?? '') });
  },
  async commit(repo: Repo, args: { message?: string; staged?: boolean; paths?: string[]; noVerify?: boolean; unsigned?: boolean; thresholdMb?: number }) {
    repo.requireBranch();
    await idle(repo);
    await noConflict(repo);
    if (args.noVerify) confirm(repo.options, '允许本次提交绕过 Git hooks');
    if (args.unsigned) confirm(repo.options, '允许本次提交禁用 GPG 签名');
    if (args.staged && args.paths?.length) throw new GitError('invalid_input', '--staged 与 --paths 只可选一个');
    const state = await repo.statuses();
    if (!state.length) return repo.result('无改动');
    const prefixes = (args.paths ?? []).map(path => resolve(repo.root, path) === repo.root ? ''
      : relative(repo.root, inside(repo.root, path)).split(sep).join('/'));
    const ignoreCase = prefixes.length && await repo.output(['config', '--bool', '--get', 'core.ignorecase'], [0, 1]) === 'true';
    const key = (path: string) => ignoreCase ? path.toLowerCase() : path;
    const match = (path: string) => !prefixes.length || prefixes.some(prefix => !prefix || key(path) === key(prefix) || key(path).startsWith(key(prefix) + '/'));
    const selection = state.filter(change => match(change.path) || (change.from && match(change.from)));
    const selected = selection.map(change => change.path);
    if (prefixes.length && state.some(change => !selection.includes(change) && /^[^ ?]/.test(change.state))) {
      throw new GitError('unrelated_staged', '索引包含指定路径以外的改动',
        '先处理其他暂存改动，再提交指定路径。');
    }
    const pathArgs = prefixes.length ? parts([...new Set(selection.flatMap(change =>
      change.from && /[RC]/.test(change.state[1]) ? [change.path, change.from] : [change.path]))]) : [];
    if (!args.staged && args.paths?.length && !selected.length) return repo.result('指定路径无改动');
    const threshold = (args.thresholdMb ?? 10) * MiB;
    const plan = args.staged ? null : await assetPlan(repo, selected, threshold);
    const gpgsign = await repo.output(['config', '--bool', '--get', 'commit.gpgsign'], [0, 1]);
    const planned = repo.plan('提交预演', { stage: args.staged ? null : args.paths ?? ['.'], assets: plan,
      signing: args.unsigned ? 'disabled' : gpgsign === 'true', hooks: !args.noVerify }, args.staged ? await changed(repo) : selected);
    if (planned) return planned;
    const assetSecrets = plan ? await scanLfsSource(repo, plan.assets.filter(asset => asset.large).map(asset => asset.path)) : [];
    if (assetSecrets.length) throw new GitError('secret_detected', '大文件中发现疑似密钥或凭据',
      '从文件中移除凭据后再提交。', JSON.stringify(assetSecrets));
    let backup: string | null = null;
    try {
      if (plan) backup = await applyAssetPlan(repo, plan);
      if (!args.staged) await repo.write([literal, 'add', '-A', ...pathArgs]);
      const empty = await repo.git(['diff', '--cached', '--quiet', ...integrity], [0, 1]);
      if (!empty.status) return repo.result('无改动');
      const files = await changed(repo);
      const secrets = await scanSecrets(repo, await changed(repo, true));
      if (secrets.length) throw new GitError('secret_detected', '疑似密钥或凭据，已阻止提交',
        '从索引和文件中移除凭据，再次暂存并提交。', JSON.stringify(secrets));
      const index = split((await repo.git(['ls-files', '--stage', '-z'])).stdout)
        .map(line => /^(100[0-7]+) ([\da-f]+) 0\t([\s\S]*)$/.exec(line))
        .filter((entry): entry is RegExpExecArray => Boolean(entry));
      const selectedFiles = new Set(files);
      const entries = index.filter(entry => selectedFiles.has(entry[3]));
      const sizes = new Map((await objectSizes(repo, [...new Set(entries.map(entry => entry[2]))])).map(item => [item.oid, item.size]));
      for (const entry of entries) {
        if ((sizes.get(entry[2]) ?? Infinity) > threshold) throw new GitError('large_blob', `索引仍包含超过阈值的普通 Git 对象：${entry[3]}`,
          '确认 LFS 规则与 clean filter 生效，然后用 commit 重新暂存工作区文件。');
      }
      const message = args.message ?? (files.length === 1 ? `chore: update ${basename(files[0]).replace(/[\r\n]/g, ' ')}`
        : `chore: update ${files.length || state.length} paths`);
      try {
        await repo.write(['commit', ...(args.noVerify ? ['--no-verify'] : []), ...noSign(args.unsigned), '-m', message]);
      } catch (error) {
        if (gpgsign === 'true' && !args.unsigned && isGitError(error, 'timeout')) {
          throw new GitError('timeout', '签名提交超时',
            '检查钩子并预先解锁 GPG 代理。用户明确同意后，可用 --unsigned --yes 重试。', (error as GitError).detail);
        }
        if (isGitError(error, 'git_failed') && error instanceof GitError) {
          const hook = /pre-commit|commit-msg|husky|lint-staged/.test(error.detail) ||
            Boolean((await repo.output(['config', '--get', 'core.hooksPath'], [0, 1])));
          if (hook || await exists(await repo.output(['rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-commit'])) ||
            await exists(await repo.output(['rev-parse', '--path-format=absolute', '--git-path', 'hooks/commit-msg']))) {
            throw new GitError('hook_failed', '提交未完成，请检查钩子输出', '修复钩子报告的错误后重试。', error.detail);
          }
        }
        throw error;
      }
      return repo.result('已提交到本地', { commit: await repo.head(), message, backup }, files);
    } catch (error) {
      if (backup && error instanceof GitError) throw new GitError(error.code, error.message, `${error.suggestion} 自动属性修改备份：${backup}`, error.detail);
      throw error;
    }
  },
  async push(repo: Repo, args: { remote?: string; force?: boolean; noVerify?: boolean; pr?: boolean; base?: string; title?: string; body?: string; gitLimitMb?: number; lfsLimitMb?: number }) {
    const branch = repo.requireBranch();
    const [commit, upstream, configured, tracked] = await Promise.all([
      repo.head(),
      repo.output(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], [0, 128]),
      repo.output(['config', '--get', `branch.${branch}.remote`], [0, 1]),
      repo.output(['config', '--get', `branch.${branch}.merge`], [0, 1]),
      idle(repo),
    ]);
    if (!commit) throw new GitError('no_commits', '当前分支尚无提交');
    if (args.force) confirm(repo.options, '使用带明确远端对象租约的 force-with-lease 推送');
    if (args.noVerify) confirm(repo.options, '允许本次推送绕过 Git hooks');
    const remote = operand(args.remote ?? (upstream && configured ? configured : 'origin'), '远端');
    const destination = upstream && remote === configured && tracked.startsWith('refs/heads/') ? tracked : `refs/heads/${branch}`;
    const urls = (await repo.output(['remote', 'get-url', '--push', '--all', remote])).split('\n');
    if (urls.length !== 1) throw new GitError('invalid_input', '单次操作需指定只有一个 push URL 的远端');
    const target = provider(urls[0]);
    const base = args.pr ? await checkBranch(repo, args.base) : undefined;
    if (args.pr && !target) throw new GitError('unsupported_provider', 'PR 目前支持 github.com 与 gitee.com');
    if (base && destination === `refs/heads/${base}`) throw new GitError('invalid_input', 'PR 源分支与目标分支相同');
    const planned = repo.plan('推送预演', { remote, destination, commit, force_with_lease: Boolean(args.force), pr_base: base, set_upstream: !upstream });
    if (planned) return planned;
    if (target && base && !(target.kind === 'github' ? process.env.GITHUB_TOKEN || process.env.GH_TOKEN : process.env.GITEE_TOKEN)) {
      throw new GitError('credentials_required', '缺少 PR API 凭据', '设置 GITHUB_TOKEN、GH_TOKEN 或 GITEE_TOKEN。');
    }
    // Exclude only commits the actual push endpoint advertises and we have
    // locally. A stale tracking ref alone cannot prove an object is remote.
    const [advertised, available] = await Promise.all([
      repo.output(['ls-remote', '--refs', '--heads', '--', urls[0]]),
      repo.output(['for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/remotes']),
    ]);
    const refs = advertised.split('\n').map(line => line.split('\t'))
      .filter(([oid, name]) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) && name?.startsWith('refs/heads/'));
    const expected = refs.find(([, name]) => name === destination)?.[0] ?? '';
    const availableIds = new Set(available.split('\n'));
    const known = new Set(refs.map(([oid]) => oid).filter(oid => availableIds.has(oid)));
    if (expected && !known.has(expected) && (await repo.git(['cat-file', '-e', expected + '^{commit}'], [0, 1, 128])).status === 0) {
      known.add(expected);
    }
    const priorities = new Set([...(known.has(expected) ? [expected] : []), ...known]);
    const excluded = [...priorities].slice(0, 64).map(oid => '^' + oid);
    const objects = known.has(commit) ? [] :
      (await repo.output(['rev-list', '--objects', '--no-object-names', commit, ...excluded])).split('\n').filter(Boolean);
    const sizes = await objectSizes(repo, objects);
    const gitLimit = args.gitLimitMb ? args.gitLimitMb * MiB : target?.gitLimit ?? 100 * MiB;
    const lfsLimit = args.lfsLimitMb ? args.lfsLimitMb * MiB : target?.lfsLimit;
    const pointerObjects: { oid: string; size: number }[] = [];
    const largeGitObjects: { oid: string; size: number }[] = [];
    for (const item of sizes) {
      if (item.type === 'missing' || !Number.isFinite(item.size)) throw new GitError('missing_object', '推送预检遇到缺失对象');
      if (item.type !== 'blob') continue;
      if (item.size > gitLimit) throw new GitError('platform_limit', `普通 Git 对象超过推送阈值：${item.oid}`,
        '将对象迁移至 LFS 或制品存储。迁移历史前先备份并得到用户确认。');
      if (item.size > 10 * MiB) largeGitObjects.push({ oid: item.oid, size: item.size });
      if (item.size < 100 || item.size > 1024) continue;
      const text = (await repo.git(['cat-file', 'blob', item.oid])).stdout;
      const match = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n(?:ext-.*\r?\n)*oid sha256:([\da-f]{64})\r?\nsize (\d+)\r?\n?$/.exec(text);
      if (match) pointerObjects.push({ oid: match[1], size: Number(match[2]) });
    }
    const oversized = pointerObjects.find(item => lfsLimit !== undefined && item.size > lfsLimit);
    if (oversized) throw new GitError('platform_limit', `LFS 对象超过当前配置阈值：${oversized.oid}`,
      '核实仓库套餐限制后设置 --lfs-limit-mb，或改用制品存储。');
    if (pointerObjects.length) {
      if (!await lfsVersion(repo)) throw new GitError('lfs_missing', '推送包含 LFS 指针', '安装 Git LFS 后重试。');
      // Git LFS streams the objects and performs transfer-level retries. Upload
      // explicitly even when the Git pre-push hook has not been installed.
      try {
        for (let index = 0; index < pointerObjects.length; index += 50) {
          const oids = pointerObjects.slice(index, index + 50).map(item => item.oid);
          const command = ['-c', 'lfs.transfer.maxretries=3', 'lfs', 'push', '--object-id', remote, ...oids];
          try { await repo.write(command); }
          catch (error) {
            if (!isGitError(error, 'timeout')) throw error;
            await repo.write(command);
          }
        }
      } catch (error) {
        if (isGitError(error, 'timeout')) throw new GitError('timeout', 'LFS 上传超时',
          '提高 --timeout-ms 后重试。Git LFS 会重新检查远端已上传的对象。', (error as GitError).detail);
        throw error;
      }
    }
    const command = ['push', '--recurse-submodules=check', ...(!upstream ? ['-u'] : []),
      ...(args.force ? [`--force-with-lease=${destination}:${expected}`] : []),
      ...(args.noVerify ? ['--no-verify'] : []), remote, `refs/heads/${branch}:${destination}`];
    if (await repo.head() !== commit) throw new GitError('head_changed', '预检后 HEAD 变更，请重试');
    const result = await repo.write(command);
    const actualUpstream = upstream || await repo.output(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], [0, 128]);
    const report = { remote, destination, commit, upstream: actualUpstream || null,
      large_git_objects: largeGitObjects, lfs_objects: pointerObjects.length };
    if (target && base) {
      try {
        return repo.result('已推送并同步 PR', { ...report, pr: await upsertPr(repo, target,
          destination.slice(11), base, args.title, args.body) });
      } catch (error) {
        if (error instanceof GitError) throw new GitError(error.code, `分支已推送，PR 同步失败：${error.message}`, error.suggestion, error.detail);
        throw error;
      }
    }
    return repo.result('已推送远端', { ...report, output: redact(result.stderr) });
  },
};
