import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execute, toolNames } from '../dist/index.js';
import { run } from '../dist/process.js';
import { provider, upsertPr } from '../dist/providers.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t, seed = true) {
  const cwd = await mkdtemp(join(tmpdir(), 'gitkit-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 3 }));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.email', 'gitkit@example.invalid');
  git(cwd, 'config', 'user.name', 'GitKit Test');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  git(cwd, 'config', 'core.autocrlf', 'false');
  git(cwd, 'config', 'core.hooksPath', '.git/hooks');
  if (seed) {
    await writeFile(join(cwd, 'base.txt'), 'base\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'test: seed');
  }
  return { cwd, call: (name, options = {}) => execute(name, { cwd, ...options }) };
}
test('unborn branch, empty and staged-only commit, unicode names, detached HEAD', async t => {
  const { cwd, call } = await fixture(t, false);
  assert.equal((await call('commit')).message, '无改动');
  const name = '中文 空格 🐈.txt';
  await writeFile(join(cwd, name), 'new\n');
  assert.deepEqual((await call('status')).files, [name]);
  assert.equal((await call('commit', { staged: true })).message, '无改动');
  assert.equal((await call('commit', { dryRun: true })).data.dry_run, true);
  assert.equal(git(cwd, 'diff', '--cached', '--name-only'), '');
  const created = await call('commit');
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.deepEqual(created.files, [name]);
  assert.equal((await call('log')).data.commits.length, 1);
  await rm(join(cwd, name));
  const deleted = await call('commit');
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.deepEqual(deleted.files, [name]);
  git(cwd, 'switch', '--detach');
  for (const name of ['commit', 'push']) assert.equal((await call(name)).error_code, 'detached_head');
});
test('secret scanning and hook errors keep work recoverable', async t => {
  const { cwd, call } = await fixture(t);
  const original = git(cwd, 'rev-parse', 'HEAD');
  await writeFile(join(cwd, 'key.txt'), '-----BEGIN OPENSSH PRIVATE KEY-----\n');
  const secret = await call('commit');
  assert.equal(secret.error_code, 'secret_detected', JSON.stringify(secret));
  assert.deepEqual(secret.files, ['key.txt']);
  assert.equal(JSON.stringify(secret).includes('OPENSSH'), false);
  await writeFile(join(cwd, 'key.txt'), 'safe\n');
  const hook = join(cwd, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\necho hook-marker >&2\nexit 1\n');
  await chmod(hook, 0o755);
  const blocked = await call('commit');
  assert.equal(blocked.error_code, 'hook_failed', JSON.stringify(blocked));
  assert.match(blocked.data.detail, /hook-marker/);
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), original);
  assert.equal((await call('commit', { noVerify: true })).error_code, 'confirmation_required');
  assert.equal((await call('commit', { noVerify: true, yes: true })).ok, true);
});
test('all Git subprocesses get EOF and kill a blocked descendant on timeout', async t => {
  const { cwd, call } = await fixture(t);
  git(cwd, 'config', 'alias.read-test', '!if read line; then exit 2; else echo got-eof; fi');
  assert.match((await run(cwd, ['read-test'], 3000)).stdout, /got-eof/);
  const hook = join(cwd, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nsleep 30\necho late > late.txt\n');
  await chmod(hook, 0o755);
  await writeFile(join(cwd, 'new.txt'), 'new\n');
  const then = Date.now();
  const timed = await call('commit', { timeoutMs: 1300 });
  assert.equal(timed.error_code, 'timeout', JSON.stringify(timed));
  assert.ok(Date.now() - then < 6500);
  await assert.rejects(readFile(join(cwd, 'late.txt')), { code: 'ENOENT' });
});
test('configured signing failure requires an explicit unsigned retry', async t => {
  const { cwd, call } = await fixture(t);
  git(cwd, 'config', 'commit.gpgsign', 'true');
  git(cwd, 'config', 'gpg.format', 'openpgp');
  git(cwd, 'config', 'gpg.program', 'git');
  await writeFile(join(cwd, 'signed.txt'), 'test\n');
  const signed = await call('commit');
  assert.equal(signed.error_code, 'signing_failed', JSON.stringify(signed));
  assert.equal((await call('commit', { unsigned: true })).error_code, 'confirmation_required');
  assert.equal((await call('commit', { unsigned: true, yes: true })).ok, true);
  assert.equal(git(cwd, 'config', 'commit.gpgsign'), 'true');
});
test('LFS uses an exact path rule and stages a pointer, doctor reports attributes', async t => {
  const { cwd, call } = await fixture(t);
  try { git(cwd, 'lfs', 'version'); } catch { t.skip('Git LFS unavailable'); return; }
  const name = 'mesh [雪] space.glb';
  await writeFile(join(cwd, name), Buffer.alloc(1024 ** 2 + 1));
  const plan = await call('commit', { dryRun: true, thresholdMb: 1 });
  assert.equal(plan.data.plan.assets.needsLfs, true);
  const committed = await call('commit', { thresholdMb: 1 });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.match(git(cwd, 'show', 'HEAD:' + name), /version https:\/\/git-lfs/);
  const report = await call('doctor', { thresholdMb: 1 });
  assert.equal(report.data.assets.find(asset => asset.path === name).compliant, true);
});
test('index.lock retries, confirmed stale locks and concurrent GitKit operations', async t => {
  const { cwd, call } = await fixture(t);
  const indexLock = join(cwd, '.git', 'index.lock');
  await writeFile(join(cwd, 'new.txt'), 'new');
  await writeFile(indexLock, '');
  const pending = call('commit');
  setTimeout(() => rm(indexLock, { force: true }), 250);
  assert.equal((await pending).ok, true);
  await writeFile(indexLock, '');
  const old = new Date(Date.now() - 11 * 60_000);
  await utimes(indexLock, old, old);
  assert.equal((await call('doctor', { action: 'unlock' })).error_code, 'confirmation_required');
  assert.equal((await call('doctor', { action: 'unlock', yes: true })).files.length, 1);
  await writeFile(join(cwd, 'edit.txt'), 'a');
  const both = await Promise.all([call('commit'), call('commit')]);
  assert.ok(both.every(item => item.ok || item.error_code === 'index_lock'));
  assert.equal(git(cwd, 'rev-list', '--count', 'HEAD'), '3');
});
test('push sets upstream, pull fetches divergent branch and abort preserves backup', async t => {
  const { cwd, call } = await fixture(t);
  const bare = join(cwd, '.git', 'remote.git');
  const other = join(cwd, '.git', 'other');
  git(cwd, 'init', '--bare', '-b', 'main', bare);
  git(cwd, 'remote', 'add', 'origin', bare);
  const pushed = await call('push');
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  assert.equal(pushed.data.upstream, 'origin/main');
  assert.equal(pushed.data.commit, git(cwd, 'rev-parse', 'HEAD'));
  assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/main');
  git(cwd, 'clone', bare, other);
  git(other, 'config', 'user.email', 'test@example.invalid');
  git(other, 'config', 'user.name', 'test');
  git(other, 'config', 'commit.gpgsign', 'false');
  git(other, 'config', 'core.autocrlf', 'false');
  await writeFile(join(other, 'base.txt'), 'other\n');
  git(other, 'commit', '-am', 'other');
  git(other, 'push');
  await writeFile(join(cwd, 'base.txt'), 'mine\n');
  await call('commit');
  const conflict = await call('pull');
  assert.equal(conflict.error_code, 'conflict', JSON.stringify(conflict));
  assert.deepEqual(conflict.files, ['base.txt']);
  assert.ok(conflict.data.backup);
  assert.equal((await call('integrate', { action: 'abort', yes: true })).ok, true);
  assert.equal(await readFile(join(cwd, 'base.txt'), 'utf8'), 'mine\n');
  git(cwd, 'branch', 'sync', 'HEAD^');
  git(cwd, 'switch', 'sync');
  const fastForward = await call('pull', { source: 'main', ffOnly: true });
  assert.equal(fastForward.ok, true, JSON.stringify(fastForward));
  assert.equal(fastForward.data.subject, 'other');
  assert.equal(fastForward.data.commit, git(cwd, 'rev-parse', 'HEAD'));
});
test('push preflight excludes advertised history and scans blobs reachable only from stale tracking refs', async t => {
  const { cwd, call } = await fixture(t);
  const bare = join(cwd, '.git', 'remote.git');
  git(cwd, 'init', '--bare', '-b', 'main', bare);
  git(cwd, 'remote', 'add', 'origin', bare);
  await writeFile(join(cwd, 'oversized.bin'), Buffer.alloc(1024 ** 2 + 1));
  git(cwd, 'add', 'oversized.bin');
  git(cwd, 'commit', '-m', 'seed: already published blob');
  git(cwd, 'push', '-u', 'origin', 'main');
  git(cwd, 'switch', '-c', 'topic');
  assert.equal((await call('push', { gitLimitMb: 1 })).ok, true);
  git(cwd, 'switch', '-c', 'fresh');
  git(bare, 'update-ref', '-d', 'refs/heads/main');
  git(bare, 'update-ref', '-d', 'refs/heads/topic');
  assert.ok(git(cwd, 'rev-parse', 'origin/main'));
  const blocked = await call('push', { gitLimitMb: 1 });
  assert.equal(blocked.error_code, 'platform_limit', JSON.stringify(blocked));
  assert.equal(git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/fresh'), '');
});
test('path-specific rollback backs up untracked and index-only paths', async t => {
  const { cwd, call } = await fixture(t);
  await writeFile(join(cwd, 'index.txt'), 'index');
  await writeFile(join(cwd, 'untracked.txt'), 'untracked');
  git(cwd, 'add', 'index.txt');
  const rollback = await call('rollback', { action: 'worktree', paths: ['index.txt', 'untracked.txt'], yes: true });
  assert.equal(rollback.ok, true, JSON.stringify(rollback));
  assert.ok(rollback.data.stash);
  assert.deepEqual((await call('status')).files, []);
  assert.equal((await call('stash', { action: 'apply' })).ok, true);
  assert.equal(await readFile(join(cwd, 'index.txt'), 'utf8'), 'index');
  assert.equal(await readFile(join(cwd, 'untracked.txt'), 'utf8'), 'untracked');
});
test('LFS push enforces the object ceiling and classifies a stalled LFS endpoint', async t => {
  const { cwd, call } = await fixture(t);
  try { git(cwd, 'lfs', 'version'); } catch { t.skip('Git LFS unavailable'); return; }
  const bare = join(cwd, '.git', 'remote.git');
  git(cwd, 'init', '--bare', bare);
  git(cwd, 'remote', 'add', 'origin', bare);
  await writeFile(join(cwd, 'video.mp4'), Buffer.alloc(1024 ** 2 + 1));
  const committed = await call('commit', { thresholdMb: 1 });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal((await call('push', { lfsLimitMb: 1 })).error_code, 'platform_limit');
  let batches = 0;
  const server = createServer((req, _res) => {
    if (req.url.endsWith('/objects/batch')) batches++;
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  git(cwd, 'config', 'lfs.url', `http://127.0.0.1:${server.address().port}/lfs`);
  const result = await call('push', { timeoutMs: 1800 });
  assert.equal(result.error_code, 'timeout', JSON.stringify(result));
  assert.match(result.message, /LFS/);
  assert.ok(batches >= 1);
  assert.equal(git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads'), '');
});
test('GitHub and Gitee PR adapters create and update the PR without duplicating it', async t => {
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    const github = url.hostname === 'api.github.com';
    assert.equal(url.pathname.includes('/repos/team/project/pulls'), true);
    const payload = options.body && JSON.parse(options.body);
    if (github) assert.equal(options.headers.Authorization, 'Bearer test-github');
    else assert.equal(options.method === 'GET' ? url.searchParams.get('access_token') : payload.access_token, 'test-gitee');
    const pr = { number: 12, html_url: 'https://example.invalid/pr/12',
      head: { ref: 'topic', repo: { full_name: 'team/project' } }, base: { ref: 'main' } };
    if (options.method === 'GET') return Response.json(url.searchParams.get('state') === 'open' && active ? [pr] : []);
    if (options.method === 'POST') assert.equal(payload.head, 'topic');
    else assert.equal(url.pathname.endsWith('/12'), true);
    return Response.json(pr);
  });
  const originals = [process.env.GITHUB_TOKEN, process.env.GITEE_TOKEN];
  process.env.GITHUB_TOKEN = 'test-github';
  process.env.GITEE_TOKEN = 'test-gitee';
  t.after(() => ['GITHUB_TOKEN', 'GITEE_TOKEN'].forEach((name, i) => {
    if (originals[i] === undefined) delete process.env[name]; else process.env[name] = originals[i];
  }));
  let active;
  for (const url of ['git@github.com:team/project.git', 'https://gitee.com/team/project.git']) {
    const target = provider(url);
    assert.ok(target);
    active = false;
    assert.equal((await upsertPr({ timeout: 2000 }, target, 'topic', 'main')).existing, false);
    active = true;
    assert.equal((await upsertPr({ timeout: 2000 }, target, 'topic', 'main', 'Updated')).existing, true);
  }
});
test('registered worktrees are listed and removable with confirmation', async t => {
  const { cwd, call } = await fixture(t);
  const path = join(cwd, '.git', 'other-worktree');
  const created = await call('worktree', { action: 'create', path });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal((await call('worktree')).data.managed.length, 1);
  const removalPath = process.platform === 'win32'
    ? path.replace(/^[A-Z]/, drive => drive.toLowerCase())
    : path;
  assert.equal((await call('worktree', { action: 'remove', path: removalPath })).error_code, 'confirmation_required');
  const removed = await call('worktree', { action: 'remove', path: removalPath, yes: true });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal((await call('worktree')).data.managed.length, 0);
});
test('branch switching and confirmed hard resets preserve colliding ignored files', async t => {
  const { cwd, call } = await fixture(t);
  git(cwd, 'switch', '-c', 'target');
  await writeFile(join(cwd, 'local.config'), 'tracked\n');
  git(cwd, 'add', 'local.config');
  git(cwd, 'commit', '-m', 'test: tracked config');
  git(cwd, 'switch', 'main');
  await writeFile(join(cwd, '.git', 'info', 'exclude'), 'local.config\n');
  await writeFile(join(cwd, 'local.config'), 'local secret config\n');
  assert.equal((await call('branch', { action: 'switch', name: 'target' })).ok, false);
  const reset = await call('rollback', { action: 'commit', target: 'target', hard: true, yes: true });
  assert.equal(reset.error_code, 'ignored_file_collision', JSON.stringify(reset));
  assert.equal(await readFile(join(cwd, 'local.config'), 'utf8'), 'local secret config\n');
});
test('stdio MCP lists every command and matches CLI structured results and errors', async t => {
  const { cwd } = await fixture(t);
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--cwd', cwd], stderr: 'pipe' });
  await client.connect(transport);
  t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), [...toolNames].sort());
  assert.match((await client.listTools()).tools.find(tool => tool.name === 'pull').description, /拉取远端最新/);
  const status = JSON.parse(execFileSync(process.execPath, [cli, '--json', 'status', '--cwd', cwd], { encoding: 'utf8' }));
  assert.deepEqual((await client.callTool({ name: 'status', arguments: {} })).structuredContent, status);
  const refused = await client.callTool({ name: 'push', arguments: { force: true } });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error_code, 'confirmation_required');
});
