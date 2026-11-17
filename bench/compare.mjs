import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = process.env.GITKIT_BENCH_CODEX;
if (!cli) throw new Error('Set GITKIT_BENCH_CODEX to the absolute @openai/codex/bin/codex.js path');
const target = resolve(process.argv[2] ?? 'bench/results.json');
const repeats = Number(process.env.GITKIT_BENCH_REPEATS ?? 2);
const model = process.env.GITKIT_BENCH_MODEL ?? 'gpt-6.1-sol';
const http = process.env.GITKIT_BENCH_HTTP === '1';
const parallelPairs = Number(process.env.GITKIT_BENCH_PARALLEL_PAIRS ?? 1);
const referenceCli = process.env.GITKIT_BENCH_REFERENCE_CLI;
const referenceArm = referenceCli ? 'reference' : 'native';
const selected = process.env.GITKIT_BENCH_TASKS?.split(',');
assert.ok(Number.isInteger(repeats) && repeats > 0 && Number.isInteger(parallelPairs) && parallelPairs > 0);
const scenarios = [
  { id: 'status', label: '检查分支与改动', prompt: '查看当前分支、已暂存文件、未暂存的已跟踪文件和未跟踪文件。输出分支名以及三类文件名，用中文说明。只查询。' },
  { id: 'commit', label: '暂存并提交', prompt: '把 draft.txt 的改动提交到当前分支，提交信息使用 chore: update draft。提交后告诉我分支名和实际提交信息。' },
  { id: 'pull', label: '拉取本地远端', prompt: '从 origin 拉取当前分支的最新提交，要求只允许快进。成功后告诉我分支名和最新提交信息。' },
  { id: 'push', label: '首次推送并设上游', prompt: '把当前分支首次推送到 origin，建立 upstream，然后告诉我当前分支名和完整 upstream 名称。' },
].filter(scenario => !selected || selected.includes(scenario.id));
assert.ok(scenarios.length && (!selected || selected.every(id => scenarios.some(scenario => scenario.id === id))));
const schemaFor = {
  status: { branch: 'string', staged: 'array', unstaged: 'array', untracked: 'array' },
  commit: { branch: 'string', subject: 'string' },
  pull: { branch: 'string', subject: 'string' },
  push: { branch: 'string', upstream: 'string' },
};
const scratch = await mkdtemp(join(tmpdir(), 'gitkit-bench-'));
const commonEnv = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'GITEE_TOKEN']) delete commonEnv[name];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: commonEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const config = (cwd) => {
  for (const [key, value] of [['user.name','GitKit Benchmark'],['user.email','gitkit@example.invalid'],['core.autocrlf','false'],
    ['core.hooksPath','.git/hooks'],['commit.gpgsign','false']]) git(cwd, 'config', '--local', key, value);
};
async function makeFixture(scenario, repeat, arm) {
  const base = join(scratch, `${scenario.id}-${repeat}-${arm}`);
  const cwd = join(base, 'repo');
  const bare = join(base, 'origin.git');
  await mkdir(cwd, { recursive: true });
  git(cwd, 'init', '-b', 'main');
  config(cwd);
  for (const path of ['draft.txt', 'readme.txt']) await writeFile(join(cwd, path), 'seed\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'test: seed');
  git(cwd, 'init', '--bare', '-b', 'main', bare);
  git(cwd, 'remote', 'add', 'origin', bare);
  git(cwd, 'push', '-u', 'origin', 'main');
  if (scenario.id !== 'pull') git(cwd, 'switch', '-c', `topic/r${repeat}`);

  if (scenario.id === 'status') {
    await writeFile(join(cwd, 'readme.txt'), 'staged\n');
    git(cwd, 'add', 'readme.txt');
    await writeFile(join(cwd, 'draft.txt'), 'unstaged\n');
    await writeFile(join(cwd, 'new item.txt'), 'untracked\n');
  }
  if (scenario.id === 'commit') await writeFile(join(cwd, 'draft.txt'), 'ready\n');
  if (scenario.id === 'pull') {
    const editor = join(base, 'editor');
    git(cwd, 'clone', bare, editor);
    config(editor);
    await writeFile(join(editor, 'incoming.txt'), 'ready\n');
    git(editor, 'add', '.');
    git(editor, 'commit', '-m', 'feat: sync fixture');
    git(editor, 'push');
  }
  return { cwd, bare, before: git(cwd, 'rev-parse', 'HEAD'), initialStatus: git(cwd, 'status', '--porcelain=v1'),
    branch: git(cwd, 'branch', '--show-current') };
}
function validate(scenario, fixture, answer) {
  const { cwd, bare, before, initialStatus, branch } = fixture;
  assert.equal(answer?.branch, branch, 'reported branch');
  if (scenario.id === 'status') {
    assert.deepEqual(answer.staged, ['readme.txt']);
    assert.deepEqual(answer.unstaged, ['draft.txt']);
    assert.deepEqual(answer.untracked, ['new item.txt']);
    assert.equal(git(cwd, 'status', '--porcelain=v1'), initialStatus);
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), before);
  }
  if (scenario.id === 'commit') {
    assert.equal(answer.subject, 'chore: update draft');
    assert.equal(git(cwd, 'log', '-1', '--format=%s'), answer.subject);
    assert.equal(git(cwd, 'rev-parse', 'HEAD^'), before);
    assert.equal(git(cwd, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'draft.txt');
    assert.equal(git(cwd, 'status', '--porcelain=v1'), '');
  }
  if (scenario.id === 'pull') {
    assert.equal(answer.subject, 'feat: sync fixture');
    assert.equal(git(cwd, 'log', '-1', '--format=%s'), answer.subject);
    assert.equal(git(cwd, 'rev-parse', 'HEAD^'), before);
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), git(bare, 'rev-parse', 'main'));
    assert.equal(git(cwd, 'status', '--porcelain=v1'), '');
  }
  if (scenario.id === 'push') {
    const upstream = answer.upstream.replace(/^refs\/remotes\//, '');
    assert.equal(upstream, 'origin/' + branch);
    assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', '@{upstream}'), upstream);
    assert.equal(git(bare, 'rev-parse', 'refs/heads/' + branch), before);
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), before);
    assert.equal(git(cwd, 'status', '--porcelain=v1'), '');
  }
}

const toml = value => JSON.stringify(value);
const slash = value => value.replaceAll('\\', '/');
async function benchmark(scenario, repeat, arm, fixture) {
  const { cwd } = fixture;
  const server = arm === 'native' ? 'native' : 'gitkit';
  const toolArgs = arm === 'native' ? [join(root, 'bench/git-commands.mjs'), cwd]
    : [arm === 'reference' ? referenceCli : join(root, 'dist/cli.js'), 'mcp', '--cwd', cwd];
  const schemaPath = join(scratch, scenario.id + '.json');
  const timeout = http ? 90_000 : 200_000;
  const options = ['exec', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '--disable', 'shell_tool',
    '--model', model, '--json', '--output-schema', schemaPath, '-C', cwd,
    '-c', 'model_reasoning_effort="low"',
    '-c', 'developer_instructions=' + toml('通过当前提供的 MCP 工具执行仓库任务。只操作指定的实验仓库。根据工具返回给出准确的最终 JSON。'),
    '-c', `mcp_servers.${server}.command=${toml(slash(process.execPath))}`,
    '-c', `mcp_servers.${server}.args=${toml(toolArgs.map(slash))}`,
    '-c', `mcp_servers.${server}.required=true`, '-c', `mcp_servers.${server}.startup_timeout_sec=20`,
    '-c', `mcp_servers.${server}.default_tools_approval_mode="approve"`,
  ];
  if (http) options.push('-c', 'model_provider=gitkit_http',
    '-c', 'model_providers.gitkit_http={ name = "OpenAI benchmark", base_url = "https://chatgpt.com/backend-api/codex", wire_api = "responses", requires_openai_auth = true, supports_websockets = false, stream_max_retries = 1 }');
  if (server === 'gitkit') options.push('-c', 'mcp_servers.gitkit.enabled_tools=["branch","commit","diff","fetch","log","merge","pull","push","status"]');
  const start = performance.now();
  const child = spawn(process.execPath, [cli, ...options, scenario.prompt], { cwd, env: commonEnv, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const operations = [];
  const calls = new Map();
  const transport = [];
  let usage;
  let answer;
  let turnStarted;
  let turnEnded;
  let stderr = '';
  let terminalError;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
  lines.on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const now = performance.now();
    if (event.type === 'turn.started') turnStarted = now;
    if (event.type === 'turn.completed') { usage = event.usage; turnEnded = now; }
    if (['turn.failed', 'error'].includes(event.type)) transport.push(event.error?.message ?? event.message);
    if (event.type === 'item.started' && event.item.type === 'mcp_tool_call') calls.set(event.item.id, now);
    if (event.type === 'item.completed' && ['mcp_tool_call','command_execution'].includes(event.item.type)) {
      operations.push({ type: event.item.type, server: event.item.server, tool: event.item.tool,
        elapsedMs: calls.has(event.item.id) ? now - calls.get(event.item.id) : null, status: event.item.status,
        commands: event.item.arguments?.commands, error: event.item.error ?? undefined });
    }
    if (event.type === 'item.completed' && event.item.type === 'agent_message') {
      try { answer = JSON.parse(event.item.text); } catch { /* Progress messages are not final answers. */ }
    }
  });
  const timer = setTimeout(() => {
    terminalError = 'benchmark timeout';
    if (process.platform === 'win32') spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
    else child.kill('SIGKILL');
  }, timeout);
  const code = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  }).finally(() => { clearTimeout(timer); lines.close(); });
  let correct = false;
  let validationError;
  try {
    assert.equal(code, 0);
    assert.ok(usage, 'missing Codex usage counters');
    assert.ok(operations.length && operations.every(item => item.type === 'mcp_tool_call' && item.server === server),
      'unexpected execution path');
    validate(scenario, fixture, answer);
    correct = true;
  } catch (error) { validationError = error.message; }
  return { scenario: scenario.id, repeat, arm, success: correct, answer, usage,
    endToEndMs: (turnEnded ?? performance.now()) - start,
    turnMs: turnStarted === undefined || turnEnded === undefined ? null : turnEnded - turnStarted,
    calls: operations, transport, error: terminalError ?? validationError, ...(correct ? {} : { stderr }) };
}

const results = { model, reasoning: 'low', transport: http ? 'HTTP' : 'Codex default', versions: {
  codex: execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim(),
  git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(), node: process.version,
  gitkit: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version,
}, referenceArm, startedAt: new Date().toISOString(), scenarios, repeats, parallelPairs, results: [] };
const save = async () => writeFile(target, JSON.stringify(results, null, 2) + '\n');
try {
  for (const [id, properties] of Object.entries(schemaFor)) {
    const schema = { type: 'object', additionalProperties: false, required: Object.keys(properties),
      properties: Object.fromEntries(Object.entries(properties).map(([key, type]) => [key, type === 'array'
        ? { type, items: { type: 'string' } } : { type }])) };
    await writeFile(join(scratch, id + '.json'), JSON.stringify(schema));
  }
  const pairs = Array.from({ length: repeats }, (_, i) => (i % 2 ? [...scenarios].reverse() : scenarios)
    .map(scenario => ({ scenario, repeat: i + 1 }))).flat();
  for (let offset = 0; offset < pairs.length; offset += parallelPairs) {
    const batch = pairs.slice(offset, offset + parallelPairs);
    const tasks = [];
    for (const [i, { scenario, repeat }] of batch.entries()) {
      const arms = repeat % 2 === (offset + i) % 2 ? ['gitkit', referenceArm] : [referenceArm, 'gitkit'];
      for (const arm of arms) tasks.push({ scenario, repeat, arm, fixture: await makeFixture(scenario, repeat, arm) });
    }
    await Promise.all(tasks.map(async ({ scenario, repeat, arm, fixture }) => {
      const outcome = await benchmark(scenario, repeat, arm, fixture);
      results.results.push(outcome);
      console.log(JSON.stringify({ scenario: scenario.id, repeat, arm, ok: outcome.success, ms: Math.round(outcome.endToEndMs),
        usage: outcome.usage, calls: outcome.calls.length, error: outcome.error }));
    }));
    await save();
  }
} finally {
  if (results.results.length) {
    results.finishedAt = new Date().toISOString();
    await save();
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
}
