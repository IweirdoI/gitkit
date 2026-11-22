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

export function platformRequest(repo: Repo, kind: 'github' | 'gitee') {
  const github = kind === 'github';
  const token = github ? process.env.GITHUB_TOKEN || process.env.GH_TOKEN : process.env.GITEE_TOKEN;
  if (!token) throw new GitError('credentials_required', '缺少平台 API 凭据',
    github ? '配置 GITHUB_TOKEN 或 GH_TOKEN。' : '配置 GITEE_TOKEN。');
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
        throw new GitError([401, 403].includes(response.status) ? 'credentials_required' : 'platform_api',
          `平台 API 返回 HTTP ${response.status}`, '检查令牌权限、源仓库、目标仓库及目标分支。', detail);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof GitError) throw error;
      if (repo.signal?.aborted) throw new GitError('cancelled', '平台 API 请求已取消');
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new GitError('timeout', '平台 API 请求超时');
      throw new GitError('network_error', '平台 API 请求失败', '检查平台网络与代理配置。');
    }
  }
  return async (endpoint: string, method: string, payload?: object) => {
    const url = new URL(endpoint);
    if (url.origin !== (github ? 'https://api.github.com' : 'https://gitee.com')) {
      throw new GitError('invalid_input', '平台 API 地址不匹配');
    }
    if (!github && method === 'GET') url.searchParams.set('access_token', token);
    return request(url.toString(), method, payload);
  };
}

/** A second run after a partial push finds the existing open PR and updates it. */
export async function upsertPr(repo: Repo, target: NonNullable<ReturnType<typeof provider>>,
  branch: string, base: string, title?: string, body?: string,
  baseRepo?: string, expectedCommit?: string) {
  const github = target.kind === 'github';
  const destination = baseRepo ?? `${target.owner}/${target.project}`;
  if (!/^[\w.-]+\/[\w.-]+$/.test(destination)) throw new GitError('invalid_input', 'PR 目标仓库应为 owner/repo');
  const source = `${target.owner}/${target.project}`;
  const crossFork = destination.toLowerCase() !== source.toLowerCase();
  const token = github ? process.env.GITHUB_TOKEN || process.env.GH_TOKEN : process.env.GITEE_TOKEN;
  if (!token) throw new GitError('credentials_required', '缺少 PR API 凭据',
    github ? '配置 GITHUB_TOKEN 或 GH_TOKEN。' : '配置有仓库权限的 GITEE_TOKEN。');
  const api = github ? 'https://api.github.com' : 'https://gitee.com/api/v5';
  const url = `${api}/repos/${destination}/pulls`;
  const send = platformRequest(repo, target.kind);
  const request = async (endpoint: string, method: string, payload?: object) => {
    try { return await send(endpoint, method, payload); }
    catch (error) {
      if (error instanceof GitError && error.code === 'platform_api') {
        throw new GitError('pr_api', error.message, error.suggestion, error.detail);
      }
      throw error;
    }
  };
  const qualifiedHead = github || crossFork ? `${target.owner}:${branch}` : branch;
  if (expectedCommit) {
    const query = new URLSearchParams(github ? {} : { access_token: token });
    const ref = await request(`${api}/repos/${source}/branches/${encodeURIComponent(branch)}?${query}`, 'GET');
    if (ref.commit?.sha !== expectedCommit) throw new GitError('remote_mismatch', '远端源分支与本地 HEAD 不一致',
      '先将当前提交推送到源分支，再重试。');
  }
  const query = new URLSearchParams({ state: 'open', head: qualifiedHead, base, per_page: '100' });
  if (!github) query.set('access_token', token);
  let existing;
  for (let page = 1; page <= 100; page++) {
    query.set('page', String(page));
    const pulls = await request(`${url}?${query}`, 'GET');
    if (!Array.isArray(pulls)) throw new GitError('pr_api', 'PR API 返回了无效的列表');
    existing = pulls.find(pr => pr.head?.ref === branch && pr.base?.ref === base &&
      String(pr.head?.repo?.full_name ?? '').toLowerCase() === source.toLowerCase());
    if (existing || pulls.length < 100) break;
    if (page === 100) throw new GitError('pr_api', 'PR 列表超出检索上限', '缩小目标范围并检查已有 PR。');
  }
  const fields = { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) };
  const pr = existing ? (Object.keys(fields).length ? await request(`${url}/${existing.number}`, 'PATCH', fields) : existing)
    : await request(url, 'POST', { head: crossFork ? qualifiedHead : branch,
      ...(github && crossFork ? { head_repo: target.project } : {}), base, title: branch, ...fields });
  return { number: pr.number, url: pr.html_url, existing: Boolean(existing), source_repo: source, base_repo: destination };
}
