import './issue-fixture.mjs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({name:'native-rest',version:'1'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[{
 name:'api', description:'Read GitHub Issues through the REST API. Returns the full JSON API response.',
 inputSchema:{type:'object',properties:{per_page:{type:'integer',minimum:1,maximum:100}},required:['per_page'],additionalProperties:false}
}]}));
server.setRequestHandler(CallToolRequestSchema, async ({params}) => {
 const response=await fetch('https://api.github.com/repos/example/project/issues?state=open&per_page='+params.arguments.per_page);
 return {content:[{type:'text',text:JSON.stringify(await response.json())}]};
});
await server.connect(new StdioServerTransport());
