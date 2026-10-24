// Isolated UI fixtures only. Never reads the user's database or providers.
const { build } = require('esbuild')
const { chromium } = require(process.env.YOMI_PLAYWRIGHT || 'playwright')
const assert = require('node:assert/strict')
const http = require('node:http')

const fixture = `
const now=Date.now();
const user={id:'local-user',kind:'human',name:'Me',color:'#46a6d9',bio:'',persona:'',speakingStyle:'',avatarData:'',enabled:true,archived:false,profileVersion:1,allowPrivate:true,allowGroup:true,createdAt:now,updatedAt:now};
let agent={id:'agent-1',kind:'agent',name:'Alpha',color:'#238672',bio:'Everyday friend',persona:'Calm and curious',speakingStyle:'Short sentences',avatarData:'',enabled:true,archived:false,profileVersion:1,allowPrivate:true,allowGroup:true,createdAt:now,updatedAt:now};
let update;window.calls=[];
export async function createApp(cb){update=cb;return {
actors:async()=>[user,{...agent}],conversations:async()=>[],whispers:async()=>[],runtimeIssues:async()=>[],
providers:async()=>[],bindings:async()=>[],providerChannelKinds:async()=>({}),providerModelSelections:async()=>({}),memories:async()=>[],
saveAgent:async input=>{agent={...agent,...input};update();return {...agent}},setAgentStatus:async(id,status)=>{window.calls.push(['status',id,status]);agent={...agent,enabled:status==='active',archived:status==='archived'};update();return {...agent}},
copyAgent:async()=>agent,exportAgent:async()=> 'agent.json',deleteAgent:async()=>{},lorebooks:async()=>[],actorLorebooks:async()=>[],characterSource:async()=>null,
conversation:async()=>({}),messages:async()=>[],message:async()=>null,messagesAround:async()=>({messages:[],hasOlder:false,hasNewer:false}),draft:async()=>({body:'',quotedId:null}),saveDraft:async()=>{},markRead:async()=>{},mediaSettings:async()=>({}),mediaAssets:async()=>[],
runtime:{snapshot:()=>({running:[],waiting:[],streaming:[]}),setForeground:()=>{}},cancelMedia:()=>{}
}}
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
    page.on('dialog', dialog => dialog.accept())
    await page.goto('http://127.0.0.1:' + server.address().port)
    await page.waitForTimeout(800)
    if (errors.length) throw new Error(errors.join('\n'))
    await page.getByRole('button', { name: '角色', exact: true }).click()
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: /编辑角色 Alpha/ }).click()
    await page.waitForTimeout(300)
    const dialog = page.locator('.agent-editor')
    await dialog.waitFor()

    assert.deepEqual(await dialog.locator('.agent-editor-tabs button').allTextContents(), ['资料', '互动', '模型', '世界书', '状态'])
    assert.equal(await dialog.getByLabel('角色名称').count(), 1)
    assert.equal(await dialog.getByRole('button', { name: '更换角色头像', exact: true }).count(), 1)
    await dialog.locator('.agent-editor-tabs').getByRole('button', { name: '互动', exact: true }).click()
    assert.equal(await dialog.getByText('允许主动与其他角色私聊', { exact: true }).count(), 1)
    await dialog.locator('.agent-editor-tabs').getByRole('button', { name: '模型', exact: true }).click()
    assert.match(await dialog.textContent(), /对话模型/)
    await dialog.locator('.agent-editor-tabs').getByRole('button', { name: '世界书', exact: true }).click()
    assert.equal(await dialog.locator('summary').filter({ hasText: '角色世界书' }).count(), 1)
    await dialog.locator('.agent-editor-tabs').getByRole('button', { name: '状态', exact: true }).click()
    assert.equal(await dialog.getByRole('button', { name: '保存修改', exact: true }).count(), 0)
    await dialog.getByRole('button', { name: '停用角色', exact: true }).click()
    await page.waitForFunction(() => window.calls.some(call => call[0] === 'status' && call[2] === 'disabled'))
    assert.deepEqual(errors, [])
    console.log('PASS character editor separates profile, behavior, models, worldbook and lifecycle without hiding avatar or status actions')
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
