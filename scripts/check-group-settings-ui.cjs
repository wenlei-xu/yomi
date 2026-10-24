// Isolated UI fixtures only. Never accesses the user's persistent chats or providers.
const { build } = require('esbuild')
const { chromium } = require(process.env.YOMI_PLAYWRIGHT || 'playwright')
const assert = require('node:assert/strict')
const http = require('node:http')

const fixture = `
const actors=[{id:'local-user',kind:'human',name:'Me',color:'#168ba1'},
...['Alpha','Beta','Charlie','Delta','Disabled'].map((name,i)=>({id:name,kind:'agent',name,color:'#238672',enabled:i!==4,archived:false,bio:'Everyday friend',avatarData:''}))];
let room={id:'room',kind:'group',title:'Weekend group',topic:'KEEP_TOPIC',announcement:'',members:['local-user','Alpha','Beta'],memberNames:['Me','Alpha','Beta'],updatedAt:Date.now(),paused:false,pinned:false,muted:false,hidden:false,autonomyPaused:false};
let messages=[{id:'first',conversationId:'room',authorId:'Alpha',authorName:'Alpha',authorKind:'agent',body:'See you Saturday',sequence:1,createdAt:Date.now(),reactions:[],mentions:[]}];
let update,deleted=false,draft={body:'',quotedId:null}; window.calls=[];window.failNextUpdate=false;
window.room=()=>({...room});window.actorIds=()=>actors.map(a=>a.id);
export async function createApp(cb){update=cb;return {
actors:async()=>actors,conversations:async()=>deleted?[]:[{...room}],whispers:async()=>[],runtimeIssues:async()=>[],
conversation:async()=>({...room}),messages:async()=>messages,message:async id=>messages.find(m=>m.id===id),
draft:async()=>draft,saveDraft:async(_,body,quotedId)=>{draft={body,quotedId}},markRead:async()=>{},mediaAssets:async()=>[],
updateConversation:async(id,patch)=>{window.calls.push(['update',id,patch]);await new Promise(r=>setTimeout(r,50));if(window.failNextUpdate){window.failNextUpdate=false;throw Error('Fixture save failed')}room={...room,...patch,announcementUpdatedAt:patch.announcement!==undefined?Date.now():room.announcementUpdatedAt};update()},
updateMembers:async(id,add,remove)=>{window.calls.push(['members',id,add,remove]);room={...room,members:[...room.members.filter(m=>!remove.includes(m)),...add.filter(m=>!room.members.includes(m))]};update()},
clearConversation:async id=>{window.calls.push(['clear',id]);messages=[];update()},deleteConversation:async id=>{window.calls.push(['delete',id]);deleted=true;update()},
exportConversation:async(id,format)=>{window.calls.push(['export',id,format]);return 'fixture.'+format},
searchMessages:async()=>[],lorebooks:async()=>[],conversationLorebooks:async()=>[],conversationNotes:async()=>[],proactiveRules:async()=>[],summaryTimeline:async()=>[],conversationMemorySources:async()=>[],
runtime:{snapshot:()=>({running:[],waiting:[],streaming:[]}),setForeground:()=>{}},cancelMedia:()=>{},
}}
`
async function main() {
  const result = await build({ entryPoints: ['src/main.tsx'], bundle: true, write: false, outdir: 'fixture', format: 'iife', plugins: [{ name: 'fixture', setup(b) {
    b.onResolve({ filter: /app\/bootstrap$/ }, () => ({ path: 'bootstrap', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: fixture, loader: 'js' }))
  } }] })
  const js = result.outputFiles.find(f => f.path.endsWith('.js')).contents, css = result.outputFiles.find(f => f.path.endsWith('.css')).contents
  const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js) }
    else if (req.url === '/app.css') { res.setHeader('Content-Type', 'text/css'); res.end(css) }
    else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const errors = []; let acceptDialog = true
    page.on('pageerror', error => errors.push(error.message))
    page.on('dialog', dialog => acceptDialog ? dialog.accept() : dialog.dismiss())
    await page.goto('http://127.0.0.1:' + server.address().port)
    await page.locator('.conversation-row').click()
    await page.getByRole('button', { name: '更多', exact: true }).click()
    let info = page.getByRole('dialog', { name: /群聊信息/ })
    await info.waitFor(); assert.equal(await info.locator('.group-member').count(), 5)
    assert.equal(await page.getByRole('button', { name: '保存', exact: true }).count(), 0)
    await info.getByRole('button', { name: /群聊名称/ }).click()
    let editor = page.getByRole('dialog', { name: '群聊名称', exact: true })
    await editor.getByRole('textbox', { name: '群聊名称', exact: true }).fill('New weekend group')
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await page.waitForFunction(() => window.room().title === 'New weekend group')
    await info.waitFor(); assert.match(await page.locator('.chat-header .title-button').textContent(), /New weekend group/)
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)[2]), { title: 'New weekend group' })
    console.log('PASS group ellipsis opens dedicated information; rename saves independently and updates chat title')

    await info.getByRole('button', { name: /群公告/ }).click()
    editor = page.getByRole('dialog', { name: '群公告', exact: true })
    await editor.getByRole('textbox', { name: '群公告', exact: true }).fill('Meet Saturday at ten')
    await editor.getByRole('button', { name: '发布', exact: true }).click()
    await info.waitFor(); assert.equal(await page.evaluate(() => window.room().topic), 'KEEP_TOPIC')
    await info.getByRole('button', { name: '关闭群聊信息', exact: true }).click()
    await page.locator('.group-announcement-banner').click()
    assert.equal(await editor.getByRole('textbox', { name: '群公告', exact: true }).inputValue(), 'Meet Saturday at ten')
    await editor.getByRole('button', { name: '返回群聊信息', exact: true }).click()
    await info.getByRole('switch', { name: '置顶聊天' }).click()
    await page.waitForFunction(() => window.room().pinned)
    await info.getByRole('switch', { name: '消息免打扰' }).click()
    await page.waitForFunction(() => window.room().muted)
    assert.deepEqual(await page.evaluate(() => window.calls.filter(c => c[0] === 'update').slice(-2).map(c => c[2])), [{ pinned: true }, { muted: true }])
    console.log('PASS announcement editor/banner preserves topic; switches save just the changed field immediately')

    await info.getByRole('button', { name: /群聊名称/ }).click()
    editor = page.getByRole('dialog', { name: '群聊名称', exact: true })
    await editor.getByRole('textbox').fill('UNSAVED')
    acceptDialog = false; await editor.getByRole('button', { name: '返回群聊信息' }).click()
    assert.equal(await editor.getByRole('textbox').inputValue(), 'UNSAVED')
    acceptDialog = true; await editor.getByRole('button', { name: '返回群聊信息' }).click()
    assert.equal(await page.evaluate(() => window.room().title), 'New weekend group')
    await info.getByRole('button', { name: /群聊名称/ }).click()
    await editor.getByRole('textbox').fill('Retry group')
    await page.evaluate(() => { window.failNextUpdate = true })
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await editor.getByRole('alert').waitFor()
    assert.equal(await editor.getByRole('textbox').inputValue(), 'Retry group')
    await editor.getByRole('button', { name: '保存', exact: true }).evaluate(button => { button.click(); button.click() })
    await info.waitFor()
    assert.equal(await page.evaluate(() => window.calls.filter(c => c[2]?.title === 'Retry group').length), 2)
    console.log('PASS cancel protects unsaved edits; failed saves retain input and rapid repeat clicks do not duplicate saves')

    await info.getByRole('button', { name: '添加群成员', exact: true }).click()
    let picks = page.getByRole('dialog', { name: '添加群成员', exact: true })
    assert.equal(await picks.getByRole('checkbox').count(), 2)
    await picks.getByRole('checkbox', { name: '选择 Charlie', exact: true }).check()
    await picks.getByRole('button', { name: '添加（1）', exact: true }).click()
    await info.waitFor(); assert.ok((await page.evaluate(() => window.room().members)).includes('Charlie'))
    await info.getByRole('button', { name: '移出群成员', exact: true }).click()
    picks = page.getByRole('dialog', { name: '移出群成员', exact: true })
    assert.equal(await picks.getByRole('checkbox', { name: '选择 Me', exact: true }).count(), 0)
    await picks.getByRole('checkbox', { name: '选择 Alpha', exact: true }).check()
    await picks.getByRole('button', { name: '移出（1）', exact: true }).click()
    await info.waitFor(); assert.deepEqual(await page.evaluate(() => window.room().members), ['local-user', 'Beta', 'Charlie'])
    assert.ok((await page.evaluate(() => window.actorIds())).includes('Alpha'))
    console.log('PASS member selection excludes disabled roles/owner; add and remove preserve role profiles')

    await info.getByRole('button', { name: /角色互动设置/ }).click()
    const advanced = page.getByRole('dialog', { name: '角色互动设置', exact: true })
    await advanced.getByRole('button', { name: /聊天话题/ }).click()
    editor = page.getByRole('dialog', { name: '聊天话题', exact: true })
    assert.equal(await editor.getByRole('textbox').inputValue(), 'KEEP_TOPIC')
    await editor.getByRole('button', { name: '返回群聊信息' }).click()
    await info.getByRole('button', { name: /聊天记录.*导出记录/ }).click()
    const history = page.getByRole('dialog', { name: '聊天记录', exact: true })
    await history.getByRole('button', { name: '导出 Markdown', exact: true }).click()
    await page.waitForFunction(() => window.calls.some(c => c[0] === 'export'))
    await history.getByRole('button', { name: '返回群聊信息' }).click()
    await info.getByRole('button', { name: '查找聊天记录', exact: true }).click()
    await page.getByRole('dialog', { name: '搜索本会话' }).waitFor()
    await page.getByRole('button', { name: '关闭搜索', exact: true }).click()
    await page.getByRole('button', { name: '更多', exact: true }).click()
    console.log('PASS existing advanced settings, history export and in-chat search remain reachable')

    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 })
      assert.equal(await info.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'no horizontal overflow at ' + width)
      const rect = await info.boundingBox(); assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1)
      await info.getByRole('button', { name: '添加群成员', exact: true }).click()
      assert.equal(await page.getByRole('dialog', { name: '添加群成员', exact: true }).evaluate(el => el.scrollWidth <= el.clientWidth + 1), true)
      await page.getByRole('button', { name: '返回群聊信息', exact: true }).click()
    }
    await page.setViewportSize({ width: 390, height: 844 })
    if (process.env.YOMI_GROUP_SCREENSHOT) await info.screenshot({ path: process.env.YOMI_GROUP_SCREENSHOT })
    acceptDialog = false; await info.getByRole('button', { name: '清空聊天记录', exact: true }).click()
    assert.equal(await page.evaluate(() => window.calls.some(c => c[0] === 'clear')), false)
    acceptDialog = true; await info.getByRole('button', { name: '清空聊天记录', exact: true }).click()
    await page.waitForFunction(() => window.calls.some(c => c[0] === 'clear'))
    assert.equal(await page.evaluate(() => window.room().announcement), 'Meet Saturday at ten')
    acceptDialog = false; await info.getByRole('button', { name: '删除群聊', exact: true }).click()
    assert.equal(await page.evaluate(() => window.calls.some(c => c[0] === 'delete')), false)
    acceptDialog = true; await info.getByRole('button', { name: '删除群聊', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('dialog[open]') && !document.querySelector('.chat-header'))
    assert.equal(await page.evaluate(() => window.actorIds().length), 6)
    assert.deepEqual(errors, [])
    console.log('PASS 320/390/768/1280 responsive layouts, destructive confirmation/cancel and return after deleting')
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
