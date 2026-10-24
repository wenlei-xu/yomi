const {buildSync}=require('esbuild')
const {chromium}=require(process.env.YOMI_PLAYWRIGHT || 'playwright')
const http=require('http'),assert=require('node:assert/strict')
const fixture=`
const actor={id:'a',kind:'agent',name:'Alpha',color:'#238672',enabled:true,archived:false,avatarData:''};
const room={id:'room',kind:'direct',title:'Test chat',members:['local-user','a'],memberNames:['Me','Alpha'],lastMessage:'hello',updatedAt:Date.now()};
let messages=[{id:'u',conversationId:'room',authorId:'local-user',authorKind:'human',authorName:'Me',body:'question',sequence:1,createdAt:Date.now(),reactions:[],mentions:[]},{id:'a1',conversationId:'room',authorId:'a',authorKind:'agent',authorName:'Alpha',body:'hello',sequence:2,createdAt:Date.now(),reactions:[],mentions:[],editHistory:[]}];
let update;window.testCalls=[];
export async function createApp(cb){update=cb;return {
actors:async()=>[actor,{id:'local-user',kind:'human',name:'Me'}],conversations:async()=>[room],whispers:async()=>[],runtimeIssues:async()=>[],
conversation:async(id)=>({...room,id}),messages:async()=>messages,message:async(id)=>messages.find(m=>m.id===id),messagesAround:async()=>({messages,hasOlder:false,hasNewer:false}),
mediaAssets:async()=>[],draft:async()=>({body:'',quotedId:null}),saveDraft:async()=>{},markRead:async()=>{},mediaSettings:async()=>({}),
react:async(id,emoji)=>{window.testCalls.push(['react',id,emoji]);},
editMessage:async(id,body)=>{messages=messages.map(m=>m.id===id?{...m,body,editedAt:Date.now(),editHistory:[{body:m.body,at:Date.now()}]}:m);update()},
recallMessage:async(id)=>{window.testCalls.push(['recall',id]);messages=messages.map(m=>m.id===id?{...m,body:'recalled',recalled:true}:m);update()},
regenerateMessage:async(id)=>{window.testCalls.push(['regenerate',id]);return 'branch'},
searchMessages:async(q,opts)=>{window.testCalls.push(['search',q,opts]);return messages.filter(m=>!m.recalled&&m.body.includes(q)).map(m=>({...m,conversationTitle:room.title}))},
runtime:{snapshot:()=>({running:[],waiting:[],streaming:[]}),setForeground:()=>{}},cancelMedia:()=>{},
}}
`
async function main(){
 const build=await require('esbuild').build({entryPoints:['src/main.tsx'],bundle:true,write:false,format:'iife',loader:{'.css':'empty'},plugins:[{name:'fixture',setup(build){build.onResolve({filter:/app\/bootstrap$/},()=>({path:'bootstrap',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:fixture,loader:'js'}))}}]})
 const js=build.outputFiles[0].text
 const server=http.createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(js)}else{res.setHeader('Content-Type','text/html');res.end('<html><body><div id="root"></div><script src="/app.js"></script></body></html>')}})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true,channel:'chrome'});
 try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('UI ERROR',e.message)});page.on('dialog',d=>d.accept())
 await page.goto('http://127.0.0.1:'+server.address().port)
 assert.equal(await page.locator('.conversation-row .row-time').count(),1)
 assert.ok((await page.locator('.conversation-row .row-time').textContent()).trim().length>0)
 await page.locator('.conversation-row').click();await page.getByRole('button',{name:'更多消息操作',exact:true}).last().click();await page.getByRole('menuitem',{name:'编辑消息',exact:true}).click();await page.getByLabel('消息正文').fill('edited hello');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByText('edited hello',{exact:true}).waitFor()
 await page.locator('article.mine').getByRole('button',{name:'给 Me 的消息添加表情',exact:true}).click();assert.equal(await page.getByRole('menu',{name:'消息操作',exact:true}).count(),0);await page.getByRole('group',{name:'选择表情',exact:true}).waitFor();await page.getByRole('button',{name:'表情 👍',exact:true}).click()
 await page.locator('article.mine').getByRole('button',{name:'更多消息操作',exact:true}).click();await page.getByRole('menuitem',{name:'撤回消息',exact:true}).click();await page.getByText('你撤回了一条消息',{exact:true}).waitFor()
 await page.getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('button',{name:'搜索本会话',exact:true}).click();await page.getByLabel('关键词').fill('hello');await page.getByRole('button',{name:'搜索',exact:true}).click();await page.getByText('已找到 1 条',{exact:true}).waitFor();await page.locator('.search-hit').click()
 await page.locator('article:not(.mine)').getByRole('button',{name:'更多消息操作',exact:true}).last().click();await page.getByRole('menuitem',{name:'重新生成',exact:true}).click();await page.waitForFunction(()=>window.testCalls.some(c=>c[0]==='regenerate'))
 assert.deepEqual(errors,[])
 console.log('PASS UI: conversation time, edit/save, emoji, recall, scoped search/jump, and regenerate navigation at mobile viewport')
 console.log(JSON.stringify(await page.evaluate(()=>window.testCalls)))
 }finally{await browser.close();server.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1})
