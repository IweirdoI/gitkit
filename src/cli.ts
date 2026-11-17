#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { readFileSync } from 'node:fs';
import { execute, failure, inputSchema, isTool, toolNames, tools, type Result } from './index.js';
import { serve } from './mcp.js';

const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const kebab = (value: string) => value.replace(/[A-Z]/g, character => '-' + character.toLowerCase());
const global = { cwd: { type: 'string' }, 'timeout-ms': { type: 'string' }, 'dry-run': { type: 'boolean' },
  yes: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' } } as const;
const print = (result: Result, json = false) => {
  if (json) console.log(JSON.stringify(result));
  else {
    const out = result.ok ? console.log : console.error;
    out(result.error_code ? `[${result.error_code}] ${result.message}` : result.message);
    if (result.files.length) out(result.files.join('\n'));
    if (result.data !== undefined) {
      const data = result.data as { patch?: string; detail?: string };
      if (data?.patch !== undefined) out(data.patch);
      else out(JSON.stringify(result.data, null, 2));
    }
    if (result.suggestion) out(result.suggestion);
  }
  if (!result.ok) process.exitCode = 1;
};

async function main() {
  const argv = process.argv.slice(2);
  const first = parseArgs({ args: argv, options: global, strict: false, allowPositionals: true, tokens: true });
  const command = first.tokens.find(token => token.kind === 'positional');
  const name = command?.kind === 'positional' ? command.value : '';
  if (first.values.version) return console.log(version);
  if (name === 'mcp') {
    const parsed = parseArgs({ args: argv.filter((_, index) => index !== command!.index),
      options: { cwd: global.cwd, help: global.help }, strict: true });
    if (parsed.values.help) return console.log('gitkit mcp [--cwd PATH]\n启动本地 stdio MCP 服务。');
    await serve(version, parsed.values.cwd);
    return;
  }
  if (!isTool(name)) {
    if (name && name !== 'help') return print(failure(`未知命令 ${name}`), Boolean(first.values.json));
    console.log('gitkit [全局选项] <命令> [参数]\n\n全局选项  --cwd PATH  --timeout-ms MS  --json  --dry-run  --yes  --help  --version\n');
    for (const tool of toolNames) console.log(`  ${tool.padEnd(14)} ${tools[tool].description}`);
    console.log('  mcp            启动 stdio MCP 服务');
    return;
  }
  const properties = inputSchema(name).properties;
  const options: NonNullable<ParseArgsConfig['options']> = { ...global };
  for (const [key, property] of Object.entries(properties)) {
    options[kebab(key)] = { type: property.type === 'boolean' ? 'boolean' : 'string', multiple: property.type === 'array' };
  }
  const args = argv.filter((_, index) => index !== command!.index);
  const parsed = parseArgs({ args, options, strict: true, allowPositionals: true });
  if (parsed.values.help) {
    console.log(`gitkit ${name} ${tools[name].positionals.map(key => `[${properties[key]?.enum?.join('|') ?? key}]`).join(' ')} [选项]\n${tools[name].description}\n`);
    for (const [key, property] of Object.entries(properties)) {
      console.log(`  --${kebab(key).padEnd(16)} ${property.description ?? property.enum?.join(' | ') ?? ''}`);
    }
    console.log('  --json            输出结构化 JSON\n  --help, -h        显示帮助');
    return;
  }
  const input: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(properties)) {
    const value = parsed.values[kebab(key)];
    if (value !== undefined) input[key] = property.type === 'integer' ? Number(value) : value;
  }
  if (parsed.positionals.length > tools[name].positionals.length) throw new Error('位置参数过多，请查看 --help');
  parsed.positionals.forEach((value, index) => {
    const key = tools[name].positionals[index];
    if (key in input) throw new Error(`参数 ${key} 重复`);
    input[key] = value;
  });
  print(await execute(name, input), Boolean(parsed.values.json));
}

main().catch(error => print(failure(error instanceof Error ? error.message : String(error)), process.argv.includes('--json')));
