import { z } from 'zod';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Repo, type Result, operand } from './context.js';
import { operations, conflictReport } from './operations.js';
import { workflows } from './workflows.js';
import { GitError, redact } from './process.js';

const text = (description: string) => z.string().min(1).max(65536).describe(description).optional();
const flag = (description: string) => z.boolean().describe(description).optional();
const count = (description: string, max = 1_000_000, min = 1) => z.number().int().min(min).max(max).describe(description).optional();
const choices = <T extends [string, ...string[]]>(...values: T) => z.enum(values).optional();
const common = {
  cwd: text('仓库目录，clone 使用该目录作为起点'),
  timeoutMs: count('单个子进程或 API 请求的超时毫秒数，默认 30000', 3_600_000, 50),
  dryRun: flag('只预演操作'),
  yes: flag('用户明确批准当前危险操作后才设为 true'),
};
const paths = z.array(z.string().min(1).max(4096)).min(1).max(200).describe('仓库相对路径，每个 CLI 路径重复一次 --paths').optional();
const remote = text('远端名称，如 origin');
const message = text('提交、存档或标签说明');
const name = text('名称');
const target = text('提交对象或 Git 引用');
const thresholdMb = count('大文件扫描阈值（MiB），默认 10');
const unsigned = flag('本次禁用签名，需要确认');
const noVerify = flag('本次绕过相关 Git hooks，需要确认');
const ffOnly = flag('仅允许快进更新');
const all = { ...operations, ...workflows };

function define<S extends z.ZodRawShape>(description: string, fields: S,
  run: (repo: Repo, args: z.output<z.ZodObject<S>>) => Promise<Result>,
  positionals: string[] = [], readOnly = false) {
  return { description, schema: z.strictObject({ ...common, ...fields }), run, positionals, readOnly };
}

export const tools = {
  pull: define('拉取远端最新 / 拉取远端 / 同步代码。直接调用即可，内置状态检查，成功返回当前分支、HEAD 和最新提交标题。默认允许分叉时合并，ffOnly 仅快进。', { remote, source: text('远端分支名'), ffOnly, unsigned }, all.pull),
  push: define('推送 / 推送远端 PR / 创建或更新 GitHub、Gitee PR。baseRepo 指定跨 Fork 目标仓库。prOnly 经 API 验证已推送分支并同步 PR。成功返回分支、upstream 和 PR（如请求）。无 upstream 时自动设置。', {
    remote, force: flag('带精确租约强推，需要确认'), noVerify, pr: flag('同步同仓库 PR，需要 --base'),
    base: text('PR 目标分支'), title: text('PR 标题'), body: z.string().max(65536).describe('PR 正文，可传空字符串清除正文').optional(),
    baseRepo: text('PR 目标仓库 owner/repo，例如上游组织的仓库；默认推送仓库'),
    prOnly: flag('仅经平台 API 创建或更新 PR，须 --pr --base，先验证远端源分支等于本地 HEAD'),
    gitLimitMb: count('普通 Git 对象上限（MiB）'), lfsLimitMb: count('LFS 单对象上限（MiB）'),
  }, all.push),
  commit: define('提交 / 提交到本地。自动暂存、扫描密钥和大文件、生成规范说明。成功返回分支、提交 ID 和实际 subject，无需再查 log。', {
    message, staged: flag('只提交已有暂存内容'), paths, noVerify, unsigned, thresholdMb,
  }, all.commit),
  branch: define('创建分支 / 切换分支 / 查看分支。默认 list。', {
    action: choices('create', 'switch', 'list'), name, start: text('创建分支的起点'),
  }, all.branch, ['action', 'name']),
  merge: define('合并分支 / merge 到当前分支。', { target, ffOnly, unsigned }, all.merge, ['target']),
  status: define('查看状态 / 改动有哪些 / 文件状态。', {}, all.status, [], true),
  diff: define('查看差异 / 改了什么 / 查看暂存区差异。默认 worktree。', {
    area: choices('worktree', 'staged'), paths,
  }, all.diff, ['area'], true),
  log: define('查看提交历史 / Git 日志 / 最近提交。', { limit: count('结果条数，默认 20', 10000) }, all.log, [], true),
  stash: define('暂存工作区 / 恢复暂存 / stash。默认 list，drop 需要确认。', {
    action: choices('save', 'apply', 'pop', 'drop', 'list'), name, message,
  }, all.stash, ['action', 'name']),
  tag: define('打标签 / 创建标签 / 查看标签。创建时使用 create，默认 list。', {
    action: choices('create', 'list'), name, target, message, unsigned,
  }, all.tag, ['action', 'name']),
  fetch: define('同步远端分支列表 / fetch / 更新远端引用。', {
    remote, depth: count('历史深度，改变 shallow 边界需要确认'), prune: flag('删掉失效的远端跟踪引用'),
  }, all.fetch),
  rollback: define('回滚提交 / 撤销工作区改动。worktree 保存 stash，commit 默认 revert。', {
    action: choices('commit', 'worktree'), target, paths, hard: flag('硬重置到目标提交，需要确认'), unsigned,
  }, all.rollback, ['action', 'target']),
  doctor: define('环境自检 / 诊断 Git、凭据、属性、钩子、大文件 / 清理陈旧锁。默认 check。', {
    action: choices('check', 'unlock'), remote, thresholdMb,
  }, all.doctor, ['action'], true),
  integrate: define('变基 / 拣选提交 / 继续冲突处理 / 中止合并、变基、拣选或撤销。', {
    action: choices('rebase', 'cherry-pick', 'continue', 'abort'), target, unsigned,
  }, all.integrate, ['action', 'target']),
  worktree: define('创建独立工作树 / 清理已登记工作树 / 查看工作树清单。默认 list。', {
    action: choices('create', 'remove', 'list'), path: text('工作树路径'), target,
  }, all.worktree, ['action', 'path']),
  maintenance: define('稀疏检出 / 关闭稀疏检出 / Git gc 仓库整理。', {
    action: choices('sparse-set', 'sparse-disable', 'gc'), paths,
  }, all.maintenance, ['action']),
  clone: define('克隆仓库 / 浅克隆 / 部分克隆。', {
    url: text('Git 源 URL 或本地源路径'), path: text('尚不存在的目标目录'),
    depth: count('浅克隆历史深度'), partial: flag('按需下载 blob'), sparse: flag('启用顶层稀疏检出'),
  }, async (repo, args) => {
    const url = operand(args.url, '仓库地址');
    const path = resolve(repo.root, operand(args.path, '目标目录'));
    if (await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
      throw new GitError('invalid_input', '克隆目标已存在');
    }
    const command = ['clone', ...(args.depth || args.partial ? ['--no-local'] : []), ...(args.depth ? [`--depth=${args.depth}`] : []),
      ...(args.partial ? ['--filter=blob:none'] : []), ...(args.sparse ? ['--sparse'] : []), '--', url, path];
    const plan = repo.plan('克隆预演', command.map(redact));
    if (plan) return plan;
    const result = await repo.write(command);
    const cloned = new Repo({ ...repo.options, cwd: path });
    await cloned.discover();
    return cloned.result('克隆完成', { path, output: redact(result.stderr) });
  }, ['url', 'path']),
};

export type ToolName = keyof typeof tools;
export const toolNames = Object.keys(tools) as ToolName[];
export const isTool = (name: string): name is ToolName => Object.hasOwn(tools, name);
export function inputSchema(name: ToolName) {
  return z.toJSONSchema(tools[name].schema, { io: 'input', target: 'draft-07' }) as {
    type: 'object'; properties: Record<string, { type?: string; enum?: string[]; description?: string }>;
  };
}
export const outputSchema = {
  type: 'object' as const,
  properties: {
    ok: { type: 'boolean' }, message: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
    branch: { type: ['string', 'null'] }, error_code: { type: ['string', 'null'] },
    suggestion: { type: ['string', 'null'] }, data: {},
  },
  required: ['ok', 'message', 'files', 'branch', 'error_code', 'suggestion'],
  additionalProperties: false,
};
export const failure = (message: string, code = 'invalid_input', suggestion: string | null = null): Result => ({
  ok: false, message, files: [], branch: null, error_code: code, suggestion,
});

/** The CLI, MCP and native plugin share argument validation, authorization checks,
 * repository locking, execution and error mapping through this entry point. */
export async function execute(name: ToolName, input: unknown = {}, signal?: AbortSignal): Promise<Result> {
  if (!isTool(name)) return failure('未知工具');
  const tool = tools[name];
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) return failure(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n'));
  const options = parsed.data as z.output<typeof tool.schema> & Record<string, unknown>;
  const repo = new Repo(options, signal);
  try {
    if (name !== 'clone') await repo.discover(false);
    // Each tool's schema and handler are paired by define(). TS loses that
    // correlation when indexing a union of the different registered tools.
    const operation = tool.run as (repo: Repo, args: typeof options) => Promise<Result>;
    if (name === 'clone') return await operation(repo, options);
    if (tool.readOnly || options.action === 'list') {
      await repo.updateBranch();
      return await operation(repo, options);
    }
    return await repo.locked(async () => {
      await repo.updateBranch();
      return operation(repo, options);
    });
  } catch (error) {
    if (!(error instanceof GitError)) return { ...failure(redact(error instanceof Error ? error.message : String(error)), 'internal_error'), branch: repo.branch };
    const result = { ...failure(error.message, error.code, error.suggestion || null), branch: repo.branch };
    const report = error.code === 'conflict' ? await conflictReport(repo).catch(() => null) : null;
    const secrets: string[] = error.code === 'secret_detected' ? JSON.parse(error.detail) : [];
    return { ...result, files: report?.files ?? secrets,
      suggestion: report?.binary_files.length ? `${result.suggestion ?? ''} 二进制冲突请人工选择一侧或重新生成文件。` : result.suggestion,
      data: { detail: secrets.length ? undefined : error.detail, backup: repo.backupRef(), binary_files: report?.binary_files } };
  }
}
export type { Result };
