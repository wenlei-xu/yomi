import { useEffect, useRef, useState } from 'react'
import type { AppApi } from '../app/bootstrap'
import type { Actor, MediaAsset, MediaSettings, Message, Provider, Sticker } from '../domain/types'
import { defaultMediaSettings } from '../domain/types'
import { CloseIcon } from './icons'

type Notify=(notice:{text:string;tone:'ok'|'error'})=>void
const errorText=(e:unknown)=>e instanceof Error?e.message:'操作失败'
export function MediaSettingsPanel({app,notify}:{app:AppApi;notify:Notify}) {
  const [settings,setSettings]=useState<MediaSettings>(defaultMediaSettings)
  const [providers,setProviders]=useState<Provider[]>([])
  const [ready,setReady]=useState(false)
  const [busy,setBusy]=useState(false)
  const [connection,setConnection]=useState({name:'',baseUrl:''})
  useEffect(()=>{void Promise.all([app.mediaSettings(),app.providers()]).then(([s,p])=>{
    setSettings(s);setProviders(p);setReady(true)
  },e=>notify({text:errorText(e),tone:'error'}))},[app])
  return <div className="settings-card"><h4>生图与语音</h4>
    <p className="hint">分别设置图片模型和语音模型。连接需支持 OpenAI 兼容的图片生成或语音合成接口。</p>
    {(['image','speech'] as const).map(kind=><div className="media-setting" key={kind}>
      <label>{kind==='image'?'图片连接':'语音连接'}<select disabled={!ready||busy} value={settings[`${kind}ProviderId`]} onChange={e=>setSettings({...settings,[`${kind}ProviderId`]:e.target.value})}>
        <option value="">未配置</option>{providers.map(p=><option key={p.id} value={p.id}>{p.name}{p.credentialState==='missing'?' · 缺少 Key':''}</option>)}
      </select></label>
      <label>{kind==='image'?'图片模型 ID':'语音模型 ID'}<input disabled={!ready||busy} value={settings[`${kind}Model`]} onChange={e=>setSettings({...settings,[`${kind}Model`]:e.target.value})}/></label>
    </div>)}
    <label>默认音色<input disabled={!ready||busy} value={settings.voice} onChange={e=>setSettings({...settings,voice:e.target.value})}/></label>
    <button className="wide-primary" disabled={!ready||busy} onClick={async()=>{
      setBusy(true);try{await app.saveMediaSettings(settings);notify({text:'多媒体设置已保存',tone:'ok'})}catch(e){notify({text:errorText(e),tone:'error'})}finally{setBusy(false)}
    }}>保存多媒体设置</button>
    <details><summary>添加专用连接</summary><div className="media-setting">
      <label>连接名称<input value={connection.name} onChange={e=>setConnection({...connection,name:e.target.value})}/></label>
      <label>Base URL<input value={connection.baseUrl} onChange={e=>setConnection({...connection,baseUrl:e.target.value})} placeholder="https://api.example.com/v1"/></label>
      <button disabled={busy||!connection.name.trim()||!connection.baseUrl.trim()} onClick={async()=>{
        setBusy(true);try {
          const p=await app.saveProvider({id:crypto.randomUUID(),name:connection.name.trim(),baseUrl:connection.baseUrl.trim(),protocol:'chat-completions',
            credentialRef:'',credentialState:'missing',enabled:true,configVersion:1,createdAt:0,updatedAt:0},'__prompt__')
          setProviders(await app.providers());setConnection({name:'',baseUrl:''});notify({text:p.credentialState==='stored'?'连接已保存':'连接已保存，API Key 尚未设置',tone:'ok'})
        }catch(e){notify({text:errorText(e),tone:'error'})}finally{setBusy(false)}
      }}>添加并设置 API Key</button></div>
    </details>
  </div>
}

export function MediaAttachment({app,assetId}:{app:AppApi;assetId:string}) {
  const [source,setSource]=useState('')
  const [failed,setFailed]=useState(false)
  const [preview,setPreview]=useState(false)
  useEffect(()=>{let active=true;setSource('');setFailed(false)
    void app.mediaData(assetId).then(data=>{if(active){if(data && /^data:(image\/(png|jpeg|webp|gif)|audio\/mpeg);base64,/.test(data))setSource(data);else setFailed(true)}},()=>{if(active)setFailed(true)})
    return ()=>{active=false}
  },[app,assetId])
  if(failed)return <small className="media-error">媒体不可用</small>
  if(!source)return <small>正在读取媒体…</small>
  if(source.startsWith('data:audio/'))return <audio controls preload="none" src={source}/>
  return <><button type="button" className="media-image-button" onClick={()=>setPreview(true)}><img loading="lazy" src={source} alt="聊天图片"/></button>
    {preview && <div className="media-preview" onClick={()=>setPreview(false)} role="dialog" aria-label="图片预览"><button type="button" className="sheet-close" onClick={()=>setPreview(false)}><CloseIcon/></button><img src={source} alt="图片预览"/></div>}</>
}

export function MessageSpeech({app,message,version,notify}:{app:AppApi;message:Message;version:number;notify:Notify}) {
  const [asset,setAsset]=useState<MediaAsset|null>(null)
  const [busy,setBusy]=useState(false)
  useEffect(()=>{let active=true
    void app.mediaAssets({kind:'audio',messageId:message.id}).then(v=>{if(active)setAsset(v.find(a=>a.status==='ready')??null)},()=>{})
    return()=>{active=false}
  },[app,message.id,version])
  if(asset)return <MediaAttachment app={app} assetId={asset.id}/>
  return <><button type="button" disabled={busy} className="text-button" onClick={async()=>{
    setBusy(true)
    try{const s=await app.mediaSettings();const a=await app.generateAgentVoice(message.authorId,message.body,s.voice,message.conversationId,message.id)
      if(a.status==='ready')setAsset(a);else notify({text:a.error,tone:'error'})
    }catch(e){notify({text:errorText(e),tone:'error'})}finally{setBusy(false)}
  }}>{busy?'正在合成…':'朗读'}</button>{busy && <button type="button" className="text-button" onClick={()=>app.cancelMedia(message.conversationId)}>取消朗读</button>}</>
}

export function MediaSheet({app,agent,close,notify,conversationId}:{app:AppApi;agent:Actor;close:()=>void;notify:Notify;conversationId?:string}) {
  const [tab,setTab]=useState<'image'|'audio'|'sticker'>('image')
  const [text,setText]=useState('')
  const [voice,setVoice]=useState('alloy')
  const [items,setItems]=useState<MediaAsset[]>([])
  const [stickers,setStickers]=useState<Sticker[]>([])
  const [name,setName]=useState('')
  const [busy,setBusy]=useState(false)
  const [sending,setSending]=useState('')
  const commandIds=useRef(new Map<string,string>())
  const load=async()=>{const [a,b]=await Promise.all([app.mediaAssets({ownerActorId:agent.id,limit:200}),app.stickers()]);setItems(a);setStickers(b)}
  useEffect(()=>{void load().catch(e=>notify({text:errorText(e),tone:'error'}));void app.mediaSettings().then(s=>setVoice(s.voice),e=>notify({text:errorText(e),tone:'error'}))},[app,agent.id])
  const generate=async()=>{if(busy)return;setBusy(true)
    try{const a=tab==='image'?await app.generateAgentImage(agent.id,text,conversationId):await app.generateAgentVoice(agent.id,text,voice,conversationId)
      if(a.status!=='ready')notify({text:a.error,tone:'error'});await load()
    }catch(e){notify({text:errorText(e),tone:'error'})}finally{setBusy(false)}}
  const send=async(id:string,sticker=false)=>{if(!conversationId||sending)return;setSending(id)
    if(!commandIds.current.has(id))commandIds.current.set(id,crypto.randomUUID())
    try { if(sticker)await app.sendSticker(conversationId,id,commandIds.current.get(id)!);else await app.sendMedia(conversationId,id,commandIds.current.get(id)!)
      commandIds.current.delete(id);notify({text:'已发送',tone:'ok'})
    }catch(e){notify({text:errorText(e),tone:'error'})}finally{setSending('')}}
  return <div className="sheet-backdrop" onClick={close}><div className="sheet tall" onClick={e=>e.stopPropagation()}>
    <div className="sheet-handle"/><div className="sheet-heading"><h3>{agent.name} · 多媒体</h3><button className="sheet-close" onClick={close}><CloseIcon/></button></div>
    <div className="pill-filters">{(['image','audio','sticker'] as const).map((t,i)=><button key={t} className={tab===t?'active':''} onClick={()=>setTab(t)}>{['生图','语音','表情包'][i]}</button>)}</div>
    {tab!=='sticker' && <>
      <p className="hint">在“我 → 多媒体设置”配置连接与模型。生成内容保存在本机。</p>
      <label>{tab==='image'?'画面描述':'朗读文字'}<textarea rows={3} maxLength={tab==='image'?4000:4096} value={text} onChange={e=>setText(e.target.value)}/></label>
      {tab==='audio' && <label>音色<input value={voice} onChange={e=>setVoice(e.target.value)}/></label>}
      <button className="wide-primary" disabled={busy||!text.trim()} onClick={()=>void generate()}>{busy?'生成中…':tab==='image'?'生成图片':'生成语音'}</button>
      {busy && <button onClick={()=>app.cancelMedia(conversationId)}>取消生成</button>}
      <div className={tab==='image'?'media-grid':'media-list'}>{items.filter(a=>a.kind===tab).map(a=><div className="media-card" key={a.id}>
        {a.status==='ready'?<MediaAttachment app={app} assetId={a.id}/>:<p className="media-error">{a.status==='pending'?'上次生成尚未完成':a.error}</p>}
        <p className="hint">{a.prompt}</p><div className="actions">
          {conversationId && a.status==='ready' && <button disabled={!!sending} onClick={()=>void send(a.id)}>发送到聊天</button>}
          {a.status==='failed' && <button onClick={()=>setText(a.prompt)}>填入重试</button>}
          <button onClick={()=>void app.deleteMediaAsset(a.id).then(load,e=>notify({text:errorText(e),tone:'error'}))}>删除</button>
        </div></div>)}</div>
    </>}
    {tab==='sticker' && <>
      <label>表情名称<input value={name} maxLength={60} onChange={e=>setName(e.target.value)}/></label>
      <label className="file-button">添加表情图片<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={async e=>{
        const f=e.target.files?.[0];e.target.value='';if(!f)return
        if(f.size>1000000){notify({text:'表情图片不能超过 1 MB',tone:'error'});return}
        try{const data=await new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=()=>reject(new Error('图片读取失败'));r.readAsDataURL(f)})
          await app.saveSticker(name||f.name.replace(/\.[^.]+$/,''),data);setName('');await load()
        }catch(e){notify({text:errorText(e),tone:'error'})}
      }}/></label>
      <div className="media-grid">{stickers.map(s=><div className="media-card" key={s.id}><img src={s.dataUrl} alt={s.name}/><small>{s.name}</small>
        <div className="actions">{conversationId && <button disabled={!!sending} onClick={()=>void send(s.id,true)}>发送</button>}
        <button onClick={()=>void app.deleteSticker(s.id).then(load,e=>notify({text:errorText(e),tone:'error'}))}>删除</button></div>
      </div>)}</div>
    </>}
  </div></div>
}
