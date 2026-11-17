import { execute, inputSchema, toolNames, tools } from './index.js';

export const name = 'gitkit';
export const inject = ['tools'];
export interface PluginConfig { cwd?: string }
interface NativeTool {
  name: string; description: string; parameters: ReturnType<typeof inputSchema>;
  output: { schema: object; render(args: unknown, value: unknown): { type: 'text'; text: string }[] };
  execute(args: unknown, context: { signal: AbortSignal }): Promise<unknown>;
}
interface Context { tools: { register(tool: NativeTool): unknown } }
export function apply(ctx: Context, config?: PluginConfig) {
  for (const tool of toolNames) {
    ctx.tools.register({
      name: `gitkit_${tool}`, description: tools[tool].description, parameters: inputSchema(tool),
      output: { schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args, context) => execute(tool, config?.cwd ? { ...(args as object), cwd: config.cwd } : args, context.signal)
        .then(result => JSON.parse(JSON.stringify(result))),
    });
  }
}
