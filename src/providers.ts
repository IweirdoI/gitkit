import { GitError, redact } from './process.js';
import type { Repo } from './context.js';

const MiB = 1024 ** 2;
export function provider(url: string) {
  let host: string;
  let path: string;
  try { const parsed = new URL(url); host = parsed.hostname; path = parsed.pathname; }
  catch {
    const match = /^(?:[^@]+@)?([^:/]+):(.+)$/.exec(url);
    host = match?.[1] ?? '';
    path = match?.[2] ?? '';
  }
  const kind = host === 'github.com' ? 'github' : host === 'gitee.com' ? 'gitee' : null;
  const [owner, project, extra] = path.replace(/^\/+|\.git$/g, '').split('/');
  return kind && owner && project && !extra && /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(project)
    ? { kind, owner, project, gitLimit: kind === 'github' ? 100 * MiB : 100_000_000,
      lfsLimit: kind === 'github' ? 2048 * MiB : undefined } as const : null;
}

/** A second run after a partial push finds the existing open PR and updates it. */
export async function upsertPr(repo: Repo, target: NonNullable<ReturnType<typeof provider>>,
  branch: string, base: string, title?: string, body?: string) {
  const github = target.kind === 'github';
  const token = github ? process.env.GITHUB_TOKEN || process.env.GH_TOKEN : process.env.GITEE_TOKEN;
  if (!token) throw new GitError('credentials_required', '缺少 PR API 凭据',
    github ? '配置 GITHUB_TOKEN 或 GH_TOKEN。' : '配置有仓库权限的 GITEE_TOKEN。');
  const url = `${github ? 'https://api.github.com' : 'https://gitee.com/api/v5'}/repos/${target.owner}/${target.project}/pulls`;
  async function request(endpoint: string, method: string, payload?: object) {
    try {
      const response = await fetch(endpoint, {
        method, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(repo.timeout), ...(repo.signal ? [repo.signal] : [])]),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json',
          ...(github ? { Authorization: `Bearer ${token}` } : {}) },
        body: payload ? JSON.stringify(github ? payload : { ...payload, access_token: token }) : undefined,
      });
      if (!response.ok) {
        const detail = redact((await response.text()).slice(0, 4096).split(token!).join('[redacted]'));
        throw new GitError([401, 403].includes(response.status) ? 'credentials_required' : 'pr_api',
          `PR API 返回 HTTP ${response.status}`, '检查令牌权限、同仓库目标分支及 API 返回内容。', detail);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof GitError) throw error;
      if (repo.signal?.aborted) throw new GitError('cancelled', 'PR API 请求已取消');
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new GitError('timeout', 'PR API 请求超时');
      throw new GitError('pr_api', 'PR API 请求失败', '检查平台网络连通性。');
    }
  }
  const query = new URLSearchParams({ state: 'open', head: github ? `${target.owner}:${branch}` : branch, base, per_page: '100' });
  if (!github) query.set('access_token', token);
  const pulls = await request(`${url}?${query}`, 'GET');
  const existing = Array.isArray(pulls) && pulls.find(pr => pr.head?.ref === branch && pr.base?.ref === base &&
    String(pr.head?.repo?.full_name ?? '').toLowerCase() === `${target.owner}/${target.project}`.toLowerCase());
  const fields = { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) };
  const pr = existing ? (Object.keys(fields).length ? await request(`${url}/${existing.number}`, 'PATCH', fields) : existing)
    : await request(url, 'POST', { head: branch, base, title: branch, ...fields });
  return { number: pr.number, url: pr.html_url, existing: Boolean(existing) };
}
