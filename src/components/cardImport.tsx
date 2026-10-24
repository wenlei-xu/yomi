import { useEffect, useState } from 'react'
import type { AppApi } from '../app/bootstrap'
import { readPngCard } from '../data/characterCard'
import { CloseIcon } from './icons'

type Notify=(notice:{text:string;tone:'ok'|'error'})=>void
const errorText=(e:unknown)=>e instanceof Error?e.message:'导入失败'
export function CardImport({app,notify}:{app:AppApi;notify:Notify}) {
  const [busy,setBusy]=useState(false)
  const [report,setReport]=useState<{name:string;warnings:string[]}|null>(null)
  return <><label className="agent-action-file">{busy?'导入中…':'导入酒馆卡'}<input type="file" accept=".json,.png" disabled={busy} onChange={async e=>{
    const file=e.target.files?.[0];e.target.value='';if(!file)return
    if(file.size>12000000){notify({text:'角色卡超过 12 MB',tone:'error'});return}
    setBusy(true)
    try {
      let json:string,png=''
      if(/\.png$/i.test(file.name)) {
        json=readPngCard(await file.arrayBuffer())
        png=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('读取图片失败'));reader.readAsDataURL(file)})
      }else json=await file.text()
      const result=await app.importCharacterCard(file.name,json,png)
      setReport({name:result.actor.name,warnings:result.unsupported})
    }catch(e){notify({text:errorText(e),tone:'error'})}finally{setBusy(false)}
  }}/></label>
  {report && <div className="sheet-backdrop" onClick={()=>setReport(null)}><div className="sheet" onClick={e=>e.stopPropagation()}>
    <div className="sheet-heading"><h3>已导入：{report.name}</h3><button className="sheet-close" onClick={()=>setReport(null)}><CloseIcon/></button></div>
    {report.warnings.map((w,i)=><p className="hint" key={i}>{w}</p>)}
    <button className="wide-primary" onClick={()=>setReport(null)}>完成</button>
  </div></div>}</>
}

export function OriginalCard({app,actorId,notify}:{app:AppApi;actorId:string;notify:Notify}) {
  const [source,setSource]=useState<Awaited<ReturnType<AppApi['characterSource']>>>(null)
  useEffect(()=>{let active=true;void app.characterSource(actorId).then(s=>{if(active)setSource(s)},e=>notify({text:errorText(e),tone:'error'}));return()=>{active=false}},[app,actorId])
  if(!source)return null
  return <details className="settings-card"><summary>酒馆角色卡 · 原始资料已保留</summary>
    {source.warnings.map((w,i)=><p className="hint" key={i}>{w}</p>)}
    <p className="hint">原卡导出包含导入时的全部字段。你在 Yomi 的资料修改包含在“导出角色”中。</p>
    <button className="btn-quiet" type="button" onClick={()=>void app.exportOriginalCard(actorId).then(name=>notify({text:'已导出：'+name,tone:'ok'}),e=>notify({text:errorText(e),tone:'error'}))}>导出原始角色卡</button>
  </details>
}

export function Greetings({app,actorId,conversationId,version,notify}:{app:AppApi;actorId:string;conversationId:string;version:number;notify:Notify}) {
  const [items,setItems]=useState<string[]>([])
  const [busy,setBusy]=useState(false)
  useEffect(()=>{let active=true;void app.greetings(actorId).then(v=>{if(active)setItems(v)},e=>notify({text:errorText(e),tone:'error'}));return()=>{active=false}},[app,actorId,version])
  if(!items.length)return null
  return <div className="settings-card"><h4>选择角色开场白</h4>{items.map((text,i)=><button className="greeting-choice" key={i} disabled={busy} onClick={async()=>{
    setBusy(true);try{await app.startGreeting(conversationId,text)}catch(e){notify({text:errorText(e),tone:'error'})}finally{setBusy(false)}
  }}>{text}</button>)}</div>
}
