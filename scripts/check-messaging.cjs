const { buildSync } = require('esbuild')
const { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const path = require('node:path')
const compiled = buildSync({ stdin: { contents: `
export {ModelStream,messagePreview} from './src/model/stream'; export {callModel} from './src/model/protocol'; export { Repository } from './src/data/repository'; export { Database } from './src/data/database';
export { schema } from './src/data/schema'; export { DataStore } from './src/data/store';
export { AgentRuntime } from './src/agent/runtime'; export {storeCredential} from './src/platform/secureTransport'; export * from './src/data/modularBackup';`,
  resolveDir: path.resolve(__dirname, '..') }, bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const mod = { exports: {} }
new Function('require', 'module', 'exports', compiled)(require, mod, mod.exports)
const { Repository, Database, schema, DataStore, AgentRuntime, createBackupZip, readBackupZip, mergeBackupModules, storeCredential, ModelStream, messagePreview, callModel } = mod.exports
const connections = new Map()
function connection(name) {
  if (connections.has(name)) return connections.get(name)
  const sql = new DatabaseSync(':memory:')
  const conn = {
    query: async (q, values = []) => ({ values: sql.prepare(q).all(...values) }),
    run: async (q, values = []) => sql.prepare(q).run(...values),
    execute: async q => sql.exec(q),
    isTransactionActive: async () => ({ result: sql.isTransaction }),
    beginTransaction: async () => sql.exec('BEGIN'), commitTransaction: async () => sql.exec('COMMIT'),
    rollbackTransaction: async () => sql.exec('ROLLBACK')
  }
  const entry = { sql, conn }; connections.set(name, entry); return entry
}
// Real SQL and real staging catalog, with the native connection lifecycle replaced.
Database.prototype.open = async function () {
  const { conn } = connection(this.databaseName); this.db = conn
  if (this.initializeSchema) { await this.migrateExistingTables(); await conn.execute(schema) }
}
Database.prototype.close = async function () { this.db = null }
Database.prototype.adopt = async function (candidate) { this.name = candidate.name; this.db = candidate.db; candidate.db = null }
Database.exists = async name => connections.has(name)
Database.remove = async name => { connections.get(name)?.sql.close(); connections.delete(name) }
async function fixture() {
  const db = new Database(`fixture-${crypto.randomUUID()}`); await db.open()
  const repo = new Repository(db); await repo.ensureLocalUser()
  const a = await repo.saveAgent({ name: 'A' }), b = await repo.saveAgent({ name: 'B' })
  const room = await repo.createGroup('group', [a.id, b.id])
  return { db, repo, a, b, room, sql: connections.get(db.databaseName).sql }
}

const originalFetch = global.fetch
function reply(f, body, sequence, author=f.a) {
  const id=crypto.randomUUID()
  f.sql.prepare(`INSERT INTO messages(id,conversation_id,author_id,author_name,author_kind,body,sequence,request_id,created_at)
    VALUES (?,?,?,?,'agent',?,?,?,?)`).run(id,f.room.id,author.id,author.name,body,sequence,crypto.randomUUID(),Date.now())
  f.sql.prepare('UPDATE conversations SET next_sequence=? WHERE id=?').run(sequence+1,f.room.id)
  return id
}
async function main() {
  const f=await fixture()
  const user=await f.repo.sendUserMessage(f.room.id,'original question','new-messaging-1')
  const id=reply(f,'old answer',2)
  const memory=await f.repo.saveMemory({agentId:f.a.id,conversationId:f.room.id,body:'old fact',origin:'agent',sourceMessageIds:[id]})
  await f.repo.editMessage(id,'edited answer')
  assert.equal((await f.repo.messageById(id)).body,'edited answer')
  assert.equal((await f.repo.messageById(id)).editHistory[0].body,'old answer')
  assert.equal(f.sql.prepare('SELECT valid FROM memories WHERE id=?').get(memory.id).valid,0)
  await f.repo.editMessage(id,'old answer')
  assert.equal((await f.repo.messageById(id)).editHistory.length,2)
  console.log('PASS edits retain versions, restore and invalidate source memories')
  reply(f,'FUTURE_SECRET',3,f.b)
  await f.repo.saveMemory({agentId:f.a.id,body:'FUTURE_SECRET',origin:'agent'})
  const branch=await f.repo.regenerateBranch(id)
  assert.ok(!(await f.repo.listMemories(f.a.id,branch)).some(row=>row.body.includes('FUTURE_SECRET')))
  const branchMessages=await f.repo.allMessages(branch)
  assert.equal(branchMessages.length,1)
  assert.equal(branchMessages[0].body,'original question')
  assert.equal((await f.repo.allMessages(f.room.id)).length,3)
  assert.deepEqual((await f.repo.routingPlan(branchMessages[0].id)).targets,[f.a.id])
  global.fetch=async (url,options)=> {
    const request=JSON.parse(options.body)
    assert.ok(!JSON.stringify(request).includes('FUTURE_SECRET'))
    const sent=request.input.some(item=>item.type==='function_call_output' && item.output.includes('已发送'))
    return new Response(JSON.stringify({status:'completed',output:[{type:'function_call',call_id:crypto.randomUUID(),name:sent?'turn_finish':'message_send',arguments:JSON.stringify(sent?{}:{body:'BRANCH_ANSWER'})}]}))
  }
  const provider={id:crypto.randomUUID(),name:'mock',protocol:'responses',baseUrl:'https://messaging.invalid/v1',credentialState:'stored',credentialRef:'',enabled:true,configVersion:1,createdAt:0,updatedAt:0}
  await f.repo.saveProvider(provider);await storeCredential(provider.id,'test-key','https://messaging.invalid')
  const binding={id:crypto.randomUUID(),purpose:'main',providerId:provider.id,modelId:'mock',contextTokens:16000,outputTokens:2048}
  await f.repo.saveBinding(binding)
  const runtime=new AgentRuntime(f.repo,()=>f.repo.listProviders(),()=>f.repo.listBindings())
  await runtime.drainConversation(branch)
  assert.equal((await f.repo.allMessages(branch)).at(-1).body,'BRANCH_ANSWER')
  assert.equal((await f.repo.allMessages(branch)).at(-1).authorId,f.a.id)
  assert.equal((await f.repo.allMessages(f.room.id)).length,3)
  await runtime.withMaintenance(async()=>{})
  console.log('PASS regeneration runs the selected character in an independent prefix-only branch')
  await assert.rejects(f.repo.editMessage(id,'',true),/只能撤回/)
  await f.repo.editMessage(user.id,'',true)
  const recalled=await f.repo.messageById(user.id)
  assert.equal(recalled.recalled,true);assert.ok(!recalled.body.includes('original question'));assert.deepEqual(recalled.editHistory,[])
  assert.equal((await f.repo.searchMessages('original question',{conversationId:f.room.id})).length,0)
  assert.ok((await f.repo.agentMessages(f.a.id,f.room.id,{through:3})).some(row=>row.body.includes('撤回')))
  console.log('PASS recall ownership, redaction, search exclusion and model-visible event')
  for(let i=0;i<121;i++) await f.repo.sendUserMessage(f.room.id,`needle ${i}`,`page-${i}`)
  const pages=await Promise.all([0,50,100].map(offset=>f.repo.searchMessages('needle',{offset,conversationId:f.room.id})))
  assert.deepEqual(pages.map(p=>p.length),[50,50,21]);assert.equal(new Set(pages.flat().map(x=>x.id)).size,121)
  assert.equal((await f.repo.searchMessages('needle',{authorId:f.a.id})).length,0)
  const cursor=pages[0].at(-1)
  await f.repo.sendUserMessage(f.room.id,'needle inserted during search','paging-concurrent')
  const next=await f.repo.searchMessages('needle',{conversationId:f.room.id,beforeCreatedAt:cursor.createdAt,beforeId:cursor.id})
  assert.deepEqual(next.map(row=>row.id),pages[1].map(row=>row.id))
  const backup=await f.repo.exportBackup();await f.repo.importBackup(backup)
  assert.equal((await f.repo.messageById(user.id)).recalled,true)
  assert.equal((await f.repo.messageById(id)).editHistory.length,2)
  assert.equal((await f.repo.allMessages(branch)).at(-1).body,'BRANCH_ANSWER')
  console.log('PASS search pagination, filters, and edit/recall/branch backup round trip')
  let previews=[]
  const stream=new ModelStream('chat-completions',value=>previews.push(value))
  const events=[{choices:[{delta:{tool_calls:[{index:0,id:'call-1',function:{name:'message_send',arguments:'{"body":"hello '}}]}}]},
    {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'world"}'}}]},finish_reason:'tool_calls'}]},
    {choices:[],usage:{prompt_tokens:12,completion_tokens:8}}]
  const wire=events.map(event=>'data: '+JSON.stringify(event)+'\r\n\r\n').join('')+'data: [DONE]\r\n\r\n'
  for(const char of wire) stream.frames.push(char)
  assert.ok(previews.includes('hello world'));assert.equal(JSON.parse(stream.result().choices[0].message.tool_calls[0].function.arguments).body,'hello world')
  assert.equal(stream.result().usage.prompt_tokens,12)
  const incomplete=new ModelStream('chat-completions');incomplete.frames.push('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
  assert.throws(()=>incomplete.result(),/完成/)
  const failed=new ModelStream('responses');failed.frames.push('data: {"type":"response.failed"}\n\n');assert.throws(()=>failed.result(),/失败/)
  console.log('PASS chunk-split SSE, partial tool preview, usage, and rejection of truncated/failed streams')
  const chat={...provider,id:crypto.randomUUID(),protocol:'chat-completions'};await storeCredential(chat.id,'test','https://messaging.invalid')
  const request={instructions:'test',input:[{role:'user',content:'hello'}]}
  let requests=0
  global.fetch=async (url,opts)=> {
    requests++;assert.equal(JSON.parse(opts.body).stream,true)
    const bytes=new TextEncoder().encode(wire)
    return new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));controller.close()}}),{headers:{'content-type':'text/event-stream'}})
  }
  const complete=await callModel(chat,'mock',request,new AbortController().signal,value=>{})
  assert.equal(complete.toolCalls[0].arguments.body,'hello world');assert.equal(requests,1)
  global.fetch=async (url,opts)=> {
    requests++
    if(JSON.parse(opts.body).stream)return new Response('stream is not supported',{status:400})
    return new Response(JSON.stringify({choices:[{message:{content:'fallback'},finish_reason:'stop'}]}))
  }
  const fallback={...chat,configVersion:2};requests=0
  assert.equal((await callModel(fallback,'mock',request,new AbortController().signal,()=>{})).text,'fallback')
  assert.equal(requests,2)
  await callModel(fallback,'mock',request,new AbortController().signal,()=>{});assert.equal(requests,3)
  console.log('PASS browser streaming transport and explicit unsupported-stream capability fallback/cache')
  const responsesWire=[{type:'response.output_item.added',output_index:0,item:{type:'function_call',call_id:'r1',name:'message_send',arguments:''}},
    {type:'response.function_call_arguments.delta',output_index:0,delta:'{"body":"response preview"}'},
    {type:'response.completed',response:{status:'completed',output:[{type:'function_call',call_id:'r1',name:'message_send',arguments:'{"body":"response preview"}'}]}}]
      .map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')
  let preview=''
  const responseParser=new ModelStream('responses',text=>preview=text);for(const c of responsesWire)responseParser.frames.push(c)
  assert.equal(preview,'response preview');assert.equal(responseParser.result().status,'completed')
  let entered;const enteredRequest=new Promise(resolve=>entered=resolve)
  global.fetch=async(url,opts)=>{entered();return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}))}
  await f.repo.saveProvider(provider)
  const slowQuestion=await f.repo.sendUserMessage(branch,'slow question','cancel-on-edit')
  const pending=runtime.drainConversation(branch)
  let timeout
  await Promise.race([enteredRequest,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('No model request started')),3000)})]);clearTimeout(timeout)
  await runtime.mutateConversation(branch,()=>f.repo.editMessage(slowQuestion.id,'corrected question'))
  await pending
  assert.equal((await f.repo.messageById(slowQuestion.id)).body,'corrected question')
  assert.equal((await f.repo.allMessages(branch)).filter(m=>m.authorKind==='agent').length,1)
  await runtime.withMaintenance(async()=>{})
  console.log('PASS Responses stream preview and editing cancels an in-flight real Runtime before committing new text')

  const old=new DatabaseSync(':memory:');old.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,body TEXT)')
  const migration=new Database('migration');migration.db={query:async(q,args=[])=>({values:old.prepare(q).all(...args)}),execute:async q=>old.exec(q)}
  await migration.migrateExistingTables()
  assert.ok(old.prepare('PRAGMA table_info(messages)').all().some(row=>row.name==='edit_history'));old.close()
  console.log('PASS additive migration installs message metadata without replacing old messages')
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{global.fetch=originalFetch;for(const entry of connections.values())entry.sql.close()})
