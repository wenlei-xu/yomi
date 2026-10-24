import { useEffect, useRef, useState } from 'react'
import type { AppApi } from '../app/bootstrap'
import type { Actor, MediaAsset, Message } from '../domain/types'
import { saveFavoriteSticker } from './stickerPack'
import { CloseIcon } from './icons'

type Notify=(notice:{text:string;tone:'ok'|'error'})=>void
const errorText=(e:unknown)=>e instanceof Error?e.message:'操作失败'

export function MediaAttachment({app,assetId,variant,notify}:{app:AppApi;assetId:string;variant?:'sticker';notify?:Notify}) {
  const [source,setSource]=useState('')
  const [failed,setFailed]=useState(false)
  const [preview,setPreview]=useState(false)
  const [favoriting,setFavoriting]=useState(false)
  const favoriteLock=useRef(false)
  useEffect(()=>{let active=true;setSource('');setFailed(false)
    void app.mediaData(assetId).then(data=>{if(active){if(data && /^data:(image\/(png|jpeg|webp|gif)|audio\/mpeg);base64,/.test(data))setSource(data);else setFailed(true)}},()=>{if(active)setFailed(true)})
    return ()=>{active=false}
  },[app,assetId])
  if(failed)return <small className="media-error">媒体不可用</small>
  if(!source)return <small>正在读取媒体…</small>
  if(source.startsWith('data:audio/'))return <audio controls preload="none" src={source}/>
  return <><button type="button" className={'media-image-button' + (variant==='sticker'?' sticker-image-button':'')} onClick={()=>setPreview(true)}><img loading="lazy" src={source} alt={variant==='sticker'?'表情贴图':'聊天图片'}/></button>
    {preview && <div className="media-preview" onClick={()=>setPreview(false)} role="dialog" aria-label="图片预览"><button type="button" className="sheet-close" aria-label="关闭图片预览" onClick={()=>setPreview(false)}><CloseIcon/></button><img src={source} alt="图片预览"/>
      {notify && <button type="button" className="media-favorite" disabled={favoriting} onClick={async event=>{
        event.stopPropagation()
        if(favoriteLock.current)return
        favoriteLock.current=true;setFavoriting(true)
        try{await saveFavoriteSticker(app,'收藏表情',source);notify({text:'已添加到表情',tone:'ok'})}
        catch(error){notify({text:errorText(error),tone:'error'})}
        finally{favoriteLock.current=false;setFavoriting(false)}
      }}>{favoriting?'添加中…':'添加到表情'}</button>}
    </div>}</>
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
  const [tab,setTab]=useState<'image'|'audio'>('image')
  const [text,setText]=useState('')
  const [voice,setVoice]=useState('alloy')
  const [items,setItems]=useState<MediaAsset[]>([])
  const [busy,setBusy]=useState(false)
  const [sending,setSending]=useState('')
  const [deleting,setDeleting]=useState('')
  const commandIds=useRef(new Map<string,string>())
  const load=async()=>setItems(await app.mediaAssets({ownerActorId:agent.id,limit:200}))
  useEffect(()=>{void load().catch(e=>notify({text:errorText(e),tone:'error'}));void app.mediaSettings().then(s=>setVoice(s.voice),e=>notify({text:errorText(e),tone:'error'}))},[app,agent.id])
  const generate=async()=>{if(busy||!text.trim())return;setBusy(true)
    try{const a=tab==='image'?await app.generateAgentImage(agent.id,text,conversationId):await app.generateAgentVoice(agent.id,text,voice,conversationId)
      if(a.status!=='ready')notify({text:a.error,tone:'error'});await load()
    }catch(e){notify({text:errorText(e),tone:'error'})}finally{setBusy(false)}}
  const send=async(id:string)=>{if(!conversationId||sending)return;setSending(id)
    if(!commandIds.current.has(id))commandIds.current.set(id,crypto.randomUUID())
    try { await app.sendMedia(conversationId,id,commandIds.current.get(id)!)
      commandIds.current.delete(id);notify({text:'已发送',tone:'ok'})
    }catch(e){notify({text:errorText(e),tone:'error'})}finally{setSending('')}}
  const remove=async(asset:MediaAsset)=>{
    if(deleting||busy||sending)return
    if(!confirm(asset.kind==='image'?'删除这张图片？已发送到聊天的消息不会受影响。':'删除这段语音？已发送到聊天的消息不会受影响。'))return
    setDeleting(asset.id)
    try{await app.deleteMediaAsset(asset.id);await load();notify({text:'已删除',tone:'ok'})}
    catch(e){notify({text:errorText(e),tone:'error'})}
    finally{setDeleting('')}
  }
  return <div className="sheet-backdrop" onClick={close}><div className="sheet tall" onClick={e=>e.stopPropagation()}>
    <div className="sheet-handle"/><div className="sheet-heading"><h3>{agent.name} · 多媒体</h3><button className="sheet-close" onClick={close}><CloseIcon/></button></div>
    <div className="media-tabs" role="tablist" aria-label="多媒体类型">
      <button type="button" role="tab" aria-selected={tab==='image'} className={tab==='image'?'active':''} onClick={()=>setTab('image')}>图片</button>
      <button type="button" role="tab" aria-selected={tab==='audio'} className={tab==='audio'?'active':''} onClick={()=>setTab('audio')}>语音</button>
    </div>
    <section className="media-compose" aria-label={tab==='image'?'生成图片':'生成语音'}>
      <div className="card-heading"><div><strong>{tab==='image'?'生成一张图片':'生成一段语音'}</strong><small>内容保存在本机，可发送到当前聊天</small></div><span className="media-config-note">使用默认模型</span></div>
      <label>{tab==='image'?'画面描述':'朗读文字'}<textarea rows={3} maxLength={tab==='image'?4000:4096} value={text} onChange={e=>setText(e.target.value)} placeholder={tab==='image'?'例如：傍晚的海边，角色回头看向镜头':'输入要朗读的文字'}/></label>
      {tab==='audio' && <label>音色<input value={voice} onChange={e=>setVoice(e.target.value)}/></label>}
      <div className="media-compose-actions">
        <button className="btn-primary" disabled={busy||!text.trim()} onClick={()=>void generate()}>{busy?'生成中…':tab==='image'?'生成图片':'生成语音'}</button>
        {busy && <button className="btn-quiet" type="button" onClick={()=>app.cancelMedia(conversationId)}>取消</button>}
      </div>
    </section>
    <div className="media-section-heading"><strong>{tab==='image'?'已生成的图片':'已生成的语音'}</strong><span>{items.filter(a=>a.kind===tab).length} 项</span></div>
    <div className={tab==='image'?'media-grid':'media-list'}>{items.filter(a=>a.kind===tab).map(a=><div className="media-card" key={a.id}>
        {a.status==='ready'?<MediaAttachment app={app} assetId={a.id}/>:<p className="media-error">{a.status==='pending'?'上次生成尚未完成':a.error}</p>}
        <p className="hint">{a.prompt}</p><div className="actions">
          {conversationId && a.status==='ready' && <button className="btn-secondary" type="button" disabled={!!sending||!!deleting} onClick={()=>void send(a.id)}>{sending===a.id?'发送中…':'发送到聊天'}</button>}
          {a.status==='failed' && <button className="btn-quiet" type="button" disabled={!!deleting} onClick={()=>setText(a.prompt)}>填入重试</button>}
          <button className="btn-danger media-delete" type="button" disabled={!!deleting||!!sending} onClick={()=>void remove(a)}>{deleting===a.id?'删除中…':'删除'}</button>
        </div></div>)}</div>
    {!items.some(a=>a.kind===tab) && <div className="media-empty"><strong>{tab==='image'?'还没有图片':'还没有语音'}</strong><p>填写上方内容生成后，会出现在这里。</p></div>}
  </div></div>
}
