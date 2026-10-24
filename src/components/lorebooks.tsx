import { useEffect, useState } from 'react'
import type { AppApi } from '../app/bootstrap'
import type { Lorebook, LorebookEntry } from '../domain/types'
import { CloseIcon } from './icons'

type Notify = (notice: { text: string; tone: 'ok' | 'error' }) => void
const reason = (e: unknown) => e instanceof Error ? e.message : '操作失败'

export function ActorWorldBookBindings({ app, actorId, notify }: { app: AppApi; actorId: string; notify: Notify }) {
  const [books, setBooks] = useState<Lorebook[]>([])
  const [ids, setIds] = useState<string[]>([])
  const [savedIds, setSavedIds] = useState<string[]>([])
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [manage, setManage] = useState(false)
  useEffect(() => {
    let active = true
    setReady(false); setError('')
    void Promise.all([app.lorebooks(), app.actorLorebooks(actorId)]).then(([all, selected]) => {
      if (!active) return
      const selectedIds = selected.map(book => book.id)
      setBooks(all); setIds(selectedIds); setSavedIds(selectedIds); setReady(true)
    }, e => { if (active) setError(reason(e)) })
    return () => { active = false }
  }, [app, actorId, reload])
  const dirty = ids.length !== savedIds.length || ids.some(id => !savedIds.includes(id))
  const refreshBooks = async () => {
    setManage(false); setReady(false); setError('')
    try {
      const all = await app.lorebooks(), available = new Set(all.map(book => book.id))
      setBooks(all)
      setIds(current => current.filter(id => available.has(id)))
      setSavedIds(current => current.filter(id => available.has(id)))
      setReady(true)
    } catch (e) { setError(reason(e)) }
  }
  return <details className="settings-card">
    <summary>角色世界书 · {ready ? `${savedIds.length} 卷绑定` : '正在加载'}</summary>
    <p className="hint">勾选的局部卷用于这个角色参与的所有聊天，同一卷可绑定多个角色。全局卷自动生效。</p>
    {error && <p className="hint" role="alert">{error} <button type="button" onClick={() => setReload(value => value + 1)}>重新加载</button></p>}
    {!error && !ready && <p className="hint" role="status">正在读取世界书…</p>}
    {ready && books.map(book => <label className="world-check" key={book.id}>
      <input type="checkbox" disabled={busy || book.scope === 'global'}
        checked={book.scope === 'global' || ids.includes(book.id)}
        onChange={event => setIds(current => event.target.checked
          ? [...current, book.id] : current.filter(id => id !== book.id))} />
      {book.title}{book.scope === 'global' ? '（全局生效）' : ''}{!book.enabled ? ' · 已停用' : ''}
    </label>)}
    {ready && !books.length && <p className="hint">还没有世界书，可先在下方管理入口创建或导入。</p>}
    <div className="actions">
      <button type="button" disabled={!ready || busy || !dirty} onClick={async () => {
        if (!ready || busy) return
        setBusy(true)
        try {
          await app.setActorLorebooks(actorId, ids)
          setSavedIds([...ids])
          notify({ text: '角色世界书绑定已保存', tone: 'ok' })
        } catch (e) { notify({ text: reason(e), tone: 'error' }) }
        finally { setBusy(false) }
      }}>{busy ? '保存中…' : '保存角色世界书'}</button>
      <button type="button" disabled={!ready || busy || !dirty} onClick={() => setIds([...savedIds])}>撤销选择</button>
      <button type="button" disabled={!ready || busy} onClick={() => setManage(true)}>管理世界书</button>
    </div>
    <p className="hint">取消勾选并保存即可解除角色绑定，卷和条目会保留。已停用的卷保留绑定，重新启用后恢复使用；全局卷和会话绑定继续按各自范围生效。</p>
    {manage && <LorebookSheet app={app} notify={notify} close={() => { void refreshBooks() }} />}
  </details>
}

export function WorldBookBindings({ app, conversationId, notify }: { app: AppApi; conversationId: string; notify: Notify }) {
  const [books, setBooks] = useState<Lorebook[]>([])
  const [ids, setIds] = useState<string[]>([])
  const [busy,setBusy]=useState(false)
  const [manage,setManage]=useState(false)
  useEffect(() => { let active=true
    void Promise.all([app.lorebooks(),app.conversationLorebooks(conversationId)]).then(([all,selected]) => {
      if (active) { setBooks(all);setIds(selected.map(b => b.id)) }
    },e => notify({text:reason(e),tone:'error'}))
    return () => { active=false }
  },[app,conversationId,manage])
  return <div className="settings-card">
    <div className="card-heading"><h4>会话世界书</h4><button className="text-button" onClick={() => setManage(true)}>管理</button></div>
    <p className="hint">全局卷自动生效；勾选的卷用于此聊天。角色绑定的卷只向对应角色提供，可在角色资料中管理。</p>
    {books.map(b => <label className="world-check" key={b.id}>
      <input type="checkbox" disabled={b.scope==='global' || busy} checked={b.scope==='global' || ids.includes(b.id)}
        onChange={e => setIds(v => e.target.checked ? [...v,b.id]:v.filter(id => id!==b.id))} />
      {b.title} {b.scope==='global' ? '（全局）':''}{!b.enabled ? ' · 已停用':''}
    </label>)}
    <button className="wide-primary" disabled={busy} onClick={async () => {
      setBusy(true)
      try { await app.setConversationLorebooks(conversationId,ids);notify({text:'世界书绑定已保存',tone:'ok'}) }
      catch(e) { notify({text:reason(e),tone:'error'}) } finally { setBusy(false) }
    }}>保存世界书绑定</button>
    {manage && <LorebookSheet app={app} notify={notify} close={() => setManage(false)} />}
  </div>
}

export function LorebookSheet({app,close,notify}:{app:AppApi;close:()=>void;notify:Notify}) {
  const [books,setBooks]=useState<Lorebook[]>([])
  const [selected,setSelected]=useState<Lorebook|null>(null)
  const [entries,setEntries]=useState<LorebookEntry[]>([])
  const [entry,setEntry]=useState<Partial<LorebookEntry>|null>(null)
  const [busy,setBusy]=useState(false)
  const [ready,setReady]=useState(false)
  const refresh=async()=>setBooks(await app.lorebooks())
  useEffect(()=>{void refresh().catch(e=>notify({text:reason(e),tone:'error'}))},[app])
  useEffect(()=>{let active=true;setReady(false);setEntry(null);setEntries([])
    if(selected?.id) void app.lorebookEntries(selected.id).then(v=>{if(active){setEntries(v);setReady(true)}},e=>notify({text:reason(e),tone:'error'}))
    else setReady(true)
    return ()=>{active=false}
  },[app,selected?.id])
  const run=async(work:()=>Promise<unknown>)=>{if(busy)return;setBusy(true)
    try{await work();await refresh()}catch(e){notify({text:reason(e),tone:'error'})}finally{setBusy(false)}}
  const reloadEntries=async()=>{if(selected?.id)setEntries(await app.lorebookEntries(selected.id))}
  return <div className="sheet-backdrop" onClick={close}><div className="sheet tall" onClick={e=>e.stopPropagation()}>
    <div className="sheet-handle"/><div className="sheet-heading"><h3>世界书</h3><button className="sheet-close" onClick={close}><CloseIcon/></button></div>
    <p className="hint">记录世界背景与规则。常驻条目每次注入；关键词条目扫描最近可见的 12 条消息。超出上下文预算的条目会略过。</p>
    <div className="actions">
      <button disabled={busy} onClick={()=>{setSelected({id:'',title:'',description:'',scope:'conversation',conversationId:null,enabled:true,entryCount:0,createdAt:0,updatedAt:0});setEntry(null)}}>新建世界书</button>
      <label className="file-button">导入 JSON<input type="file" accept=".json" disabled={busy} onChange={e=>{
        const file=e.target.files?.[0];e.target.value='';if(!file)return
        if(file.size>16000000){notify({text:'文件超过 16 MB',tone:'error'});return}
        void run(async()=>{const b=await app.importWorldBook(await file.text());setSelected(b);notify({text:'已导入为局部卷，可在会话或角色资料中绑定。高级扩展保留在导出数据中。',tone:'ok'})})
      }}/></label>
    </div>
    <div className="lorebook-list">{books.map(b=><button className="world-book-row" key={b.id} onClick={()=>setSelected({...b})}>
      <strong>{b.title}</strong><small>{b.scope==='global'?'全局':'局部'} · {b.entryCount} 条 · {b.enabled?'启用':'停用'}</small>
    </button>)}</div>
    {selected && <div className="settings-card">
      <label>名称<input value={selected.title} maxLength={120} onChange={e=>setSelected({...selected,title:e.target.value})}/></label>
      <label>说明<textarea value={selected.description} onChange={e=>setSelected({...selected,description:e.target.value})}/></label>
      <label>生效范围<select value={selected.scope} onChange={e=>setSelected({...selected,scope:e.target.value as Lorebook['scope']})}>
        <option value="conversation">局部 · 绑定聊天或角色后使用</option><option value="global">全局 · 所有角色和聊天</option>
      </select></label>
      <label className="world-check"><input type="checkbox" checked={selected.enabled} onChange={e=>setSelected({...selected,enabled:e.target.checked})}/>启用此卷</label>
      <div className="actions"><button disabled={busy || !selected.title.trim()} onClick={()=>void run(async()=>setSelected(await app.saveLorebook({...selected,id:selected.id||undefined})))}>保存世界书</button>
        {selected.id && <><button disabled={busy} onClick={()=>void run(async()=>notify({text:'已导出：'+await app.exportWorldBook(selected.id),tone:'ok'}))}>导出 JSON</button>
          <button className="danger-text" disabled={busy} onClick={()=>{if(confirm('删除此卷及全部条目？'))void run(async()=>{await app.deleteLorebook(selected.id);setSelected(null)})}}>删除卷</button></>}
      </div>
      {selected.id && ready && <>
        <button disabled={busy} onClick={()=>setEntry({title:'',content:'',keywords:[],secondaryKeywords:[],enabled:true,constant:true,selective:false,caseSensitive:false,ordinal:entries.length})}>添加条目</button>
        {entries.map(e=><div className="lorebook-entry" key={e.id}><div className="card-heading"><strong>{e.title||'未命名条目'}</strong>
          <button className="text-button" onClick={()=>setEntry({...e})}>编辑</button></div>
          <small>{e.enabled?'启用':'停用'} · {e.constant?'常驻':'关键词：'+e.keywords.join('、')}</small><p>{e.content}</p></div>)}
      </>}
      {selected.id && entry && <div className="lorebook-entry-form">
        <label>条目标题<input value={entry.title||''} onChange={e=>setEntry({...entry,title:e.target.value})}/></label>
        <label>内容<textarea rows={5} value={entry.content||''} maxLength={65536} onChange={e=>setEntry({...entry,content:e.target.value})}/></label>
        <label>关键词（逗号分隔）<input value={entry.keywords?.join(',')||''} onChange={e=>setEntry({...entry,keywords:e.target.value.split(/[,，]/)})}/></label>
        <label>附加关键词<input value={entry.secondaryKeywords?.join(',')||''} onChange={e=>setEntry({...entry,secondaryKeywords:e.target.value.split(/[,，]/)})}/></label>
        <label>注入顺序<input type="number" value={entry.ordinal??0} onChange={e=>setEntry({...entry,ordinal:Number(e.target.value)})}/></label>
        {(['enabled','constant','selective','caseSensitive'] as const).map((key,i)=><label className="world-check" key={key}>
          <input type="checkbox" checked={!!entry[key]} onChange={e=>setEntry({...entry,[key]:e.target.checked})}/>
          {['启用','常驻注入','同时匹配附加关键词','区分大小写'][i]}</label>)}
        {!entry.constant && !entry.keywords?.some(k=>k.trim()) && <p className="hint">请填写关键词；无关键词的非常驻条目不会被触发。</p>}
        <div className="actions"><button disabled={busy||!entry.content?.trim()} onClick={()=>void run(async()=>{
          await app.saveLorebookEntry({...entry,lorebookId:selected.id,content:entry.content!});await reloadEntries();setEntry(null)
        })}>保存条目</button><button onClick={()=>setEntry(null)}>取消</button>
        {entry.id && <button className="danger-text" disabled={busy} onClick={()=>void run(async()=>{await app.deleteLorebookEntry(entry.id!);await reloadEntries();setEntry(null)})}>删除条目</button>}</div>
      </div>}
    </div>}
  </div></div>
}
