import { GitError, redact } from './process.js';
import { type Repo } from './context.js';
import { platformRequest, provider } from './providers.js';

interface IssueArgs {
  action?: 'list' | 'view' | 'create' | 'update' | 'comment';
  repo?: string; platform?: 'github' | 'gitee'; remote?: string;
  number?: string; title?: string; body?: string;
  state?: 'open' | 'closed' | 'all'; limit?: number; page?: number;
}

/** Project only requested fields into model context. Full text is returned by view. */
function summary(value: any) {
  if (!value || !['string', 'number'].includes(typeof value.number) || typeof value.title !== 'string' ||
    typeof value.html_url !== 'string') throw new GitError('platform_api', '平台返回了无效的 Issue');
  return { number: String(value.number), title: redact(value.title), state: value.state, url: value.html_url };
}

export async function issue(repo: Repo, args: IssueArgs) {
  const action = args.action ?? 'list';
  const inferred = args.repo ? null : provider(await repo.output(['remote', 'get-url', args.remote ?? 'origin']));
  const kind = args.platform ?? inferred?.kind;
  if (inferred && args.platform && args.platform !== inferred.kind) {
    throw new GitError('invalid_input', 'platform 与 remote 平台不一致，请显式指定 repo');
  }
  const project = args.repo ?? (inferred ? `${inferred.owner}/${inferred.project}` : undefined);
  if (!project || !/^[\w.-]+\/[\w.-]+$/.test(project) || !kind) {
    throw new GitError('invalid_input', '请提供 --repo owner/repo --platform github|gitee，或配置受支持的 remote');
  }
  const github = kind === 'github';
  if (args.number && !(github ? /^[1-9]\d*$/ : /^[A-Za-z0-9]+$/).test(args.number)) throw new GitError('invalid_input', 'Issue 编号格式无效');
  if (action !== 'list' && action !== 'create' && !args.number) throw new GitError('invalid_input', '该动作需要 --number');
  if (action === 'create' && !args.title?.trim()) throw new GitError('invalid_input', '创建 Issue 需要 --title');
  if (action === 'comment' && !args.body?.trim()) throw new GitError('invalid_input', '评论需要 --body');
  if (action === 'update' && args.title === undefined && args.body === undefined && args.state === undefined) {
    throw new GitError('invalid_input', '更新至少需要 title、body 或 state');
  }
  if (action !== 'list' && args.state === 'all') throw new GitError('invalid_input', 'state=all 仅适用于 list');
  if (args.state && (action === 'create' || action === 'comment')) {
    throw new GitError('invalid_input', 'state 参数仅适用于 list 或 update');
  }
  const [owner, name] = project.split('/');
  const api = github ? 'https://api.github.com' : 'https://gitee.com/api/v5';
  const collection = `${api}/repos/${project}/issues`;
  const number = args.number ? encodeURIComponent(args.number) : '';
  const item = `${collection}/${number}`;
  const changes = { ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.body !== undefined ? { body: args.body } : {}),
    ...(args.state !== undefined ? { state: github ? args.state : args.state === 'open' ? 'open' : 'closed' } : {}) };
  const plan = repo.plan('Issue 操作预演', { platform: kind, repo: project, action, number: args.number, ...changes });
  if (plan) return plan;
  const request = platformRequest(repo, kind);
  try {
    if (action === 'list') {
      const page = args.page ?? 1;
      const size = args.limit ?? 20;
      const query = new URLSearchParams({ state: args.state ?? 'open', sort: 'created', direction: 'desc',
        page: String(page), per_page: String(size) });
      const values = await request(`${collection}?${query}`, 'GET');
      if (!Array.isArray(values)) throw new GitError('platform_api', 'Issue 列表格式无效');
      return repo.result('已读取 Issue 列表', { repo: project, issues: values.filter(v => !v.pull_request).map(summary),
        page, next_page: values.length === size ? page + 1 : null });
    }
    if (action === 'view') {
      const value = await request(item, 'GET');
      if (value.pull_request) throw new GitError('invalid_input', '该编号属于 PR');
      return repo.result('已读取 Issue', { ...summary(value), body: redact(value.body ?? '') });
    }
    if (action === 'comment') {
      // Verify the object kind before writing. GitHub shares the issue namespace with PRs.
      const value = await request(item, 'GET');
      if (value.pull_request) throw new GitError('invalid_input', '该编号属于 PR');
      const comment = await request(`${item}/comments`, 'POST', { body: args.body });
      return repo.result('已提交 Issue 评论', { number: args.number, url: comment.html_url, id: comment.id });
    }
    if (action === 'update') {
      const value = await request(item, 'GET');
      if (value.pull_request) throw new GitError('invalid_input', '该编号属于 PR');
    }
    // Gitee's write routes identify a repository through the request body.
    const endpoint = github ? (action === 'create' ? collection : item)
      : action === 'create' ? `${api}/repos/${owner}/issues` : `${api}/repos/${owner}/issues/${number}`;
    const value = await request(endpoint, action === 'create' ? 'POST' : 'PATCH',
      { ...changes, ...(!github ? { repo: name } : {}) });
    return repo.result(action === 'create' ? '已创建 Issue' : '已更新 Issue', summary(value));
  } catch (error) {
    if (error instanceof GitError && ['timeout', 'network_error'].includes(error.code) &&
      ['create', 'comment'].includes(action)) {
      throw new GitError(error.code, error.message, '写入结果可能尚未确认。先检查远端 Issue 或评论，再决定是否重试。', error.detail);
    }
    throw error;
  }
}
