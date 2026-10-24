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
    {error && <p className="hint" role="alert">{error} <button className="text-button" type="button" onClick={() => setReload(value => value + 1)}>重新加载</button></p>}
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
      <button className="btn-primary" type="button" disabled={!ready || busy || !dirty} onClick={async () => {
        if (!ready || busy) return
        setBusy(true)
        try {
          await app.setActorLorebooks(actorId, ids)
          setSavedIds([...ids])
          notify({ text: '角色世界书绑定已保存', tone: 'ok' })
        } catch (e) { notify({ text: reason(e), tone: 'error' }) }
        finally { setBusy(false) }
      }}>{busy ? '保存中…' : '保存角色世界书'}</button>
      <button className="btn-quiet" type="button" disabled={!ready || busy || !dirty} onClick={() => setIds([...savedIds])}>撤销选择</button>
      <button className="btn-secondary" type="button" disabled={!ready || busy} onClick={() => setManage(true)}>管理世界书</button>
    </div>
    <p className="hint">取消勾选并保存即可解除角色绑定，卷和条目会保留。已停用的卷保留绑定，重新启用后恢复使用；全局卷和会话绑定继续按各自范围生效。</p>
    {manage && <LorebookSheet app={app} notify={notify} close={() => { void refreshBooks() }} />}
  </details>
}

export function WorldBookBindings({ app, conversationId, notify }: { app: AppApi; conversationId: string; notify: Notify }) {
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
    void Promise.all([app.lorebooks(), app.conversationLorebooks(conversationId)]).then(([all, selected]) => {
      if (!active) return
      const selectedIds = selected.map(book => book.id)
      setBooks(all); setIds(selectedIds); setSavedIds(selectedIds); setReady(true)
    }, error => { if (active) setError(reason(error)) })
    return () => { active = false }
  }, [app, conversationId, reload])
  const dirty = ids.length !== savedIds.length || ids.some(id => !savedIds.includes(id))
  const refreshBooks = async () => {
    setManage(false); setReady(false); setError('')
    try {
      const all = await app.lorebooks(), available = new Set(all.map(book => book.id))
      setBooks(all)
      setIds(current => current.filter(id => available.has(id)))
      setSavedIds(current => current.filter(id => available.has(id)))
      setReady(true)
    } catch (error) { setError(reason(error)) }
  }
  return <details className="settings-card world-bindings">
    <summary>会话世界书 · {ready ? `${savedIds.length} 卷绑定` : '正在加载'}</summary>
    <p className="hint">全局卷自动生效；勾选的局部卷用于此聊天。角色自己的绑定仍在角色资料中管理。</p>
    {error && <p className="hint" role="alert">{error} <button className="text-button" type="button" onClick={() => setReload(value => value + 1)}>重新加载</button></p>}
    {!error && !ready && <p className="hint" role="status">正在读取世界书…</p>}
    {ready && books.map(book => <label className="world-check" key={book.id}>
      <input type="checkbox" disabled={busy || book.scope === 'global'} checked={book.scope === 'global' || ids.includes(book.id)}
        onChange={event => setIds(current => event.target.checked
          ? [...current, book.id] : current.filter(id => id !== book.id))} />
      {book.title}{book.scope === 'global' ? '（全局生效）' : ''}{!book.enabled ? ' · 已停用' : ''}
    </label>)}
    {ready && !books.length && <p className="hint">还没有世界书。先新建一卷，再回来绑定到此会话。</p>}
    <div className="actions">
      <button className="btn-primary" type="button" disabled={!ready || busy || !dirty} onClick={async () => {
        if (!ready || busy) return
        setBusy(true)
        try {
          await app.setConversationLorebooks(conversationId, ids)
          setSavedIds([...ids])
          notify({ text: '会话世界书绑定已保存', tone: 'ok' })
        } catch (error) { notify({ text: reason(error), tone: 'error' }) }
        finally { setBusy(false) }
      }}>{busy ? '保存中…' : '保存会话世界书'}</button>
      <button className="btn-quiet" type="button" disabled={!ready || busy || !dirty} onClick={() => setIds([...savedIds])}>撤销选择</button>
      <button className="btn-secondary" type="button" disabled={!ready || busy} onClick={() => setManage(true)}>管理世界书</button>
    </div>
    <p className="hint">取消勾选并保存即可解除会话绑定，卷和条目会保留。全局卷与角色绑定继续按各自范围生效。</p>
    {manage && <LorebookSheet app={app} notify={notify} close={() => { void refreshBooks() }} />}
  </details>
}

export function LorebookSheet({app,close,notify}:{app:AppApi;close:()=>void;notify:Notify}) {
  const [books,setBooks]=useState<Lorebook[]>([])
  const [selected,setSelected]=useState<Lorebook|null>(null)
  const [entries,setEntries]=useState<LorebookEntry[]>([])
  const [entry,setEntry]=useState<Partial<LorebookEntry>|null>(null)
  const [entryBaseline,setEntryBaseline]=useState<Partial<LorebookEntry>|null>(null)
  const [busy,setBusy]=useState(false)
  const [ready,setReady]=useState(false)
  const [metaDirty,setMetaDirty]=useState(false)
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
  const entryDirty=!!entry && JSON.stringify(entry)!==JSON.stringify(entryBaseline)
  const confirmDiscard=()=>!metaDirty&&!entryDirty || confirm(entryDirty?'当前条目还有未保存的修改，确定放弃？':'当前世界书还有未保存的修改，确定放弃？')
  const openEntry=(next:Partial<LorebookEntry>|null)=>{
    if(entryDirty&&!confirm('当前条目还有未保存的修改，确定放弃？'))return
    setEntry(next);setEntryBaseline(next?{...next}:null)
  }
  const cancelEntry=()=>{
    if(entryDirty&&!confirm('当前条目还有未保存的修改，确定放弃？'))return
    setEntry(null);setEntryBaseline(null)
  }
  const selectBook=(book:Lorebook|null)=>{
    if(!confirmDiscard())return
    setMetaDirty(false);setSelected(book);setEntry(null);setEntryBaseline(null)
  }
  const closeSheet=()=>{
    if(!confirmDiscard())return
    close()
  }
  return <div className="sheet-backdrop" onClick={closeSheet}><div className="sheet tall lorebook-sheet" onClick={e=>e.stopPropagation()}>
    <div className="sheet-handle"/><div className="sheet-heading"><div><h3>世界书</h3><p>世界书负责背景设定；角色和会话决定它在哪些聊天中生效。</p></div><button className="sheet-close" type="button" aria-label="关闭世界书" onClick={closeSheet}><CloseIcon/></button></div>
    <div className="lorebook-toolbar">
      <button className="btn-primary" type="button" disabled={busy} onClick={()=>selectBook({id:'',title:'',description:'',scope:'conversation',conversationId:null,enabled:true,entryCount:0,createdAt:0,updatedAt:0})}><span aria-hidden="true">＋</span>新建世界书</button>
      <label className="btn-quiet file-button">导入 JSON<input type="file" accept=".json" disabled={busy} onChange={e=>{
        const file=e.target.files?.[0];e.target.value='';if(!file)return
        if(file.size>16000000){notify({text:'文件超过 16 MB',tone:'error'});return}
        if(!confirmDiscard())return
        void run(async()=>{const b=await app.importWorldBook(await file.text());setMetaDirty(false);setSelected(b);notify({text:'已导入为局部卷，可在会话或角色资料中绑定。高级扩展保留在导出数据中。',tone:'ok'})})
      }}/></label>
    </div>
    <div className="lorebook-workspace">
      <aside className="lorebook-browser" aria-label="世界书列表">
        <div className="lorebook-browser-heading"><strong>全部世界书</strong><span>{books.length}</span></div>
        <div className="lorebook-list">{books.map(b=><button className="world-book-row" type="button" aria-pressed={selected?.id===b.id} key={b.id} onClick={()=>selectBook({...b})}>
          <span className="world-book-mark" aria-hidden="true">{b.scope==='global'?'G':'L'}</span>
          <span><strong>{b.title}</strong><small>{b.scope==='global'?'全局生效':'局部卷'} · {b.entryCount} 条</small></span>
          <i className={b.enabled?'enabled':'disabled'}>{b.enabled?'启用':'停用'}</i>
        </button>)}
        {!books.length && <div className="lorebook-empty"><strong>还没有世界书</strong><p>新建一卷，或导入 Tavern 格式的 JSON。</p></div>}
        </div>
      </aside>
      {selected ? <section className="lorebook-editor" aria-label={selected.id ? '编辑世界书' : '新建世界书'}>
        <header className="lorebook-editor-heading"><div><span>{selected.id ? '卷设置' : '新世界书'}</span><h4>{selected.title || '未命名世界书'}</h4>{metaDirty&&<small className="lorebook-unsaved">有未保存的修改</small>}</div>
          <span className={'lorebook-state ' + (selected.enabled ? 'enabled' : 'disabled')}>{selected.enabled ? '已启用' : '已停用'}</span></header>
        <div className="lorebook-meta">
          <label>名称<input value={selected.title} maxLength={120} onChange={e=>{setMetaDirty(true);setSelected({...selected,title:e.target.value})}}/></label>
          <label>说明<textarea rows={2} value={selected.description} onChange={e=>{setMetaDirty(true);setSelected({...selected,description:e.target.value})}}/></label>
          <div className="two-cols">
            <label>生效范围<select value={selected.scope} onChange={e=>{setMetaDirty(true);setSelected({...selected,scope:e.target.value as Lorebook['scope']})}}>
              <option value="conversation">局部 · 绑定后使用</option><option value="global">全局 · 所有聊天</option>
            </select></label>
            <label className="switch-row world-switch"><span>启用此卷</span><input type="checkbox" checked={selected.enabled} onChange={e=>{setMetaDirty(true);setSelected({...selected,enabled:e.target.checked})}}/></label>
          </div>
          <p className="lorebook-scope-help">{selected.scope==='global'?'全局卷会自动进入所有聊天。':'局部卷不会自动生效，需要在本会话或角色资料中绑定。'}</p>
        </div>
        <div className="lorebook-editor-actions">
          <button className="btn-primary" type="button" disabled={busy || !selected.title.trim() || (!!selected.id && !metaDirty)} onClick={()=>void run(async()=>{setSelected(await app.saveLorebook({...selected,id:selected.id||undefined}));setMetaDirty(false)})}>{busy?'保存中…':selected.id&&!metaDirty?'已保存':'保存世界书'}</button>
          {selected.id && <button className="btn-quiet" type="button" disabled={busy} onClick={()=>void run(async()=>notify({text:'已导出：'+await app.exportWorldBook(selected.id),tone:'ok'}))}>导出 JSON</button>}
          {selected.id && <button className="btn-danger" type="button" disabled={busy} onClick={()=>{if(confirm(`删除“${selected.title}”及其中全部条目？此操作不可撤销。`))void run(async()=>{await app.deleteLorebook(selected.id);setMetaDirty(false);setSelected(null)})}}>删除卷</button>}
        </div>
        {selected.id && ready && <section className="lorebook-entries-section">
          <div className="lorebook-section-heading"><div><h4>内容条目 <span>{entries.length}</span></h4><p>常驻条目每次注入；关键词条目匹配最近 12 条消息。</p></div>
            <button className="btn-secondary" type="button" disabled={busy} onClick={()=>openEntry({title:'',content:'',keywords:[],secondaryKeywords:[],enabled:true,constant:true,selective:false,caseSensitive:false,ordinal:entries.length})}><span aria-hidden="true">＋</span>添加条目</button></div>
          <div className="lorebook-entries">{entries.map(e=><article className="lorebook-entry" key={e.id}>
            <div className="card-heading"><div><strong>{e.title||'未命名条目'}</strong><small>{e.enabled?'启用':'停用'} · {e.constant?'常驻注入':'关键词：'+e.keywords.join('、')}</small></div>
              <button className="btn-quiet" type="button" onClick={()=>openEntry({...e})}>编辑</button></div>
            <p>{e.content}</p>
            {!e.enabled&&<span className="lorebook-entry-disabled">此条目不会进入上下文</span>}</article>)}
            {!entries.length && <p className="lorebook-entries-empty">这卷还没有条目。</p>}
          </div>
        </section>}
        {selected.id && entry && <section className="lorebook-entry-form">
          <div className="lorebook-section-heading"><div><span className="lorebook-entry-kicker">条目编辑</span><h4>{entry.id ? '编辑条目' : '新条目'}</h4><p>这里保存的是单个条目，不会同时保存上方卷设置。</p></div>
            <button className="sheet-close" type="button" aria-label="关闭条目编辑" onClick={cancelEntry}><CloseIcon/></button></div>
        {entryDirty && <p className="lorebook-unsaved" role="status">条目有未保存的修改</p>}
        <label>条目标题<input value={entry.title||''} onChange={e=>setEntry({...entry,title:e.target.value})}/></label>
        <label>内容<textarea rows={5} value={entry.content||''} maxLength={65536} onChange={e=>setEntry({...entry,content:e.target.value})}/></label>
        <label>关键词（逗号分隔）<input value={entry.keywords?.join(',')||''} onChange={e=>setEntry({...entry,keywords:e.target.value.split(/[,，]/)})}/></label>
        <label>附加关键词<input value={entry.secondaryKeywords?.join(',')||''} onChange={e=>setEntry({...entry,secondaryKeywords:e.target.value.split(/[,，]/)})}/></label>
        <label>注入顺序<input type="number" value={entry.ordinal??0} onChange={e=>setEntry({...entry,ordinal:Number(e.target.value)})}/></label>
        {(['enabled','constant','selective','caseSensitive'] as const).map((key,i)=><label className="world-check" key={key}>
          <input type="checkbox" checked={!!entry[key]} onChange={e=>setEntry({...entry,[key]:e.target.checked})}/>
          {['启用','常驻注入','同时匹配附加关键词','区分大小写'][i]}</label>)}
        {!entry.constant && !entry.keywords?.some(k=>k.trim()) && <p className="hint">请填写关键词；无关键词的非常驻条目不会被触发。</p>}
        <div className="lorebook-editor-actions"><button className="btn-primary" type="button" disabled={busy||!entry.content?.trim()||(!entryDirty&&!!entry.id)} onClick={()=>void run(async()=>{
          await app.saveLorebookEntry({...entry,lorebookId:selected.id,content:entry.content!});await reloadEntries();setEntry(null);setEntryBaseline(null)
        })}>{busy?'保存中…':entry.id&&!entryDirty?'已保存':'保存条目'}</button><button className="btn-quiet" type="button" onClick={cancelEntry}>取消</button>
        {entry.id && <button className="btn-danger" type="button" disabled={busy} onClick={()=>{if(confirm(`删除条目“${entry.title||'未命名条目'}”？`))void run(async()=>{await app.deleteLorebookEntry(entry.id!);await reloadEntries();setEntry(null);setEntryBaseline(null)})}}>删除条目</button>}</div>
      </section>}
      </section> : <section className="lorebook-editor lorebook-editor-placeholder"><strong>选择一卷世界书</strong><p>从列表选择已有内容，或新建一卷开始编辑。</p></section>}
    </div>
  </div></div>
}
