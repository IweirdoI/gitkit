import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { run, GitError } from '../dist/process.js';

const cwd = process.argv[2];
const allowed = new Set(['add', 'branch', 'commit', 'diff', 'fetch', 'log', 'merge', 'pull', 'push', 'remote', 'rev-parse', 'status', 'symbolic-ref']);
const globalFlags = new Set(['--no-optional-locks', '--no-pager', '--literal-pathspecs', '--no-replace-objects']);
const server = new Server({ name: 'native-git-benchmark', version: '1.0.0' }, { capabilities: { tools: {} } });

function normalize(args) {
  if (!Array.isArray(args) || args.length > 50 ||
    args.some(arg => typeof arg !== 'string' || arg.length > 1024 || /\x00/.test(arg))) return null;
  const command = args[0] === 'git' ? args.slice(1) : args;
  const verb = command.find(arg => !globalFlags.has(arg));
  return allowed.has(verb) ? command : null;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'git',
    description: '在当前实验仓库执行原生 Git 命令。一次调用支持多条命令，按顺序执行，首个失败时停止。每条分别返回退出码、stdout、stderr。',
    inputSchema: {
      type: 'object', required: ['commands'], additionalProperties: false,
      properties: { commands: {
        type: 'array', minItems: 1, maxItems: 12, items: { type: 'array', minItems: 1, maxItems: 50,
          items: { type: 'string' }, description: 'Git 参数数组，例如 ["status", "--short"]，可带开头的 git。' },
      } },
    },
  }],
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const input = params.arguments?.commands;
  const commands = Array.isArray(input) ? input.map(normalize) : [];
  const output = [];
  if (params.name !== 'git' || !commands.length || commands.length > 12 || commands.includes(null)) {
    return { isError: true, content: [{ type: 'text', text: 'Invalid Git command batch' }] };
  }
  let isError = false;
  for (const args of commands) {
    try {
      const result = await run(cwd, args, 15000, Array.from({ length: 256 }, (_, i) => i));
      output.push({ args, ...result });
      if (result.status !== 0) { isError = true; break; }
    } catch (error) {
      output.push({ args, status: -1, stderr: error instanceof GitError ? error.detail || error.message : String(error) });
      isError = true;
      break;
    }
  }
  return { isError, content: [{ type: 'text', text: JSON.stringify(output) }] };
});
await server.connect(new StdioServerTransport());
