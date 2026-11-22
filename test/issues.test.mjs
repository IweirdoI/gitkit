import { test } from 'node:test';
import assert from 'node:assert/strict';
import {execute} from '../dist/index.js';
import {execFileSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';

for (const platform of ['github','gitee']) {
 test(platform+' issue lifecycle, compact list, dry-run, validation and timeout', async t => {
  const name=platform==='github'?'GITHUB_TOKEN':'GITEE_TOKEN';
  const old=process.env[name];process.env[name]='test-token';
  t.after(()=>{if(old===undefined)delete process.env[name];else process.env[name]=old;});
  const base={platform,repo:'team/project'};
  const record={number:platform==='github'?7:'I7',title:'Fixture',html_url:'https://example.invalid/issue/7',state:'open',body:'full body'};
  let calls=[];let timeout=false;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
   calls.push({url:new URL(url),...options});
   if(timeout)throw new DOMException('timeout','TimeoutError');
   const body=options.body?JSON.parse(options.body):undefined;
   if(platform==='gitee')assert.equal(body?.access_token??new URL(url).searchParams.get('access_token'),'test-token');
   if(options.method==='GET'&&new URL(url).pathname.endsWith('/issues'))return Response.json([record,{...record,pull_request:{}}]);
   if(new URL(url).pathname.endsWith('/comments'))return Response.json({id:8,html_url:'https://example.invalid/comment/8'});
   return Response.json(record);
  });
  const dry=await execute('issue',{...base,action:'create',title:'Fixture',dryRun:true});
  assert.equal(dry.ok,true);assert.equal(calls.length,0);
  assert.equal((await execute('issue',{...base,action:'create'})).error_code,'invalid_input');
  const created=await execute('issue',{...base,action:'create',title:'Fixture',body:'details'});
  assert.equal(created.ok,true);assert.equal(created.data.number,String(record.number));
  if(platform==='gitee')assert.equal(calls[0].url.pathname,'/api/v5/repos/team/issues');
  const list=await execute('issue',{...base,limit:5});
  assert.equal(list.data.issues.length,1);assert.equal(list.data.issues[0].body,undefined);
  const viewed=await execute('issue',{...base,action:'view',number:String(record.number)});
  assert.equal(viewed.data.body,'full body');
  assert.equal((await execute('issue',{...base,action:'update',number:String(record.number),state:'closed'})).ok,true);
  assert.equal((await execute('issue',{...base,action:'comment',number:String(record.number),body:'comment'})).ok,true);
  calls=[];timeout=true;
  const failed=await execute('issue',{...base,action:'create',title:'Fixture'});
  assert.equal(failed.error_code,'timeout');assert.equal(calls.length,1);assert.match(failed.suggestion,/先检查/);
 });
}
test('Issue list shares CLI and MCP structured output',async t=>{
 const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
 const fixture=new URL('../bench/issue-fixture.mjs',import.meta.url).href;
 const options={repo:'example/project',platform:'github',action:'list',limit:5};
 const command=JSON.parse(execFileSync(process.execPath,['--import',fixture,cli,'issue','list',
  '--repo',options.repo,'--platform',options.platform,'--limit','5','--json'],{encoding:'utf8'}));
 const client=new Client({name:'issue-parity',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['--import',fixture,cli,'mcp'],stderr:'pipe'}));
 t.after(()=>client.close());
 const response=await client.callTool({name:'issue',arguments:options});
 assert.deepEqual(response.structuredContent,command);
 assert.equal(command.data.issues.length,5);
 assert.equal(command.data.issues[0].body,undefined);
});
