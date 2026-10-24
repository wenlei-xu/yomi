// Real SQLite and runtime methods; no live model calls or user database access.
const {buildSync}=require('esbuild'),{DatabaseSync}=require('node:sqlite'),assert=require('node:assert/strict'),path=require('node:path')
const code=buildSync({stdin:{contents:`export {Repository} from './src/data/repository';export {Database} from './src/data/database';
export {schema} from './src/data/schema';export {AgentRuntime} from './src/agent/runtime';export {parseSummaryResult} from './src/agent/summary';
export {storeCredential} from './src/platform/secureTransport';export * from './src/data/modularBackup';
export {encryptBackup,decryptBackup} from './src/data/backupCrypto';`,resolveDir:path.resolve(__dirname,'..')},bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text
const mod={exports:{}};new Function('require','module','exports',code)(require,mod,mod.exports)
const {Repository,Database,schema,AgentRuntime,parseSummaryResult,storeCredential,createBackupZip,readBackupZip,mergeBackupModules,encryptBackup,decryptBackup}=mod.exports
const databases=[],passed=[]
async function fixture(){
  const sql=new DatabaseSync(':memory:');sql.exec(schema);databases.push(sql)
  const db=new Database();db.db={query:async(q,v=[])=>({values:sql.prepare(q).all(...v)}),run:async(q,v=[])=>sql.prepare(q).run(...v),execute:async q=>sql.exec(q),
    isTransactionActive:async()=>({result:sql.isTransaction}),beginTransaction:async()=>sql.exec('BEGIN'),commitTransaction:async()=>sql.exec('COMMIT'),rollbackTransaction:async()=>sql.exec('ROLLBACK')}
  const repo=new Repository(db);await repo.ensureLocalUser();const a=await repo.saveAgent({name:'A'}),b=await repo.saveAgent({name:'B'})
  const room=await repo.createGroup('Group',[a.id,b.id]),dm=await repo.openDirect(a.id)
  const runtime=new AgentRuntime(repo,()=>repo.listProviders(),()=>repo.listBindings());runtime.wakeConversation=()=>{}
  return{sql,db,repo,a,b,room,dm,runtime}
}
const binding={contextTokens:16000,outputTokens:1200,purpose:'main',modelId:'audit',id:'binding',revision:1}
const send=(f,room,body)=>f.repo.sendUserMessage(room.id,body,crypto.randomUUID())
async function context(f,room,actor=f.a){const fresh=await f.repo.getConversation(room.id);return f.runtime.buildContext(await f.repo.getActor(actor.id),fresh,fresh.nextSequence-1,binding)}
async function runLease(f){const room=await f.repo.getConversation(f.dm.id),activityId=await f.repo.ensureActivity(room.id),runId=await f.repo.createRun(f.a.id,room.id,activityId)
 return{agentId:f.a.id,conversationId:room.id,epoch:room.cancelEpoch,profileVersion:(await f.repo.getActor(f.a.id)).profileVersion,runId,
   linkedSources:(await f.repo.linkedMemoryContext(room.id,f.a.id)).sources}}
async function guard(f,lease,work=async()=>true){return f.repo.agentTool(lease,{id:crypto.randomUUID(),name:'conversation_members',arguments:{}},work)}
async function check(name,fn){await fn();passed.push(name);console.log('PASS '+name)}
async function main(){
 await check('structured/legacy summary parsing and invalid JSON boundaries',async()=>{
   assert.deepEqual(parseSummaryResult('```json\n{"cumulative":"ALL","segment":"NEW"}\n```'),{cumulative:'ALL',segment:'NEW'})
   assert.deepEqual(parseSummaryResult('legacy snapshot'),{cumulative:'legacy snapshot',segment:''})
   assert.throws(()=>parseSummaryResult('{"segment":"missing cumulative"}'))
 })
 await check('two compactions retain incremental ranges; only latest cumulative enters prompts',async()=>{
   const f=await fixture();for(let i=1;i<=84;i++)await send(f,f.room,'EVENT_'+i)
   const provider={id:crypto.randomUUID(),name:'audit',protocol:'responses',baseUrl:'https://memory-audit.invalid/v1',credentialState:'stored',credentialRef:'',enabled:true,configVersion:1,createdAt:0,updatedAt:0}
   await f.repo.saveProvider(provider);await storeCredential(provider.id,'test-only','https://memory-audit.invalid')
   const model={...binding,providerId:provider.id};await f.repo.saveBinding(model)
   const activity=await f.repo.ensureActivity(f.room.id),runId=await f.repo.createRun(f.a.id,f.room.id,activity),previous=global.fetch;let calls=0
   global.fetch=async(url,options)=>{assert.match(String(url),/^https:\/\/memory-audit.invalid\//);calls++;const request=JSON.parse(options.body)
     assert.match(request.instructions,/segment/);return new Response(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({cumulative:calls===1?'CUM_FIRST':'CUM_ALL',segment:calls===1?'SEG_FIRST':'SEG_NEW'})}]}],usage:{input_tokens:10,output_tokens:10}}))}
   try{for(const through of [80,84])await f.runtime.compactIfNeeded(f.a,f.room,through,new AbortController(),runId,activity,model)}finally{global.fetch=previous}
   const timeline=await f.repo.summaryTimeline(f.room.id,f.a.id)
   assert.equal(calls,2);assert.deepEqual(timeline.map(e=>[e.startSequence,e.throughSequence,e.kind]),[[57,60,'segment'],[1,56,'segment']])
   const prompt=JSON.stringify((await context(f,f.room)).input)
   assert.match(prompt,/CUM_ALL/);assert.doesNotMatch(prompt,/CUM_FIRST|SEG_FIRST|SEG_NEW/);assert.equal(prompt.split('CUM_ALL').length-1,1)
 })
 await check('timeline pages and retains invalid historical snapshots after message edits',async()=>{
   const f=await fixture();let first
   for(let i=1;i<=23;i++){const msg=await send(f,f.room,'message '+i);first??=msg;await f.repo.saveSummary({agentId:f.a.id,conversationId:f.room.id,contentRevision:1,throughSequence:i,body:'CUM_'+i,startSequence:1,segmentStartSequence:i,segmentBody:'SEG_'+i})}
   const page=await f.repo.summaryTimeline(f.room.id,f.a.id),older=await f.repo.summaryTimeline(f.room.id,f.a.id,page.at(-1).throughSequence)
   assert.equal(page.length,20);assert.equal(older.length,3);assert.equal(new Set([...page,...older].map(e=>e.id)).size,23)
   await f.repo.editMessage(first.id,'corrected')
   assert.equal((await f.repo.summaryTimeline(f.room.id,f.a.id)).every(e=>!e.valid),true)
   assert.equal(await f.repo.summaryFor(f.a.id,f.room.id,2),null)
 })
 await check('short group events reach the linked role DM; private notes, peers and nested links stay isolated',async()=>{
   const f=await fixture();await send(f,f.room,'GROUP_EVENT')
   await f.repo.saveMemory({agentId:f.a.id,conversationId:f.room.id,body:'A_OWN_MEMORY',origin:'human'})
   await f.repo.saveMemory({agentId:f.b.id,conversationId:f.room.id,body:'B_SECRET',origin:'human'})
   await f.repo.saveConversationNote({conversationId:f.room.id,scope:'private',targetActorId:f.b.id,body:'B_PRIVATE_NOTE'})
   await f.repo.setConversationMemorySources(f.dm.id,f.a.id,[f.room.id,f.room.id])
   const text=JSON.stringify((await context(f,f.dm)).input)
   assert.match(text,/GROUP_EVENT/);assert.match(text,/A_OWN_MEMORY/);assert.doesNotMatch(text,/B_SECRET|B_PRIVATE_NOTE/)
   const bDM=await f.repo.openDirect(f.b.id);assert.doesNotMatch(JSON.stringify((await context(f,bDM,f.b)).input),/GROUP_EVENT|A_OWN_MEMORY/)
   await assert.rejects(f.repo.setConversationMemorySources(bDM.id,f.b.id,[f.dm.id]),/不在/)
   await assert.rejects(f.repo.setConversationMemorySources(f.dm.id,f.a.id,[f.dm.id]))
   await assert.rejects(f.repo.setConversationMemorySources(f.dm.id,f.a.id,['missing-room']))
   assert.equal((await f.repo.conversationMemorySources(f.dm.id,f.a.id)).filter(s=>s.linked).length,1)
   await send(f,f.dm,'DM_EVENT');await f.repo.setConversationMemorySources(f.room.id,f.a.id,[f.dm.id])
   const reverse=(await f.repo.linkedMemoryContext(f.room.id,f.a.id)).text
   assert.match(reverse,/DM_EVENT/);assert.doesNotMatch(reverse,/GROUP_EVENT|A_OWN_MEMORY/)
   assert.equal((await f.repo.linkedMemoryContext(f.dm.id,f.a.id,1)).text,'')
 })
 await check('unlink, membership boundaries and deletion stop live references without copying sources',async()=>{
   const f=await fixture();await send(f,f.room,'BEFORE_JOIN')
   await f.repo.updateMembers(f.room.id,[],[f.a.id]);await f.repo.updateMembers(f.room.id,[f.a.id],[])
   await send(f,f.room,'AFTER_JOIN');await f.repo.setConversationMemorySources(f.dm.id,f.a.id,[f.room.id])
   const text=(await f.repo.linkedMemoryContext(f.dm.id,f.a.id)).text
   assert.match(text,/AFTER_JOIN/);assert.doesNotMatch(text,/BEFORE_JOIN/)
   await f.repo.setConversationMemorySources(f.dm.id,f.a.id,[]);assert.equal((await f.repo.linkedMemoryContext(f.dm.id,f.a.id)).text,'')
   assert.equal((await f.repo.allMessages(f.room.id)).length,2)
   await f.repo.setConversationMemorySources(f.dm.id,f.a.id,[f.room.id]);await f.repo.updateMembers(f.room.id,[],[f.a.id])
   assert.equal((await f.repo.linkedMemoryContext(f.dm.id,f.a.id)).text,'')
   assert.equal((await f.repo.conversationMemorySources(f.dm.id,f.a.id)).find(s=>s.id===f.room.id).available,false)
   await f.repo.deleteConversation(f.room.id);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM conversation_memory_links').get().n,0)
 })
 await check('source edits, memory changes and unlinks invalidate a running tool lease',async()=>{
   const f=await fixture(),msg=await send(f,f.room,'SOURCE')
   const memory=await f.repo.saveMemory({agentId:f.a.id,conversationId:f.room.id,body:'REMEMBER',origin:'human'})
   await f.repo.setConversationMemorySources(f.dm.id,f.a.id,[f.room.id]);const lease=await runLease(f)
   assert.equal(await guard(f,lease),true)
   await f.repo.saveMemory({...memory,body:'CORRECTED'})
   await assert.rejects(guard(f,lease),/关联记忆/)
   const current=await runLease(f);await f.repo.editMessage(msg.id,'EDITED_SOURCE')
   await assert.rejects(guard(f,current),/关联会话/)
   const last=await runLease(f);await f.repo.setConversationMemorySources(f.dm.id,f.a.id,[])
   await assert.rejects(guard(f,last),/失效/)
 })
 await check('regenerated branches start without links to future source events',async()=>{
   const f=await fixture();await send(f,f.dm,'question')
   const scope=await runLease(f),actor=await f.repo.getActor(f.a.id),room=await f.repo.getConversation(f.dm.id)
   const result=await f.runtime.executeTool({id:crypto.randomUUID(),name:'message_send',arguments:{body:'answer'}},{agent:actor,conversation:room,activityId:f.sql.prepare('SELECT activity_id FROM runs WHERE id=?').get(scope.runId).activity_id,runId:scope.runId,expectedEpoch:0,seenThrough:1,visibleThrough:1,input:[],openedConversationId:null,remainingPosts:1})
   assert.equal(result.posted,true)
   await send(f,f.room,'FUTURE_SOURCE');await f.repo.setConversationMemorySources(f.dm.id,f.a.id,[f.room.id])
   const reply=(await f.repo.allMessages(f.dm.id)).find(m=>m.authorKind==='agent'),branch=await f.repo.regenerateBranch(reply.id)
   assert.equal((await f.repo.conversationMemorySources(branch,f.a.id)).some(s=>s.linked),false)
   assert.doesNotMatch(JSON.stringify((await context(f,{id:branch})).input),/FUTURE_SOURCE/)
 })
 await check('full and modular backups keep timelines/links; legacy archives and additive migrations remain readable',async()=>{
   const f=await fixture();await send(f,f.room,'SOURCE')
   await f.repo.setConversationMemorySources(f.dm.id,f.a.id,[f.room.id])
   await f.repo.saveSummary({agentId:f.a.id,conversationId:f.room.id,contentRevision:1,throughSequence:1,startSequence:1,body:'ALL',segmentStartSequence:1,segmentBody:'DELTA'})
   const snapshot=await f.repo.exportBackup(),other=await fixture();await other.repo.importBackup(snapshot)
   assert.equal((await other.repo.summaryTimeline(f.room.id,f.a.id))[0].body,'DELTA')
   assert.equal((await other.repo.summaryTimeline(f.room.id,f.a.id))[0].valid,true)
   assert.match((await other.repo.linkedMemoryContext(f.dm.id,f.a.id)).text,/ALL/)
   const zip=await createBackupZip(snapshot,'test-password',['memories']),archive=await readBackupZip(zip,'test-password')
   assert.equal(archive.snapshot.conversationMemoryLinks.length,1)
   const merged=mergeBackupModules(await other.repo.exportBackup(),archive.snapshot,['memories']);await other.repo.importBackup(merged,true)
   assert.equal((await other.repo.summaryTimeline(f.room.id,f.a.id))[0].valid,false)
   assert.equal(other.sql.prepare('SELECT COUNT(*) n FROM conversation_memory_links').get().n,1)
   const {unzipSync,zipSync,strFromU8,strToU8}=require('fflate'),files=unzipSync(zip),payload=await decryptBackup(strFromU8(files['data/memories.yomi']),'test-password')
   delete payload.data.conversationMemoryLinks;files['data/memories.yomi']=strToU8(await encryptBackup(payload,'test-password'))
   assert.deepEqual((await readBackupZip(zipSync(files),'test-password')).snapshot.conversationMemoryLinks,[])
   const broken=structuredClone(snapshot);broken.conversationMemoryLinks[0].source_conversation_id='missing'
   await assert.rejects(other.repo.importBackup(broken));assert.equal(other.sql.prepare('SELECT COUNT(*) n FROM conversation_memory_links').get().n,1)
   f.sql.exec('ALTER TABLE summaries DROP COLUMN segment_start_sequence;ALTER TABLE summaries DROP COLUMN segment_body;DROP TABLE conversation_memory_links')
   await f.db.migrateExistingTables();await f.db.migrateExistingTables();f.sql.exec(schema)
   const old=(await f.repo.summaryTimeline(f.room.id,f.a.id))[0];assert.equal(old.kind,'cumulative');assert.equal(old.body,'ALL')
 })
 console.log(JSON.stringify({checks:passed.length,status:'passed',liveProviderCalls:0}))
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>databases.forEach(sql=>sql.close()))
