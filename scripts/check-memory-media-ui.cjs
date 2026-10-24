// Isolated memory/media fixtures only. Never reads the user's database, providers, or chats.
const { build } = require('esbuild')
const { chromium } = require(process.env.YOMI_PLAYWRIGHT || 'playwright')
const assert = require('node:assert/strict')
const http = require('node:http')

const fixture = `
const now=Date.now();
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9E0AAAAASUVORK5CYII=';
const audio='data:audio/mpeg;base64,SUQzAwAAAAAAFlRFTkMAAAAMAAADU0RUQw==';
const user={id:'local-user',kind:'human',name:'我',color:'#46a6d9',bio:'',persona:'',speakingStyle:'',avatarData:'',enabled:true,archived:false,profileVersion:1,allowPrivate:true,allowGroup:true,createdAt:now,updatedAt:now};
const agent={id:'agent-1',kind:'agent',name:'Alpha',color:'#238672',bio:'日常朋友',persona:'',speakingStyle:'',avatarData:'',enabled:true,archived:false,profileVersion:1,allowPrivate:true,allowGroup:true,createdAt:now,updatedAt:now};
const room={id:'room',kind:'direct',title:'Alpha',topic:'',members:['local-user','agent-1'],memberNames:['我','Alpha'],originConversationId:null,pinned:false,muted:false,hidden:false,paused:false,autonomyPaused:false,nextSequence:2,contentRevision:1,membershipVersion:1,cancelEpoch:0,createdAt:now,updatedAt:now,lastMessage:'你好',unread:0};
const source={id:'source-room',title:'周末群',kind:'group',linked:false,available:true};
let memories=[
  {id:'m-global',agentId:'agent-1',conversationId:null,body:'她不喜欢临时改变计划',kind:'fact',about:'',pinned:true,origin:'human',createdAt:now,updatedAt:now},
  {id:'m-room',agentId:'agent-1',conversationId:'room',body:'周末约好一起看海',kind:'event',about:'',pinned:false,origin:'agent',createdAt:now,updatedAt:now}
];
let assets=[
  {id:'image-ready',kind:'image',ownerActorId:'agent-1',conversationId:null,messageId:null,providerId:'image',modelId:'image-model',prompt:'傍晚的海边',status:'ready',error:'',bytes:68,mimeType:'image/png',width:1,height:1,durationMs:0,transcript:'',voice:'',createdAt:now},
  {id:'audio-ready',kind:'audio',ownerActorId:'agent-1',conversationId:null,messageId:null,providerId:'speech',modelId:'speech-model',prompt:'晚安',status:'ready',error:'',bytes:32,mimeType:'audio/mpeg',width:0,height:0,durationMs:900,transcript:'',voice:'alloy',createdAt:now},
  {id:'image-failed',kind:'image',ownerActorId:'agent-1',conversationId:null,messageId:null,providerId:'image',modelId:'image-model',prompt:'一张失败的图片',status:'failed',error:'图片生成失败',bytes:0,mimeType:'',width:0,height:0,durationMs:0,transcript:'',voice:'',createdAt:now}
];
let update;window.calls=[];window.failSend=false;
const api={
  actors:async()=>[user,agent],conversations:async()=>[room],whispers:async()=>[],runtimeIssues:async()=>[],
  conversation:async()=>({...room}),messages:async()=>[],message:async()=>null,messagesAround:async()=>({messages:[],hasOlder:false,hasNewer:false}),
  draft:async()=>({body:'',quotedId:null}),saveDraft:async()=>{},markRead:async()=>{},mediaSettings:async()=>({voice:'alloy'}),
  runtime:{snapshot:()=>({running:[],waiting:[],streaming:[]}),setForeground:()=>{}},cancelMedia:()=>{},
  memories:async()=>memories.map(memory=>({...memory})),
  saveMemory:async input=>{const saved={...input,id:input.id||'m-'+(memories.length+1),kind:input.kind||'fact',about:input.about||'',createdAt:now,updatedAt:now};memories=memories.some(m=>m.id===saved.id)?memories.map(m=>m.id===saved.id?saved:m):[saved,...memories];update();return saved},
  deleteMemory:async id=>{window.calls.push(['delete-memory',id]);memories=memories.filter(m=>m.id!==id);update()},
  moveMemoryScope:async(id,conversationId)=>{window.calls.push(['move-memory',id,conversationId]);memories=memories.map(m=>m.id===id?{...m,conversationId}:m);update()},
  summaryTimeline:async()=>[
    {id:'summary-1',startSequence:1,throughSequence:40,body:'两人聊了工作和晚饭。',kind:'segment',cumulativeBody:'较早的累计摘要。',cumulativeStartSequence:1,createdAt:now,valid:true},
    {id:'summary-2',startSequence:41,throughSequence:60,body:'周末约定看海。',kind:'cumulative',cumulativeBody:'周末约定看海。',cumulativeStartSequence:1,createdAt:now,valid:false}
  ],
  conversationMemorySources:async()=>[{...source,linked:true}],setConversationMemorySources:async(id,agentId,ids)=>{window.calls.push(['sources',id,agentId,ids])},
  mediaAssets:async filter=>assets.filter(asset=>!filter||((!filter.kind||asset.kind===filter.kind)&&(!filter.ownerActorId||asset.ownerActorId===filter.ownerActorId)&&(!filter.messageId||asset.messageId===filter.messageId))).map(asset=>({...asset})),
  mediaData:async id=>id==='image-ready'?png:id==='audio-ready'?audio:null,
  deleteMediaAsset:async id=>{window.calls.push(['delete-media',id]);assets=assets.filter(asset=>asset.id!==id);update()},
  generateAgentImage:async(agentId,prompt)=>{window.calls.push(['generate-image',agentId,prompt]);return {id:'generated',kind:'image',ownerActorId:agentId,conversationId:null,messageId:null,providerId:'image',modelId:'image-model',prompt,status:'failed',error:'模拟生成失败',bytes:0,mimeType:'',width:0,height:0,durationMs:0,transcript:'',voice:'',createdAt:now}},
  generateAgentVoice:async(agentId,text,voice)=>{window.calls.push(['generate-audio',agentId,text,voice]);return {id:'generated',kind:'audio',ownerActorId:agentId,conversationId:null,messageId:null,providerId:'speech',modelId:'speech-model',prompt:text,status:'failed',error:'模拟生成失败',bytes:0,mimeType:'',width:0,height:0,durationMs:0,transcript:'',voice,createdAt:now}},
  sendMedia:async(conversationId,id,command)=>{window.calls.push(['send-media',conversationId,id,command]);if(window.failSend){window.failSend=false;throw Error('模拟发送失败')}},
  greetings:async()=>[],startGreeting:async()=>{},
  providers:async()=>[],bindings:async()=>[],providerChannelKinds:async()=>({}),providerModelSelections:async()=>({})
};
export async function createApp(cb){update=cb;return api}
`

async function main() {
  const result = await build({
    entryPoints: ['src/main.tsx'], bundle: true, write: false, outdir: 'fixture', format: 'iife',
    plugins: [{ name: 'fixture', setup(build) {
      build.onResolve({ filter: /app\/bootstrap$/ }, () => ({ path: 'bootstrap', namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: fixture, loader: 'js' }))
    } }]
  })
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).contents
  const css = result.outputFiles.find(file => file.path.endsWith('.css')).contents
  const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js) }
    else if (req.url === '/app.css') { res.setHeader('Content-Type', 'text/css'); res.end(css) }
    else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    let acceptDialog = true
    page.on('dialog', dialog => acceptDialog ? dialog.accept() : dialog.dismiss())
    await page.goto('http://127.0.0.1:' + server.address().port)

    await page.getByRole('button', { name: '角色', exact: true }).click()
    await page.getByRole('button', { name: '管理角色 Alpha', exact: true }).click()
    await page.getByRole('button', { name: '管理记忆', exact: true }).click()
    const memorySheet = page.locator('.sheet.tall').filter({ hasText: 'Alpha 的记忆' })
    await memorySheet.waitFor()
    assert.equal(await memorySheet.locator('.memory-card').count(), 2)
    assert.equal(await memorySheet.locator('.memory-card.pinned').count(), 1)
    await memorySheet.getByRole('button', { name: '会话', exact: true }).click()
    assert.equal(await memorySheet.locator('.memory-card').count(), 1)
    assert.match(await memorySheet.locator('.memory-card').textContent(), /Alpha/)
    await memorySheet.getByRole('button', { name: '全部 2', exact: true }).click()
    await memorySheet.locator('textarea').first().fill('新的全局记忆')
    await memorySheet.getByRole('button', { name: '添加记忆', exact: true }).click()
    await page.waitForFunction(() => window.calls.length >= 0)
    assert.equal(await memorySheet.locator('.memory-card').count(), 3)
    const newCard = memorySheet.locator('.memory-card').filter({ hasText: '新的全局记忆' })
    await newCard.getByRole('button', { name: '置顶', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.memory-card.pinned').length === 2)
    await newCard.getByRole('button', { name: '编辑', exact: true }).click()
    const editMemory = memorySheet.locator('.edit-memory')
    await editMemory.locator('textarea').fill('修改后的全局记忆')
    await editMemory.getByRole('button', { name: '保存修改', exact: true }).click()
    await memorySheet.getByText('修改后的全局记忆', { exact: true }).waitFor()
    const editedCard = memorySheet.locator('.memory-card').filter({ hasText: '修改后的全局记忆' })
    await editedCard.getByRole('button', { name: '限定会话', exact: true }).click()
    await memorySheet.locator('.memory-scope-picker').getByRole('button', { name: /Alpha/ }).click()
    await page.waitForFunction(() => window.calls.some(call => call[0] === 'move-memory'))
    acceptDialog = false
    await memorySheet.locator('.memory-card').first().getByRole('button', { name: '删除', exact: true }).click()
    assert.equal(await page.evaluate(() => window.calls.some(call => call[0] === 'delete-memory')), false)
    acceptDialog = true
    await memorySheet.locator('.memory-card').first().getByRole('button', { name: '删除', exact: true }).click()
    await page.waitForFunction(() => window.calls.some(call => call[0] === 'delete-memory'))
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 })
      assert.equal(await memorySheet.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'memory overflow at ' + width)
    }
    if (process.env.YOMI_MEMORY_SCREENSHOT) await memorySheet.screenshot({ path: process.env.YOMI_MEMORY_SCREENSHOT })
    await memorySheet.getByRole('button').first().click()
    await memorySheet.waitFor({ state: 'detached' })
    console.log('PASS memory add/edit/pin/scope/delete confirmation, conversation labels, semantic actions and responsive layout')

    await page.getByRole('button', { name: '管理角色 Alpha', exact: true }).click()
    await page.getByRole('button', { name: '图片、语音与表情', exact: true }).click()
    const mediaSheet = page.locator('.sheet.tall').filter({ hasText: 'Alpha · 多媒体' })
    await mediaSheet.waitFor()
    assert.equal(await mediaSheet.getByRole('tab').count(), 2)
    assert.equal(await mediaSheet.locator('.media-card').count(), 2)
    assert.equal(await mediaSheet.getByRole('button', { name: '发送到聊天', exact: true }).count(), 0)
    await mediaSheet.getByRole('tab', { name: '语音', exact: true }).click()
    assert.equal(await mediaSheet.locator('.media-card').count(), 1)
    await mediaSheet.getByLabel('朗读文字').fill('晚安')
    await mediaSheet.getByRole('button', { name: '生成语音', exact: true }).click()
    await page.waitForFunction(() => window.calls.some(call => call[0] === 'generate-audio'))
    await page.getByText('模拟生成失败', { exact: true }).waitFor()
    await mediaSheet.getByRole('tab', { name: '图片', exact: true }).click()
    await mediaSheet.getByLabel('画面描述').fill('新的海边画面')
    await mediaSheet.getByRole('button', { name: '生成图片', exact: true }).click()
    await page.waitForFunction(() => window.calls.some(call => call[0] === 'generate-image'))
    acceptDialog = false
    await mediaSheet.locator('.media-card').filter({ hasText: '傍晚的海边' }).getByRole('button', { name: '删除', exact: true }).click()
    assert.equal(await page.evaluate(() => window.calls.some(call => call[0] === 'delete-media')), false)
    acceptDialog = true
    await mediaSheet.locator('.media-card').filter({ hasText: '傍晚的海边' }).getByRole('button', { name: '删除', exact: true }).click()
    await page.waitForFunction(() => window.calls.some(call => call[0] === 'delete-media'))
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 })
      assert.equal(await mediaSheet.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'media overflow at ' + width)
    }
    if (process.env.YOMI_MEDIA_SCREENSHOT) await mediaSheet.screenshot({ path: process.env.YOMI_MEDIA_SCREENSHOT })
    await mediaSheet.getByRole('button').first().click()
    await mediaSheet.waitFor({ state: 'detached' })
    console.log('PASS media image/audio tabs, generation errors, delete confirmation, empty/send states and responsive layout')

    await page.locator('.mobile-tabbar').getByRole('button', { name: '消息', exact: true }).click()
    await page.locator('.conversation-row').click()
    await page.locator('.chat').waitFor()
    const mediaTool = page.locator('.composer-tool[aria-label="图片与语音"]')
    await mediaTool.waitFor()
    await mediaTool.click()
    const chatMedia = page.locator('.sheet.tall').filter({ hasText: 'Alpha · 多媒体' })
    await chatMedia.waitFor()
    assert.equal(await chatMedia.getByRole('button', { name: '发送到聊天', exact: true }).count(), 0)
    await chatMedia.getByRole('tab', { name: '语音', exact: true }).click()
    assert.equal(await chatMedia.getByRole('button', { name: '发送到聊天', exact: true }).count(), 1)
    await page.evaluate(() => { window.failSend = true })
    await chatMedia.getByRole('button', { name: '发送到聊天', exact: true }).click()
    await page.getByText('模拟发送失败', { exact: true }).waitFor()
    await chatMedia.getByRole('button', { name: '发送到聊天', exact: true }).click()
    await page.waitForFunction(() => window.calls.filter(call => call[0] === 'send-media').length === 2)
    const sends = await page.evaluate(() => window.calls.filter(call => call[0] === 'send-media'))
    assert.equal(sends[0][3], sends[1][3])
    console.log('PASS chat media send failure retains the same idempotency key for retry')
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
