import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { execute, failure, inputSchema, isTool, outputSchema, toolNames, tools } from './index.js';

export async function serve(version: string, cwd?: string) {
  const server = new Server({ name: 'gitkit', version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolNames.map(name => ({
      name, description: tools[name].description, inputSchema: inputSchema(name),
      outputSchema,
      annotations: { readOnlyHint: tools[name].readOnly && name !== 'doctor' },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    const args = params.arguments ?? {};
    const result = !isTool(params.name) ? failure('未知工具') : await execute(params.name,
      { ...args, ...(cwd === undefined ? {} : { cwd }) }, signal);
    return { isError: !result.ok, structuredContent: { ...result }, content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  await server.connect(new StdioServerTransport());
}
