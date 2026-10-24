// Isolated settings fixtures. Never reads the user's database, providers, or chats.
const { build } = require('esbuild')
const { chromium } = require(process.env.YOMI_PLAYWRIGHT || 'playwright')
const assert = require('node:assert/strict')
const http = require('node:http')

const fixture = `
import { storeCredential, copyCredential, credentialStatus } from '${process.cwd().replace(/\\/g, '/')}/src/platform/secureTransport';
const now=Date.now();
let providers=[
  {id:'text-1',name:'DeepSeek',protocol:'chat-completions',baseUrl:'https://api.deepseek.com',credentialRef:'',credentialState:'stored',enabled:true,configVersion:1,createdAt:now,updatedAt:now},
  {id:'image-1',name:'Image Lab',protocol:'chat-completions',baseUrl:'https://images.example.com/v1',credentialRef:'',credentialState:'missing',enabled:true,configVersion:1,createdAt:now,updatedAt:now}
];
let books=[
  {id:'book-1',title:'雾港市设定',description:'海边城市的日常与传闻',scope:'conversation',conversationId:null,enabled:true,entryCount:2,createdAt:now,updatedAt:now},
  {id:'book-2',title:'共同回忆',description:'角色共同记得的旧事',scope:'global',conversationId:null,enabled:false,entryCount:1,createdAt:now,updatedAt:now}
];
let entries=[
  {id:'entry-1',lorebookId:'book-1',title:'潮汐广播',content:'每天傍晚六点，旧港会响起广播。',keywords:['广播','旧港'],enabled:true,constant:false,secondaryKeywords:[],selective:false,caseSensitive:false,ordinal:1,sourceJson:'',createdAt:now,updatedAt:now},
  {id:'entry-2',lorebookId:'book-1',title:'城市天气',content:'雾港常年潮湿，夜里会起海雾。',keywords:[],enabled:true,constant:true,secondaryKeywords:[],selective:false,caseSensitive:false,ordinal:2,sourceJson:'',createdAt:now,updatedAt:now}
];
const user={id:'local-user',kind:'human',name:'我',color:'#46a6d9',bio:'本地优先的对话空间',persona:'',speakingStyle:'',avatarData:'',enabled:true,archived:false,profileVersion:1,allowPrivate:true,allowGroup:true,createdAt:now,updatedAt:now};
let savedProfile={name:user.name,bio:user.bio,avatarData:user.avatarData};window.profile=()=>({...savedProfile});
let bindings=[
  {id:'bind-main',providerId:'text-1',modelId:'deepseek-chat',contextTokens:32768,outputTokens:2048,purpose:'main',revision:1},
  {id:'bind-summary',providerId:'text-1',modelId:'deepseek-chat',contextTokens:32768,outputTokens:1800,purpose:'summary',revision:1}
];
const selectedModels={'text-1':['deepseek-chat','deepseek-reasoner'],'image-1':['image-model']};
const providerKinds={'text-1':'text','image-1':'image'};
let media={imageProviderId:'image-1',imageModel:'image-model',speechProviderId:'',speechModel:'',voice:'alloy'};
window.rejectNextBinding=false;
window.modelFixture=()=>({providers,selectedModels,providerKinds,bindings,media});
const runtime={snapshot:()=>({running:[],waiting:[],streaming:[]}),setForeground:()=>{},backgroundActive:()=>false};
export async function createApp(onChange=()=>{}){
  await storeCredential('text-1','fixture-existing','https://api.deepseek.com');
  return {
  runtime,backgroundSupported:()=>false,setBackgroundEnabled:async()=>{},localUser:async()=>user,actors:async()=>[user],
  saveUserProfile:async(name,bio,avatarData)=>{savedProfile={name,bio,avatarData};user.name=name;user.bio=bio;user.avatarData=avatarData},
  providers:async()=>providers,bindings:async()=>bindings,secureVaultStatus:async()=>false,
  conversations:async()=>[],whispers:async()=>[],runtimeIssues:async()=>[],usage:async()=>[],
  dataRecovery:async()=>({note:'',canRollback:false}),usageSummary:async()=>({calls:0,inputTokens:0,outputTokens:0,unknownCalls:0,purposes:[]}),
  storageStats:async()=>({bytes:0,freeBytes:0,messages:0,agents:0,conversations:0,memories:0,logs:0,media:0,lorebooks:2}),
  mediaSettings:async()=>({...media}),
  providerModelSelections:async()=>({...selectedModels}),providerChannelKinds:async()=>({...providerKinds}),
  saveProviderModelSelection:async(id,models)=>{selectedModels[id]=[...models];onChange()},
  saveProviderChannelKind:async(id,kind)=>{providerKinds[id]=kind;onChange()},
  saveProvider:async(p,secret,source)=>{
    if(source) await copyCredential(source,p.id,new URL(p.baseUrl).origin);
    const saved={...p,credentialState:await credentialStatus(p.id)?'stored':'missing'};
    providers=[...providers.filter(item=>item.id!==p.id),saved];onChange();return saved;
  },
  deleteProvider:async id=>{providers=providers.filter(p=>p.id!==id);delete selectedModels[id];delete providerKinds[id];onChange()},
  saveBinding:async b=>{
    if(window.rejectNextBinding){window.rejectNextBinding=false;throw new Error('模拟保存失败')}
    bindings=[...bindings.filter(item=>item.purpose!==b.purpose),b];onChange()
  },saveMediaSettings:async value=>{media={...value};onChange()},
  testProviderConnection:async()=>'连接成功 · 128 ms',listProviderModels:async()=>[],testProvider:async()=>'',testMediaProvider:async()=>({}),
  stickerRecognitionSettings:async()=>({enabled:false,providerId:'',modelId:'',consentedOrigin:'',revision:0}),
  saveStickerRecognitionSettings:async value=>value,stickers:async()=>[],retryStickerRecognition:async()=>{},
  lorebooks:async()=>books.map(book=>({...book})),lorebookEntries:async id=>entries.filter(entry=>entry.lorebookId===id).map(entry=>({...entry})),
  saveLorebook:async input=>{const saved={...books.find(book=>book.id===input.id),...input,id:input.id||'book-'+(books.length+1),entryCount:books.find(book=>book.id===input.id)?.entryCount||0,createdAt:now,updatedAt:now};books=books.some(book=>book.id===saved.id)?books.map(book=>book.id===saved.id?saved:book):[...books,saved];return {...saved}},
  deleteLorebook:async id=>{books=books.filter(book=>book.id!==id)},saveLorebookEntry:async input=>{const saved={...input,id:input.id||'entry-'+(entries.length+1),createdAt:now,updatedAt:now};entries=entries.some(entry=>entry.id===saved.id)?entries.map(entry=>entry.id===saved.id?saved:entry):[...entries,saved];return saved},
  deleteLorebookEntry:async id=>{entries=entries.filter(entry=>entry.id!==id)},importWorldBook:async()=>books[0],exportWorldBook:async()=> 'worldbook.json',
  setConversationLorebooks:async()=>{},setActorLorebooks:async()=>{},actorLorebooks:async()=>[],conversationLorebooks:async()=>[],
  cancelMedia:()=>{},stop:()=>{},stopAll:()=>{},resume:()=>{},retry:()=>{},ignoreRecovery:()=>{}
}}
`

async function main() {
  const result = await build({
    entryPoints: ['src/main.tsx'], bundle: true, write: false, outdir: 'fixture', format: 'iife',
    plugins: [{ name: 'fixture', setup(build) {
      build.onResolve({ filter: /app\/bootstrap$/ }, () => ({ path: 'bootstrap', namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: fixture, loader: 'js', resolveDir: process.cwd() }))
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
    const requests = []
    let apiStatus = 200
    await page.route('https://api.example.com/**', route => {
      const request = route.request()
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204,
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } })
      requests.push({ url: request.url(), authenticated: request.headers().authorization === 'Bearer fixture-key' })
      return route.fulfill({ status: apiStatus, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ data: [{ id: 'alpha-model' }, { id: 'beta-model' }] }) })
    })
    page.on('pageerror', error => errors.push(error.message))
    let dismissNextDialog = false
    page.on('dialog', dialog => {
      const dismiss = dismissNextDialog
      dismissNextDialog = false
      return dismiss ? dialog.dismiss() : dialog.accept()
    })
    await page.goto('http://127.0.0.1:' + server.address().port)
    await page.getByRole('button', { name: '我', exact: true }).click()
    await page.getByRole('button', { name: /^提供商/ }).click()
    const settings = page.locator('.provider-settings')
    await settings.waitFor()

    assert.equal(await settings.locator('.model-tabs').getByRole('tab').count(), 3)
    assert.equal(await settings.locator('.default-model-row').count(), 0)
    assert.match(await settings.locator('.model-provider-row').first().textContent(), /DeepSeek.*deepseek\.com.*2 个模型.*Key 已保存.*已启用/s)
    assert.equal(await settings.getByRole('button', { name: '管理 DeepSeek 提供商', exact: true }).count(), 1)
    const unstyled = await settings.locator('button').evaluateAll(buttons => buttons.filter(button => !button.className.trim()).map(button => button.textContent))
    assert.deepEqual(unstyled, [])
    if (process.env.YOMI_SETTINGS_MODEL_SCREENSHOT) await page.screenshot({ path: process.env.YOMI_SETTINGS_MODEL_SCREENSHOT, fullPage: true, animations: 'disabled' })
    console.log('PASS settings has independent provider and default-model pages')

    await settings.locator('.model-provider-heading').getByRole('button', { name: '添加提供商', exact: true }).click()
    const providerPage = page.locator('.provider-page')
    await providerPage.waitFor()
    assert.equal(await providerPage.getByRole('tab', { name: '配置', exact: true }).getAttribute('aria-selected'), 'true')
    await providerPage.getByRole('tab', { name: /模型/ }).click()
    await providerPage.getByRole('button', { name: '保存', exact: true }).click()
    await providerPage.getByRole('alert').waitFor()
    assert.equal(await providerPage.getByRole('tab', { name: '配置', exact: true }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.evaluate(() => window.modelFixture().providers.length), 2)
    await providerPage.getByLabel('名称', { exact: true }).fill('测试提供商')
    await providerPage.getByLabel('API Base URL').fill('https://api.example.com/v1')
    await providerPage.getByLabel('API Key', { exact: true }).fill('fixture-key')
    await providerPage.getByRole('button', { name: '测试连接', exact: true }).click()
    await providerPage.getByRole('status').filter({ hasText: '连接成功' }).waitFor()
    assert.equal(requests.at(-1).url, 'https://api.example.com/v1/models')
    assert.equal(requests.at(-1).authenticated, true)
    assert.equal(await page.evaluate(() => window.modelFixture().providers.length), 2, 'testing must not save a supplier')
    await providerPage.getByRole('tab', { name: /模型/ }).click()
    assert.equal(await providerPage.getByRole('button', { name: '拉取模型', exact: true }).isEnabled(), true)
    assert.equal(await providerPage.locator('.provider-model-list').count(), 1)
    assert.equal(await providerPage.getByRole('button', { name: '保存', exact: true }).count(), 1)
    await providerPage.getByRole('button', { name: '拉取模型', exact: true }).click()
    await providerPage.getByRole('checkbox', { name: 'alpha-model', exact: true }).waitFor()
    assert.equal(await providerPage.getByRole('checkbox', { name: 'alpha-model', exact: true }).isChecked(), false)
    await providerPage.getByRole('checkbox', { name: 'alpha-model', exact: true }).check()
    await providerPage.getByRole('textbox', { name: '手动模型 ID' }).fill('manual-model')
    await providerPage.getByRole('button', { name: '添加', exact: true }).click()
    assert.equal(await providerPage.getByRole('checkbox', { name: 'manual-model', exact: true }).isChecked(), true)
    await providerPage.getByRole('searchbox', { name: '搜索模型' }).fill('beta')
    assert.equal(await providerPage.getByRole('checkbox', { name: 'beta-model', exact: true }).count(), 1)
    await providerPage.getByRole('searchbox', { name: '搜索模型' }).fill('')
    apiStatus = 401
    await providerPage.getByRole('button', { name: '拉取模型', exact: true }).click()
    await providerPage.getByRole('alert').filter({ hasText: '认证失败' }).waitFor()
    assert.equal(await providerPage.getByRole('checkbox', { name: 'alpha-model', exact: true }).isChecked(), true)
    apiStatus = 200
    await providerPage.getByRole('tab', { name: '配置', exact: true }).click()
    await providerPage.getByLabel('API Base URL').fill('https://api.example.com/edited/v1')
    await providerPage.getByRole('button', { name: '测试连接', exact: true }).click()
    await providerPage.getByRole('status').filter({ hasText: '连接成功' }).waitFor()
    assert.equal(requests.at(-1).url, 'https://api.example.com/edited/v1/models', 'test must use the current draft URL')
    await providerPage.getByRole('tab', { name: /模型/ }).click()
    assert.equal(await providerPage.getByRole('checkbox', { name: 'manual-model', exact: true }).isChecked(), true)
    await providerPage.getByRole('button', { name: '拉取模型', exact: true }).click()
    await providerPage.getByRole('status').filter({ hasText: '已拉取 2 个模型' }).waitFor()
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 })
      assert.equal(await providerPage.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'provider detail overflow at ' + width)
      const saveRect = await providerPage.getByRole('button', { name: '保存', exact: true }).boundingBox()
      assert.equal(await page.locator('.mobile-tabbar').isVisible(), false)
      const footer = await providerPage.locator('.provider-save-bar').boundingBox()
      assert.ok(Math.abs(footer.y + footer.height - 844) <= 1, 'save bar must touch the viewport bottom at ' + width)
      assert.ok(saveRect.y >= 0 && saveRect.y + saveRect.height <= 844)
    }
    await page.setViewportSize({ width: 390, height: 500 })
    await providerPage.getByRole('tab', { name: '配置', exact: true }).click()
    await providerPage.locator('#provider-config-panel').evaluate(el => { el.scrollTop = el.scrollHeight })
    const shortFooter = await providerPage.locator('.provider-save-bar').boundingBox()
    assert.ok(Math.abs(shortFooter.y + shortFooter.height - 500) <= 1, 'save bar must stay pinned on a short viewport after scrolling')
    await providerPage.getByRole('tab', { name: /模型/ }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    if (process.env.YOMI_PROVIDER_MODELS_SCREENSHOT) await page.screenshot({ path: process.env.YOMI_PROVIDER_MODELS_SCREENSHOT, animations: 'disabled' })
    await providerPage.getByRole('button', { name: '保存', exact: true }).click()
    await settings.waitFor()
    const added = await page.evaluate(() => window.modelFixture().providers.find(p => p.name === '测试提供商'))
    assert.equal(added.baseUrl, 'https://api.example.com/edited/v1')
    assert.deepEqual(await page.evaluate(id => window.modelFixture().selectedModels[id], added.id), ['alpha-model', 'manual-model'])
    assert.equal(await page.evaluate(id => window.modelFixture().providerKinds[id], added.id), 'text')
    await page.getByRole('button', { name: '返回我' }).click()
    await page.getByRole('button', { name: /^默认模型/ }).click()
    const defaults = page.locator('.default-model-settings')
    const defaultText = defaults.getByRole('combobox', { name: '文字模型', exact: true })
    assert.equal(await defaultText.locator('option').filter({ hasText: 'manual-model' }).count(), 1)
    await defaultText.selectOption(JSON.stringify([added.id, 'manual-model']))
    await page.waitForFunction(() => window.modelFixture().bindings.some(b => b.purpose === 'main' && b.modelId === 'manual-model'))
    await page.evaluate(() => { window.rejectNextBinding = true })
    await defaultText.selectOption(JSON.stringify(['text-1', 'deepseek-reasoner']))
    await page.locator('.toast.error').filter({ hasText: '模拟保存失败' }).waitFor()
    assert.equal(await defaultText.inputValue(), JSON.stringify([added.id, 'manual-model']))
    assert.equal(await page.evaluate(() => window.modelFixture().bindings.find(b => b.purpose === 'main').modelId), 'manual-model')
    await defaults.getByRole('combobox', { name: '图片模型', exact: true }).selectOption('')
    await page.waitForFunction(() => window.modelFixture().media.imageModel === '')
    assert.equal(await page.evaluate(() => window.modelFixture().media.voice), 'alloy')
    await defaults.getByRole('combobox', { name: '图片模型', exact: true }).selectOption(JSON.stringify(['image-1', 'image-model']))
    await page.waitForFunction(() => window.modelFixture().media.imageModel === 'image-model')
    assert.equal(await defaults.getByRole('button', { name: '保存', exact: true }).count(), 0)
    if (process.env.YOMI_DEFAULT_MODELS_SCREENSHOT) {
      await page.locator('.toast').waitFor({ state: 'hidden' })
      await page.screenshot({ path: process.env.YOMI_DEFAULT_MODELS_SCREENSHOT, animations: 'disabled' })
    }
    await page.getByRole('button', { name: '返回我' }).click()
    assert.equal(await page.getByRole('button', { name: /^提供商/ }).count(), 1)
    assert.equal(await page.getByRole('button', { name: /^默认模型/ }).count(), 1)
    await page.getByRole('button', { name: /^提供商/ }).click()
    console.log('PASS draft connection tests, fetch/filter/select/manual flow, failed refresh retention, one save and responsive detail layout')

    await settings.getByRole('button', { name: '管理 测试提供商 提供商', exact: true }).click()
    await providerPage.getByLabel('API Base URL').fill('https://api.example.com/unsaved/v1')
    dismissNextDialog = true
    await providerPage.getByRole('button', { name: '返回提供商列表' }).click()
    assert.equal(await providerPage.count(), 1)
    await providerPage.getByRole('button', { name: '返回提供商列表' }).click()
    await settings.waitFor()
    assert.equal(await page.evaluate(id => window.modelFixture().providers.find(p => p.id === id).baseUrl, added.id), added.baseUrl)
    console.log('PASS discarding a draft keeps the persisted supplier intact')

    await settings.getByRole('button', { name: '管理 测试提供商 提供商', exact: true }).click()
    await providerPage.getByLabel('启用提供商', { exact: true }).uncheck()
    await providerPage.getByRole('button', { name: '保存', exact: true }).click()
    await settings.waitFor()
    assert.match(await settings.getByRole('button', { name: '管理 测试提供商 提供商', exact: true }).textContent(), /已停用/)
    await page.getByRole('button', { name: '返回我' }).click()
    await page.getByRole('button', { name: /^默认模型/ }).click()
    assert.equal(await defaultText.locator('option').filter({ hasText: 'manual-model' }).getAttribute('disabled'), '')
    await page.getByRole('button', { name: '返回我' }).click()
    await page.getByRole('button', { name: /^提供商/ }).click()
    await settings.getByRole('button', { name: '管理 测试提供商 提供商', exact: true }).click()
    await providerPage.getByRole('button', { name: '删除提供商', exact: true }).click()
    await settings.waitFor()
    assert.equal(await settings.getByRole('button', { name: '管理 测试提供商 提供商', exact: true }).count(), 0)
    assert.equal(await page.evaluate(id => window.modelFixture().providers.some(p => p.id === id), added.id), false)
    console.log('PASS selected models can become defaults, disabled suppliers cannot be newly selected, and deletion removes the supplier')

    await settings.getByRole('button', { name: '管理 DeepSeek 提供商', exact: true }).click()
    await providerPage.waitFor()
    assert.equal(await providerPage.getByRole('button', { name: '测试连接', exact: true }).count(), 1)
    await providerPage.getByRole('tab', { name: /模型/ }).click()
    assert.match(await providerPage.textContent(), /已选择 2 个模型/)
    assert.equal(await providerPage.getByRole('checkbox', { name: 'deepseek-chat', exact: true }).isChecked(), true)
    assert.equal(await providerPage.getByRole('checkbox', { name: 'deepseek-reasoner', exact: true }).isChecked(), true)
    await providerPage.getByRole('tab', { name: '配置', exact: true }).click()
    if (process.env.YOMI_PROVIDER_CONFIG_SCREENSHOT) {
      await page.locator('.toast').waitFor({ state: 'hidden' })
      await page.screenshot({ path: process.env.YOMI_PROVIDER_CONFIG_SCREENSHOT, animations: 'disabled' })
    }
    await providerPage.getByRole('button', { name: '返回提供商列表' }).click()
    console.log('PASS saved provider opens a detail view with connection diagnostics and model selection')

    for (const [tab, expected, unexpected] of [['图片', 'Image Lab', 'DeepSeek'], ['语音', null, 'DeepSeek'], ['文字', 'DeepSeek', 'Image Lab']]) {
      await settings.getByRole('tab', { name: tab, exact: false }).click()
      const panel = settings.locator('.model-panel:not([hidden])')
      if (expected) assert.equal(await panel.getByRole('button', { name: `管理 ${expected} 提供商`, exact: true }).count(), 1)
      assert.equal(await panel.getByRole('button', { name: `管理 ${unexpected} 提供商`, exact: true }).count(), 0)
    }
    console.log('PASS text, image and speech suppliers stay in their respective categories')

    await page.getByRole('button', { name: '返回我' }).click()
    await page.getByRole('button', { name: /世界书/ }).click()
    const sheet = page.locator('.lorebook-sheet')
    await sheet.waitFor()
    assert.equal(await sheet.getByRole('button', { name: /雾港市设定/ }).getAttribute('aria-pressed'), 'false')
    await sheet.getByRole('button', { name: /雾港市设定/ }).click()
    assert.equal(await sheet.getByRole('button', { name: /雾港市设定/ }).getAttribute('aria-pressed'), 'true')
    assert.match(await sheet.locator('.lorebook-editor-heading').textContent(), /卷设置.*雾港市设定.*已启用/s)
    assert.equal(await sheet.locator('.lorebook-entry').count(), 2)
    const lorebookUnstyled = await sheet.locator('button').evaluateAll(buttons => buttons.filter(button => !button.className.trim()).map(button => button.textContent))
    assert.deepEqual(lorebookUnstyled, [])
    assert.equal(await sheet.getByRole('button', { name: '已保存', exact: true }).getAttribute('class'), 'btn-primary')
    assert.equal(await sheet.getByRole('button', { name: '删除卷', exact: true }).getAttribute('class'), 'btn-danger')
    await sheet.getByRole('button', { name: '添加条目', exact: true }).click()
    assert.equal(await sheet.locator('.lorebook-entry-form').count(), 1)
    await sheet.getByLabel('条目标题').fill('未保存标题')
    await sheet.getByLabel('内容').fill('未保存的条目内容')
    assert.match(await sheet.locator('.lorebook-entry-form').textContent(), /条目有未保存的修改/)
    assert.equal(await sheet.getByRole('button', { name: '保存条目', exact: true }).isEnabled(), true)
    await sheet.locator('.lorebook-entry-form').getByRole('button', { name: '取消', exact: true }).click()
    await page.waitForTimeout(50)
    assert.equal(await sheet.locator('.lorebook-entry-form').count(), 0)
    console.log('PASS worldbook has a selected list/current-volume hierarchy and complete primary/secondary/destructive actions')

    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 })
      assert.equal(await sheet.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'worldbook overflow at ' + width)
      const rect = await sheet.boundingBox()
      assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1)
    }
    if (process.env.YOMI_SETTINGS_SCREENSHOT) await sheet.screenshot({ path: process.env.YOMI_SETTINGS_SCREENSHOT })
    await sheet.getByRole('button', { name: '关闭世界书' }).click()
    const settingsPages = [
      ['提供商', '提供商'],
      ['默认模型', '默认模型'],
      ['编辑资料', '本地资料'],
      ['后台互动', '后台互动'],
      ['用量统计', '用量统计'],
      ['备份与恢复', '备份与恢复'],
      ['存储与诊断', '存储与诊断'],
      ['应用更新', '应用更新'],
      ['关于 Yomi', '关于 Yomi']
    ]
    for (const [menuLabel, pageTitle] of settingsPages) {
      if (await page.locator('.settings-page-header').count()) await page.getByRole('button', { name: '返回我' }).click()
      await page.getByRole('button', { name: new RegExp(menuLabel) }).click()
      await page.locator('.settings-page-header').waitFor()
      assert.equal((await page.locator('.settings-page-header h1').textContent()).trim(), pageTitle)
      assert.equal(await page.locator('.settings-section > h4').filter({ hasText: new RegExp('^' + pageTitle + '$') }).count(), 0, 'duplicate page title: ' + pageTitle)
      const subpage = page.locator('.me-detail')
      for (const width of [320, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 844 })
        assert.equal(await subpage.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, `${pageTitle} overflow at ${width}`)
      }
      await page.setViewportSize({ width: 390, height: 844 })
    }
    await page.getByRole('button', { name: '返回我' }).click()
    await page.getByRole('button', { name: '编辑资料', exact: true }).click()
    const saveProfile = page.getByRole('button', { name: '已保存', exact: true })
    assert.equal(await saveProfile.isDisabled(), true)
    await page.getByLabel('昵称').fill('小磊')
    const saveChangedProfile = page.getByRole('button', { name: '保存资料', exact: true })
    assert.equal(await saveChangedProfile.isEnabled(), true)
    await saveChangedProfile.click()
    await page.getByRole('button', { name: '已保存', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '已保存', exact: true }).isDisabled(), true)
    assert.equal(await page.evaluate(() => window.profile().name), '小磊')
    console.log('PASS every settings subpage has one title, no horizontal overflow, and profile saves only real changes')
    await page.getByRole('button', { name: '返回我' }).click()
    await page.getByRole('button', { name: /^提供商/ }).click()
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 })
      const panel = page.locator('.model-panel:not([hidden])')
      assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'model settings overflow at ' + width)
      const rect = await panel.boundingBox()
      assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1)
    }
    assert.deepEqual(errors, [])
    console.log('PASS 320/390/768/1280 responsive layouts without horizontal overflow')
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
