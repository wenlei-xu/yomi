// Focused local checks: no live provider calls, no user database access.
const {buildSync}=require('esbuild')
const {DatabaseSync}=require('node:sqlite')
const assert=require('node:assert/strict')
const path=require('node:path')
const root=path.resolve(__dirname,'..')
const code=buildSync({stdin:{contents:`
export {Repository} from './src/data/repository';export {Database} from './src/data/database';
export {schema} from './src/data/schema';export {AgentRuntime} from './src/agent/runtime';
export {parseCharacterCard,readPngCard} from './src/data/characterCard';
export {generateImage,generateSpeech} from './src/media/generate';
export {storeCredential} from './src/platform/secureTransport';`,resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text
const compiled={exports:{}}
new Function('require','module','exports',code)(require,compiled,compiled.exports)
const {Repository,Database,schema,AgentRuntime,parseCharacterCard,readPngCard,generateImage,generateSpeech,storeCredential}=compiled.exports
const timeout=setTimeout(()=>{console.error('Check timed out');process.exit(1)},15000)
const passed=[]
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jIh0AAAAASUVORK5CYII='
function fixture(){
  const sql=new DatabaseSync(':memory:');sql.exec(schema)
  const db=new Database();db.db={
    query:async(q,v=[])=>({values:sql.prepare(q).all(...v)}),run:async(q,v=[])=>sql.prepare(q).run(...v),
    execute:async(q)=>sql.exec(q),isTransactionActive:async()=>({result:false}),
    beginTransaction:async()=>sql.exec('BEGIN'),commitTransaction:async()=>sql.exec('COMMIT'),rollbackTransaction:async()=>sql.exec('ROLLBACK')
  }
  return {sql,db,repo:new Repository(db)}
}
async function check(name,fn){await fn();passed.push(name);console.log('PASS '+name)}
async function main(){
 const f=fixture();await f.repo.ensureLocalUser();const a=await f.repo.saveAgent({name:'甲'}),b=await f.repo.saveAgent({name:'乙'})
 const c=await f.repo.openDirect(a.id),d=await f.repo.openDirect(b.id)
 let book,cardActor,media,actorBook,actorGroup
 const raw={spec:'chara_card_v3',spec_version:'3.0',unknownRoot:{keep:true},data:{name:'测试角色',description:'设定 {{char}} 与 {{user}}',personality:'简洁',scenario:'山城',first_mes:'你好 {{user}}',alternate_greetings:['第二个开场'],creator:'作者',extensions:{custom:[1,2,3]},character_book:{name:'城',entries:[{keys:['钟塔'],content:'钟塔位于东门',enabled:true,unknown:{keep:true}}]}}}
 await check('worldbook CRUD resolves without a nested queue deadlock',async()=>{
   book=await f.repo.saveLorebook({title:'局部设定',scope:'conversation'})
   assert.equal(book.entryCount,0)
   const e=await f.repo.saveLorebookEntry({lorebookId:book.id,title:'夜城',content:'月亮是蓝色的',keywords:['夜城']})
   await f.repo.setConversationLorebooks(c.id,[book.id]);await f.repo.setConversationLorebooks(d.id,[book.id])
   assert.match(await f.repo.lorebookContext(c.id,a.id,'夜城'),/蓝色/)
   assert.match(await f.repo.lorebookContext(d.id,b.id,'夜城'),/蓝色/)
   await f.repo.setConversationLorebooks(d.id,[])
   assert.equal(await f.repo.lorebookContext(d.id,b.id,'夜城'),'')
   await f.repo.saveLorebookEntry({...e,content:'月亮是红色的'})
   assert.match(await f.repo.lorebookContext(c.id,a.id,'夜城'),/红色/)
 })
 await check('global/disabled/secondary/case matching and token budget',async()=>{
   const g=await f.repo.saveLorebook({title:'全局',scope:'global'})
   await f.repo.saveLorebookEntry({lorebookId:g.id,content:'GLOBAL',constant:true})
   const e=await f.repo.saveLorebookEntry({lorebookId:g.id,content:'SELECTIVE',keywords:['Moon'],secondaryKeywords:['Blue'],caseSensitive:true,selective:true})
   assert.doesNotMatch(await f.repo.lorebookContext(d.id,b.id,'moon Blue'),/SELECTIVE/)
   assert.match(await f.repo.lorebookContext(d.id,b.id,'Moon Blue'),/SELECTIVE/)
   assert.equal(await f.repo.lorebookContext(d.id,b.id,'Moon Blue',1),'')
   await f.repo.saveLorebookEntry({...e,enabled:false})
   assert.doesNotMatch(await f.repo.lorebookContext(d.id,b.id,'Moon Blue'),/SELECTIVE/)
   await f.repo.saveLorebook({...g,enabled:false})
 })
 await check('manual actor bindings apply across chats, isolate peers and update atomically',async()=>{
   actorBook=await f.repo.saveLorebook({title:'角色专属设定',scope:'conversation'})
   await f.repo.saveLorebookEntry({lorebookId:actorBook.id,content:'ROLE_SCOPED_SETTING',constant:true})
   const extra=await f.repo.saveLorebook({title:'第二卷',scope:'conversation'})
   await f.repo.saveLorebookEntry({lorebookId:extra.id,content:'SECOND_ROLE_SETTING',constant:true})
   const version=(await f.repo.getActor(a.id)).profileVersion
   await f.repo.setActorLorebooks(a.id,[actorBook.id,extra.id,actorBook.id])
   assert.equal((await f.repo.actorLorebooks(a.id)).length,2)
   assert.equal((await f.repo.getActor(a.id)).profileVersion,version+1)
   await f.repo.setActorLorebooks(a.id,[extra.id,actorBook.id])
   assert.equal((await f.repo.getActor(a.id)).profileVersion,version+1)
   await assert.rejects(f.repo.setActorLorebooks(a.id,[extra.id,'missing-book']),/已被删除/)
   await assert.rejects(f.repo.setActorLorebooks('local-user',[actorBook.id]),/角色不存在/)
   await assert.rejects(f.repo.setActorLorebooks('missing-actor',[]),/角色不存在/)
   assert.equal((await f.repo.actorLorebooks(a.id)).length,2)
   assert.equal((await f.repo.getActor(a.id)).profileVersion,version+1)
   actorGroup=await f.repo.createGroup('世界书隔离',[a.id,b.id])
   const runtime=new AgentRuntime(f.repo,async()=>[],async()=>[])
   const context=async role=>runtime.buildContext(await f.repo.getActor(role.id),await f.repo.getConversation(actorGroup.id),0,{contextTokens:16000,outputTokens:1000})
   assert.match(await f.repo.lorebookContext(c.id,a.id,''),/ROLE_SCOPED_SETTING/)
   assert.match((await context(a)).lorebookText,/ROLE_SCOPED_SETTING/)
   assert.doesNotMatch((await context(b)).lorebookText,/ROLE_SCOPED_SETTING/)
   const copied=await f.repo.copyAgent(a.id)
   assert.equal((await f.repo.actorLorebooks(copied.id)).length,2)
   await f.repo.setActorLorebooks(b.id,[actorBook.id])
   await f.repo.saveLorebook({...actorBook,enabled:false})
   assert.doesNotMatch((await context(a)).lorebookText,/ROLE_SCOPED_SETTING/)
   assert.equal((await f.repo.actorLorebooks(a.id)).length,2)
   await f.repo.saveLorebook({...actorBook,enabled:true})
   await f.repo.setActorLorebooks(a.id,[])
   assert.doesNotMatch((await context(a)).lorebookText,/ROLE_SCOPED_SETTING/)
   assert.match((await context(b)).lorebookText,/ROLE_SCOPED_SETTING/)
   assert.equal((await f.repo.listLorebooks()).some(v=>v.id===actorBook.id),true)
   await f.repo.setActorLorebooks(a.id,[actorBook.id])
   await f.repo.setConversationLorebooks(actorGroup.id,[actorBook.id])
   assert.equal((await context(a)).lorebookText.match(/ROLE_SCOPED_SETTING/g).length,1)
   await f.repo.setConversationLorebooks(actorGroup.id,[])
 })
 await check('V1/V2/V3 character fields and unknown data survive import/copy',async()=>{
   assert.equal(parseCharacterCard(JSON.stringify({name:'V1',description:'原设定'})).profile.persona,'原设定')
   assert.equal(parseCharacterCard(JSON.stringify({...raw,spec:'chara_card_v2'})).profile.name,'测试角色')
   cardActor=await f.repo.importCharacter(parseCharacterCard(JSON.stringify(raw)))
   assert.deepEqual(JSON.parse((await f.repo.characterSource(cardActor.id)).json),raw)
   const copy=await f.repo.copyAgent(cardActor.id)
   assert.deepEqual(JSON.parse((await f.repo.characterSource(copy.id)).json),raw)
   assert.match(await f.repo.lorebookContext(c.id,cardActor.id,'钟塔'),/东门/)
   assert.doesNotMatch(await f.repo.lorebookContext(c.id,a.id,'钟塔'),/东门/)
 })
 await check('PNG standard base64 Unicode metadata prefers CCv3; rejects truncation',async()=>{
   const chunk=(name,text)=>{const payload=Buffer.from(name+'\0'+Buffer.from(text).toString('base64'));const l=Buffer.alloc(4);l.writeUInt32BE(payload.length);return Buffer.concat([l,Buffer.from('tEXt'),payload,Buffer.alloc(4)])}
   const image=Buffer.from(png,'base64');const inserted=Buffer.concat([image.subarray(0,-12),chunk('chara',JSON.stringify({name:'旧版'})),chunk('ccv3',JSON.stringify(raw)),image.subarray(-12)])
   assert.deepEqual(JSON.parse(readPngCard(Uint8Array.from(inserted).buffer)),raw)
   assert.throws(()=>readPngCard(Uint8Array.from(inserted.subarray(0,-4)).buffer),/截断|结束/)
 })
 await check('card import is atomic when an embedded book fails',async()=>{
   const count=(await f.repo.listActors()).length
   const card=parseCharacterCard(JSON.stringify(raw));card.book.entries[0].content=''
   await assert.rejects(f.repo.importCharacter(card))
   assert.equal((await f.repo.listActors()).length,count)
 })
 await check('greeting selection preserves alternates and substitutes macros',async()=>{
   const room=await f.repo.openDirect(cardActor.id)
   const greetings=await f.repo.greetings(cardActor.id);assert.equal(greetings.length,2);assert.equal(greetings[0],'你好 我')
   await f.repo.startGreeting(room.id,greetings[1]);assert.equal((await f.repo.allMessages(room.id))[0].body,'第二个开场')
   await assert.rejects(f.repo.startGreeting(room.id,greetings[0]))
 })
 await check('sticker sends use immutable media snapshots and appear in history',async()=>{
   const sticker=await f.repo.saveSticker('开心','data:image/png;base64,'+png)
   media=await f.repo.stickerAsset(sticker.id)
   const m=await f.repo.sendUserMessage(c.id,'【开心】','send-sticker',null,[],media.id)
   assert.equal((await f.repo.messageById(m.id)).mediaId,media.id)
   const snapshot=await f.repo.sendSticker(c.id,sticker.id,'snapshot-command')
   const assetCount=f.sql.prepare('SELECT COUNT(*) n FROM media_assets').get().n
   assert.equal((await f.repo.sendSticker(c.id,sticker.id,'snapshot-command')).id,snapshot.id)
   assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM media_assets').get().n,assetCount)
   await f.repo.deleteSticker(sticker.id)
   assert.equal(await f.repo.mediaData(media.id),'data:image/png;base64,'+png)
   await assert.rejects(f.repo.deleteMediaAsset(media.id),/引用/)
   const replay=await f.repo.sendUserMessage(c.id,'【开心】','send-sticker',null,[],media.id)
   assert.equal(replay.id,m.id)
 })
 await check('worldbook context does not leak a future message',async()=>{
   const future=await f.repo.saveLorebookEntry({lorebookId:book.id,content:'SECRET_FUTURE_SETTING',keywords:['FUTURE']})
   const m=await f.repo.sendUserMessage(c.id,'CURRENT','current')
   await f.repo.sendUserMessage(c.id,'FUTURE','future')
   const runtime=new AgentRuntime(f.repo,async()=>[],async()=>[])
   const ctx=await runtime.buildContext(a,await f.repo.getConversation(c.id),m.sequence,{contextTokens:16000,outputTokens:1000},m.id)
   assert.doesNotMatch(ctx.lorebookText,/SECRET_FUTURE_SETTING/)
   await f.repo.deleteLorebookEntry(future.id)
 })
 await check('additive migration preserves messages from the earlier schema',async()=>{
   const old=fixture();await old.repo.ensureLocalUser()
   const role=await old.repo.saveAgent({name:'旧角色'}),room=await old.repo.openDirect(role.id)
   const msg=await old.repo.sendUserMessage(room.id,'旧消息','old')
   old.sql.exec('ALTER TABLE messages DROP COLUMN media_id')
   for(const col of ['secondary_keywords','selective','case_sensitive','source_json']) old.sql.exec('ALTER TABLE lorebook_entries DROP COLUMN '+col)
   await old.db.migrateExistingTables()
   assert.equal((await old.repo.messageById(msg.id)).body,'旧消息')
   assert.equal((await old.repo.messageById(msg.id)).mediaId,null)
   old.sql.close()
 })
 await check('media configuration and complete backup restore preserve cards, worlds and blobs',async()=>{
   await f.repo.saveMediaSettings({imageProviderId:'image-provider',imageModel:'image-model',speechProviderId:'speech-provider',speechModel:'speech-model',voice:'alloy'})
   const backup=await f.repo.exportBackup(),other=fixture()
   await other.repo.importBackup(backup)
   assert.deepEqual(JSON.parse((await other.repo.characterSource(cardActor.id)).json),raw)
   assert.equal(await other.repo.mediaData(media.id),'data:image/png;base64,'+png)
   assert.equal((await other.repo.mediaSettings()).imageModel,'image-model')
   assert.match(await other.repo.lorebookContext(c.id,a.id,'夜城'),/红色/)
   assert.deepEqual((await other.repo.actorLorebooks(a.id)).map(v=>v.id),[actorBook.id])
   assert.match(await other.repo.lorebookContext(actorGroup.id,b.id,''),/ROLE_SCOPED_SETTING/)
   assert.equal(other.sql.prepare('PRAGMA foreign_key_check').all().length,0)
   other.sql.close()
 })
 await check('image and binary speech responses use selected model and remain playable bytes',async()=>{
   const provider={id:'test',baseUrl:'https://media.invalid/v1'}
   await storeCredential('test','test-only','https://media.invalid')
   const previous=global.fetch
   global.fetch=async(url,options)=>{
     const body=JSON.parse(options.body)
     if(String(url).endsWith('/images/generations')){assert.equal(body.model,'image-model');return new Response(JSON.stringify({data:[{b64_json:png}]}))}
     assert.equal(body.model,'speech-model');return new Response(new Uint8Array([255,251,65,66]),{headers:{'Content-Type':'audio/mpeg'}})
   }
   try {
     const image=await generateImage(provider,'image-model','test',new AbortController().signal)
     assert.equal(image.dataUrl,'data:image/png;base64,'+png)
     const audio=await generateSpeech(provider,'speech-model','你好','alloy',new AbortController().signal)
     assert.deepEqual(Buffer.from(audio.dataUrl.split(',')[1],'base64'),Buffer.from([255,251,65,66]))
     await assert.rejects(generateSpeech(provider,'speech-model','x'.repeat(4097),'alloy',new AbortController().signal),/4096/)
   } finally {global.fetch=previous}
 })
 f.sql.close();clearTimeout(timeout)
 console.log(JSON.stringify({checks:passed.length,status:'passed',liveProviderCalls:0},null,2))
}
main().catch(e=>{clearTimeout(timeout);console.error(e);process.exitCode=1})
