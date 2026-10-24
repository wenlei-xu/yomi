const { build, buildSync } = require('esbuild')
const { chromium } = require(process.env.YOMI_PLAYWRIGHT || 'playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const compiled = buildSync({ entryPoints: ['src/components/emoticons.ts'], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const mod = { exports: {} }
new Function('module', 'exports', compiled)(mod, mod.exports)
const { emoticons, splitEmoticons, deleteBefore } = mod.exports
assert.equal(emoticons.length, 109)
assert.equal(new Set(emoticons.map(item => item.code)).size, 109)
for (const item of emoticons) assert.ok(fs.existsSync(path.join('public', item.src)))
assert.equal(splitEmoticons('早[捂脸][旺柴]安').filter(part => typeof part === 'object').length, 2)
assert.deepEqual(splitEmoticons('[不存在]'), ['[不存在]'])
assert.deepEqual(deleteBefore('好[捂脸]', 5), { text: '好', cursor: 1 })
for (const text of ['👍🏽', '👨‍👩‍👧‍👦', '🇨🇳', 'a\u0301']) assert.equal(deleteBefore(text, text.length).text, '')
console.log('PASS catalog, offline assets, shortcodes, unknown text, atomic emoticon / grapheme deletion')

const fixture = `
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9E0AAAAASUVORK5CYII=';
const actor={id:'a',kind:'agent',name:'Alpha',color:'#238672',enabled:true,archived:false,avatarData:''};
const room={id:'room',kind:'direct',title:'Alpha',members:['local-user','a'],memberNames:['Me','Alpha'],lastMessage:'你好[微笑]',updatedAt:Date.now(),paused:false};
let messages=[{id:'a1',conversationId:'room',authorId:'a',authorKind:'agent',authorName:'Alpha',body:'你好[微笑] **[捂脸]** \\x60[旺柴]\\x60 [未知]',sequence:1,createdAt:Date.now(),reactions:[],mentions:[],editHistory:[]},
{id:'picture',conversationId:'room',authorId:'a',authorKind:'agent',authorName:'Alpha',body:'图片',mediaId:'picture',sequence:2,createdAt:Date.now(),reactions:[],mentions:[],editHistory:[]}];
let stickers=[{id:'s1',name:'测试图片',dataUrl:png,createdAt:1}];let draft={body:'',quotedId:null};let update;
let recognition={enabled:false,providerId:'',modelId:'',consentedOrigin:'',revision:0};
const vision={id:'vision',name:'看图渠道',protocol:'chat-completions',baseUrl:'https://vision.example.test/v1',enabled:true,credentialState:'stored'};
window.calls=[];window.savedDraft=()=>draft;window.stickerCount=()=>stickers.length;window.failNextSticker=false;
window.makeStickerFailed=()=>{stickers=stickers.map(s=>({...s,analysisStatus:'failed',analysisError:'fixture failure'}));update()};
const receipts=new Map();
export async function createApp(cb){update=cb;return {
actors:async()=>[actor,{id:'local-user',kind:'human',name:'Me'}],conversations:async()=>[room],whispers:async()=>[],runtimeIssues:async()=>[],
conversation:async()=>({...room}),messages:async()=>messages,message:async(id)=>messages.find(m=>m.id===id),messagesAround:async()=>({messages,hasOlder:false,hasNewer:false}),
mediaAssets:async()=>[],mediaData:async()=>png,draft:async()=>draft,saveDraft:async(_,body,quotedId)=>{draft={body,quotedId}},markRead:async()=>{},mediaSettings:async()=>({}),
stickers:async()=>stickers,saveSticker:async(name,dataUrl)=>{const s={id:'s'+(stickers.length+1),name,dataUrl,createdAt:Date.now()};stickers=[s,...stickers];update();return s},
deleteSticker:async(id)=>{stickers=stickers.filter(s=>s.id!==id);update()},
providers:async()=>[vision,{...vision,id:'generation',name:'生图渠道'}],providerModelSelections:async()=>({vision:['vision-model'],generation:['image-model']}),providerChannelKinds:async()=>({vision:'text',generation:'image'}),
stickerRecognitionSettings:async()=>recognition,saveStickerRecognitionSettings:async(settings,consent)=>{window.calls.push(['recognition-settings',settings.enabled,consent]);recognition={...settings,consentedOrigin:consent?'https://vision.example.test':recognition.consentedOrigin,revision:recognition.revision+1};update();return recognition},
retryStickerRecognition:async(id)=>{window.calls.push(['recognition-retry',id]);stickers=stickers.map(s=>s.id===id?{...s,analysisStatus:'ready'}:s);update()},
sendUser:async(_,body)=>{window.calls.push(['text',body]);messages=[...messages,{id:crypto.randomUUID(),conversationId:'room',authorId:'local-user',authorKind:'human',authorName:'Me',body,sequence:messages.length+1,createdAt:Date.now(),reactions:[],mentions:[]}];draft={body:'',quotedId:null};update()},
sendSticker:async(_,id,command)=>{window.calls.push(['sticker',id,command]);await new Promise(r=>setTimeout(r,80));
if(!receipts.has(command)){const m={id:crypto.randomUUID(),conversationId:'room',authorId:'local-user',authorKind:'human',authorName:'Me',body:'表情包：测试图片',mediaId:'picture',sequence:messages.length+1,createdAt:Date.now(),reactions:[],mentions:[]};messages=[...messages,m];receipts.set(command,m);update()}
if(window.failNextSticker){window.failNextSticker=false;throw Error('模拟回执中断，请重试')}return receipts.get(command)},
runtime:{snapshot:()=>({running:[],waiting:[],streaming:[]}),setForeground:()=>{}},cancelMedia:()=>{},
}}
`

async function main() {
  const result = await build({ entryPoints: ['src/main.tsx'], bundle: true, write: false, outdir: 'fixture', format: 'iife', plugins: [{ name: 'fixture', setup(b) {
    b.onResolve({ filter: /app\/bootstrap$/ }, () => ({ path: 'bootstrap', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: fixture, loader: 'js' }))
  } }] })
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).contents
  const css = result.outputFiles.find(file => file.path.endsWith('.css')).contents
  const imageTests = buildSync({ entryPoints: ['src/media/stickerImages.ts'], bundle: true, write: false, format: 'iife', globalName: 'StickerImageTests' }).outputFiles[0].contents
  const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js) }
    else if (req.url === '/app.css') { res.setHeader('Content-Type', 'text/css'); res.end(css) }
    else if (req.url === '/sticker-images.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(imageTests) }
    else if (/^\/assets\/emoticons\/[a-z]+-\d+\.png$/.test(req.url)) {
      res.setHeader('Content-Type', 'image/png'); res.end(fs.readFileSync(path.join('public', req.url)))
    } else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/sticker-images.js"></script><script src="/app.js"></script></body></html>') }
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
    await page.locator('.conversation-row').click()
    await page.waitForFunction(() => document.querySelectorAll('#message-a1 .inline-emoticon').length === 2)
    assert.equal(await page.locator('#message-a1 code').textContent(), '[旺柴]')
    const input = page.getByRole('textbox', { name: '消息内容' })
    await input.fill('你好')
    await page.getByRole('button', { name: '打开表情', exact: true }).click()
    const panel = page.getByRole('region', { name: '聊天表情' })
    await page.getByRole('button', { name: '微笑', exact: true }).click()
    await page.getByRole('button', { name: '呲牙', exact: true }).click()
    assert.equal(await input.locator('img').count(), 2)
    assert.equal(await input.evaluate(el => document.activeElement === el), false)
    await page.getByRole('button', { name: '删除上一个表情或文字' }).click()
    assert.equal(await input.locator('img').count(), 1)
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.waitForFunction(() => window.calls.some(call => call[0] === 'text'))
    assert.equal(await page.evaluate(() => window.calls.find(call => call[0] === 'text')[1]), '你好[微笑]')
    assert.equal(await panel.count(), 1)
    console.log('PASS continuous selection, draft inline images, keyboard stays closed, backspace, text send keeps panel')

    const rowBox = await page.locator('.composer-row').boundingBox()
    const panelBox = await panel.boundingBox()
    assert.ok(panelBox.y >= rowBox.y + rowBox.height)
    assert.ok(panelBox.y + panelBox.height <= 845)
    await page.getByRole('button', { name: '转到第 3 页表情' }).click()
    await page.waitForFunction(() => document.querySelector('.emoticon-pages').scrollLeft > 700)
    await page.getByRole('button', { name: '捂脸', exact: true }).click()
    await page.getByRole('button', { name: '切换到键盘', exact: true }).click()
    await input.press('Backspace')
    assert.equal(await input.locator('img').count(), 0)
    await input.fill('甲乙')
    await input.press('ArrowLeft')
    await page.getByRole('button', { name: '打开表情', exact: true }).click()
    await page.getByRole('button', { name: '微笑', exact: true }).click()
    await page.getByRole('button', { name: '呲牙', exact: true }).click()
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.waitForFunction(() => window.calls.filter(call => call[0] === 'text').length === 2)
    assert.equal(await page.evaluate(() => window.calls.filter(call => call[0] === 'text')[1][1]), '甲[微笑][呲牙]乙')
    console.log('PASS docked mobile layout, paging, keyboard toggle, atomic image deletion, insertion at saved cursor')

    await page.getByRole('tab', { name: '最近使用', exact: true }).click()
    assert.ok(await panel.getByRole('button', { name: '微笑', exact: true }).count())
    await page.getByRole('tab', { name: '收藏表情', exact: true }).click()
    await page.getByRole('button', { name: '发送表情 测试图片', exact: true }).click()
    await page.waitForFunction(() => window.calls.filter(call => call[0] === 'sticker').length === 1)
    await page.waitForFunction(() => !document.querySelector('.sticker-progress'))
    assert.equal(await panel.count(), 1)
    await page.getByRole('button', { name: '切换到键盘', exact: true }).click()
    await input.fill('未发送的草稿')
    await page.getByRole('button', { name: '打开表情', exact: true }).click()
    await page.getByRole('tab', { name: '收藏表情', exact: true }).click()
    await page.evaluate(() => { window.failNextSticker = true })
    await page.getByRole('button', { name: '发送表情 测试图片', exact: true }).click()
    await page.getByText('模拟回执中断，请重试', { exact: true }).waitFor()
    await page.getByRole('button', { name: '发送表情 测试图片', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.sticker-progress'))
    const attempts = await page.evaluate(() => window.calls.filter(call => call[0] === 'sticker'))
    assert.equal(attempts.length, 3)
    assert.equal(attempts[1][2], attempts[2][2])
    assert.notEqual(attempts[0][2], attempts[1][2])
    assert.equal(await input.textContent(), '未发送的草稿')
    console.log('PASS favorite tap sends immediately, draft preserved, retry reuses idempotency key, subsequent sends use new keys')

    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    await panel.locator('input[type=file]').setInputFiles({ name: '动画.gif', mimeType: 'image/gif', buffer: gif })
    await page.getByRole('button', { name: '发送表情 动画', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.stickerCount()), 2)
    await page.getByRole('button', { name: '管理', exact: true }).click()
    await page.getByRole('button', { name: '删除表情 动画', exact: true }).click()
    await page.waitForFunction(() => window.stickerCount() === 1)
    await page.getByRole('button', { name: '完成', exact: true }).click()
    await page.getByRole('button', { name: '切换到键盘', exact: true }).click()
    await page.locator('#message-picture .media-image-button').click()
    await page.getByRole('button', { name: '添加到表情', exact: true }).click()
    await page.getByText('已添加到表情', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.stickerCount()), 1, 'duplicate image favorites must not be inserted')
    await page.getByRole('button', { name: '关闭图片预览', exact: true }).click()
    console.log('PASS GIF import, favorite management, message-image favorite, content deduplication')

    await page.getByRole('button', { name: '打开表情', exact: true }).click()
    await page.getByRole('tab', { name: '收藏表情', exact: true }).click()
    await page.getByRole('button', { name: '自动识图', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '表情包自动识图', exact: true })
    await dialog.getByLabel('收藏后自动识图').check()
    await dialog.getByLabel('识图模型', { exact: true }).selectOption(JSON.stringify(['vision', 'vision-model']))
    assert.equal(await dialog.getByRole('option', { name: /image-model/ }).count(), 0)
    assert.equal(await dialog.getByRole('button', { name: '保存', exact: true }).isDisabled(), true)
    await dialog.getByLabel(/我同意将现有和新收藏的表情图片/).check()
    if (process.env.YOMI_RECOGNITION_SCREENSHOT) await page.screenshot({ path: process.env.YOMI_RECOGNITION_SCREENSHOT })
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await page.waitForFunction(() => window.calls.some(call => call[0] === 'recognition-settings' && call[1] && call[2]))
    await page.getByRole('button', { name: '关闭识图设置', exact: true }).click()
    await page.evaluate(() => window.makeStickerFailed())
    await page.getByRole('button', { name: '管理', exact: true }).click()
    await page.getByRole('button', { name: '重试识图 测试图片', exact: true }).click()
    await page.waitForFunction(() => window.calls.some(call => call[0] === 'recognition-retry'))
    await page.getByRole('button', { name: '完成', exact: true }).click()
    await page.getByRole('button', { name: '自动识图', exact: true }).click()
    await dialog.getByLabel('收藏后自动识图').uncheck()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await page.waitForFunction(() => window.calls.some(call => call[0] === 'recognition-settings' && !call[1]))
    await page.getByRole('button', { name: '关闭识图设置', exact: true }).click()
    await page.getByRole('button', { name: '切换到键盘', exact: true }).click()
    console.log('PASS vision-only settings, explicit consent gate / origin / cost disclosure, enable / disable, failed-image retry')

    const sourceImage = 'data:image/png;base64,' + fs.readFileSync('public/assets/emoticons/face-053.png').toString('base64')
    const tinyGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    const animatedGif = Buffer.concat([tinyGif.subarray(0, 19), tinyGif.subarray(19, -1), tinyGif.subarray(19, -1), tinyGif.subarray(19, -1), Buffer.from([0x3b])])
    const imageResult = await page.evaluate(async ({ sourceImage, animated }) => {
      const images = await StickerImageTests.prepareStickerImages(sourceImage)
      const decoder = globalThis.ImageDecoder
      let frames = []
      if (decoder) frames = await StickerImageTests.prepareStickerImages(animated)
      globalThis.ImageDecoder = undefined
      let unsupported = false
      try { await StickerImageTests.prepareStickerImages(animated) } catch { unsupported = true }
      finally { globalThis.ImageDecoder = decoder }
      return { staticCount: images.length, jpeg: images[0].startsWith('data:image/jpeg;base64,'), frames: frames.length, hasDecoder: !!decoder, unsupported }
    }, { sourceImage, animated: 'data:image/gif;base64,' + animatedGif.toString('base64') })
    assert.equal(imageResult.staticCount, 1); assert.equal(imageResult.jpeg, true)
    if (imageResult.hasDecoder) assert.equal(imageResult.frames, 3)
    assert.equal(imageResult.unsupported, true)
    console.log('PASS actual browser thumbnail conversion, animated GIF three-frame sampling, explicit unsupported-GIF fallback')

    await input.fill('甲')
    await input.press('Enter')
    await input.press('Enter')
    await page.waitForTimeout(350)
    assert.equal(await page.evaluate(() => window.savedDraft().body), '甲\n\n')
    await input.pressSequentially('乙')
    await page.waitForTimeout(350)
    assert.equal(await page.evaluate(() => window.savedDraft().body), '甲\n\n乙')
    await input.fill('👨‍👩‍👧‍👦')
    await page.getByRole('button', { name: '打开表情', exact: true }).click()
    await page.getByRole('button', { name: '删除上一个表情或文字' }).click()
    assert.equal(await input.textContent(), '')
    await page.getByRole('button', { name: '切换到键盘', exact: true }).click()
    await input.evaluate(el => {
      const data = new DataTransfer()
      data.setData('text/plain', '甲[捂脸]\n乙')
      data.setData('text/html', '<img src=x onerror="window.xss=true">')
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(350)
    assert.equal(await page.evaluate(() => window.savedDraft().body), '甲[捂脸]\n乙')
    assert.equal(await input.locator('img').count(), 1)
    assert.equal(await page.evaluate(() => window.xss), undefined)
    console.log('PASS consecutive / trailing newlines, combined emoji deletion, plain-text paste, HTML stripping')

    await input.fill('第一行')
    await input.press('Enter')
    await input.pressSequentially('second')
    await page.waitForTimeout(400)
    assert.equal(await page.evaluate(() => window.savedDraft().body), '第一行\nsecond')
    await input.fill('[捂脸]')
    assert.equal(await input.locator('img').count(), 1)
    await input.press('Control+Enter')
    await page.waitForFunction(() => window.calls.some(call => call[0] === 'text' && call[1] === '[捂脸]'))
    await input.fill('persistent[微笑]')
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await page.locator('.conversation-row').click()
    assert.equal(await input.locator('img').count(), 1)
    assert.equal(await page.evaluate(() => window.savedDraft().body), 'persistent[微笑]')
    console.log('PASS newlines, typed shortcodes, shortcut send, draft round trip')

    await page.getByRole('button', { name: '打开表情', exact: true }).click()
    if (process.env.YOMI_SCREENSHOT) await page.screenshot({ path: process.env.YOMI_SCREENSHOT })
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}px`)
    }
    assert.deepEqual(errors, [])
    console.log('PASS 320 / 390 / 768 / 1280px layouts, no runtime errors')

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    await mobile.goto('http://127.0.0.1:' + server.address().port)
    await mobile.locator('.conversation-row').tap()
    await mobile.getByRole('button', { name: '打开表情', exact: true }).tap()
    await mobile.getByRole('button', { name: '微笑', exact: true }).tap()
    await mobile.getByRole('button', { name: '呲牙', exact: true }).tap()
    assert.equal(await mobile.locator('.chat-text-input img').count(), 2)
    assert.equal(await mobile.locator('.chat-text-input').evaluate(el => document.activeElement === el), false)
    const client = await mobile.context().newCDPSession(mobile)
    const bounds = await mobile.locator('.emoticon-pages').boundingBox()
    const y = bounds.y + bounds.height / 2
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 345, y }] })
    for (let x = 325; x >= 45; x -= 20) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
      await mobile.waitForTimeout(16)
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await mobile.waitForFunction(() => document.querySelector('.emoticon-pages').scrollLeft > 300)
    console.log('PASS mobile touch selection, no input focus / keyboard reopening, horizontal swipe pagination')
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
