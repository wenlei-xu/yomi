const {build}=require('esbuild'),{chromium}=require(process.env.YOMI_PLAYWRIGHT||'playwright')
const http=require('node:http'),assert=require('node:assert/strict'),path=require('node:path')
const fixture=`
let progress,ready=false,permission=true; window.updateCalls=[];
export const androidUpdates=()=>true;
export const installedVersion=async()=>({versionName:'1.0.0',versionCode:1,sdk:35,debug:false});
export const latestRelease=async()=>({format:'yomi-release',applicationId:'app.yomi.mobile',versionName:'1.0.1',versionCode:2,minSdk:24,size:1000000,sha256:'a'.repeat(64),url:'https://stoneapi.me/releases/yomi.apk',publishedAt:'2026-10-24T00:00:00Z',notes:'fixture release'});
export const Updater={ready:async()=>({}),webStatus:async()=>({activeVersion:1,pendingVersion:0,rolledBack:false}),
 syncWeb:async()=>({activeVersion:1,pendingVersion:2,rolledBack:false}),rollbackWeb:async()=>{window.updateCalls.push('rollback')},
 addListener:async(event,cb)=>{progress=cb;return{remove:async()=>{}}},
 download:async({requestId})=>{window.updateCalls.push('download');progress({requestId,bytes:500000,total:1000000});await new Promise(r=>setTimeout(r,50));ready=true},
 cancel:async()=>{},install:async()=>{window.updateCalls.push('install');const result={permissionRequired:permission};permission=false;return result}};
`
async function main(){
 const compiled=await build({stdin:{contents:"import React from 'react';import {createRoot} from 'react-dom/client';import {UpdateProvider,UpdateSettings} from './src/update/UpdateCenter';createRoot(document.getElementById('root')).render(<UpdateProvider><UpdateSettings/></UpdateProvider>)",loader:'tsx',resolveDir:path.resolve(__dirname,'..')},bundle:true,write:false,plugins:[{name:'bridge-fixture',setup(b){b.onResolve({filter:/\.\/bridge$/},()=>({path:'bridge',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:fixture,loader:'js'}))}}]})
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?compiled.outputFiles[0].text:'<html><body><div id="root"></div><script src="/app.js"></script></body></html>')})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const browser=await chromium.launch({headless:true,channel:'chrome'})
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[]
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept())
  await page.addInitScript(()=>localStorage.setItem('yomi-update-auto','off'))
  await page.goto('http://127.0.0.1:'+server.address().port)
  await page.getByRole('button',{name:'检查更新',exact:true}).click()
  await page.getByRole('dialog',{name:'Yomi 1.0.1 可更新'}).waitFor()
  await page.getByRole('button',{name:'下载更新',exact:true}).click()
  await page.getByRole('button',{name:'安装更新',exact:true}).waitFor()
  await page.getByRole('button',{name:'安装更新',exact:true}).click()
  await page.getByRole('dialog').getByText('请在系统设置中允许 Yomi 安装应用，返回后再点“安装更新”。',{exact:true}).waitFor()
  await page.getByRole('button',{name:'安装更新',exact:true}).click()
  await page.getByRole('button',{name:'稍后再说',exact:true}).click()
  await page.getByRole('button',{name:'同步页面更新',exact:true}).click()
  await page.getByText('已准备好页面更新，下次启动生效。',{exact:true}).waitFor()
  await page.getByRole('button',{name:'回退页面版本',exact:true}).click()
  assert.deepEqual(await page.evaluate(()=>window.updateCalls),['download','install','install','rollback'])
  assert.deepEqual(errors,[])
  console.log('PASS mobile update UI: check, download, permission return, system installer, silent staging and manual rollback')
 }finally{await browser.close();server.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
