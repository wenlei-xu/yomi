import { useEffect, useRef, useState } from 'react'
import type { AppApi } from '../app/bootstrap'
import type { Lorebook, LorebookEntry } from '../domain/types'
import { BackIcon, ChevronRightIcon, CloseIcon, SearchIcon } from './icons'

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
  const globalBooks = books.filter(book => book.scope === 'global')
  const localBooks = books.filter(book => book.scope !== 'global')
  const refreshBooks = async () => {
    setManage(false); setReady(false); setError('')
    try {
      const all = await app.lorebooks(), available = new Set(all.filter(book => book.scope !== 'global').map(book => book.id))
      setBooks(all)
      setIds(current => current.filter(id => available.has(id)))
      setSavedIds(current => current.filter(id => available.has(id)))
      setReady(true)
    } catch (e) { setError(reason(e)) }
  }
  return <details className="settings-card">
    <summary>角色世界书 · {ready ? `${savedIds.length} 卷已绑定` : '正在加载'}</summary>
    <p className="hint">全局卷自动生效；勾选的局部卷会用于这个角色参与的所有聊天。</p>
    {error && <p className="hint" role="alert">{error} <button className="text-button" type="button" onClick={() => setReload(value => value + 1)}>重新加载</button></p>}
    {!error && !ready && <p className="hint" role="status">正在读取世界书…</p>}
    {ready && !!globalBooks.length && <div className="world-binding-group"><strong>全局卷 · 自动生效</strong>{globalBooks.map(book => <div className="world-binding-global" key={book.id}>
      <span>{book.title || '未命名世界书'}</span><small>{book.enabled ? '全局启用' : '已停用'}</small></div>)}</div>}
    {ready && !!localBooks.length && <div className="world-binding-group"><strong>局部卷 · 选择要绑定的内容</strong>{localBooks.map(book => <label className="world-check" key={book.id}>
      <input type="checkbox" disabled={busy} checked={ids.includes(book.id)} onChange={event => setIds(current => event.target.checked
        ? [...current, book.id] : current.filter(id => id !== book.id))} />
      <span className="world-binding-copy"><strong>{book.title || '未命名世界书'}</strong><small>{book.entryCount} 条目{!book.enabled ? ' · 已停用，当前不会生效' : ''}</small></span>
    </label>)}</div>}
    {ready && !books.length && <p className="hint">还没有世界书，先创建一卷设定再回来绑定。</p>}
    {ready && !!books.length && !localBooks.length && <p className="hint">目前只有全局卷；如需只给这个角色使用，请新建局部卷。</p>}
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
      }}>{busy ? '保存中…' : dirty ? '保存绑定' : '绑定已保存'}</button>
      {dirty && <button className="btn-quiet" type="button" disabled={!ready || busy} onClick={() => setIds([...savedIds])}>撤销修改</button>}
      <button className="btn-secondary" type="button" disabled={!ready || busy} onClick={() => setManage(true)}>管理世界书</button>
    </div>
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
  const globalBooks = books.filter(book => book.scope === 'global')
  const localBooks = books.filter(book => book.scope !== 'global')
  const refreshBooks = async () => {
    setManage(false); setReady(false); setError('')
    try {
      const all = await app.lorebooks(), available = new Set(all.filter(book => book.scope !== 'global').map(book => book.id))
      setBooks(all)
      setIds(current => current.filter(id => available.has(id)))
      setSavedIds(current => current.filter(id => available.has(id)))
      setReady(true)
    } catch (error) { setError(reason(error)) }
  }
  return <details className="settings-card world-bindings">
    <summary>会话世界书 · {ready ? `${savedIds.length} 卷已绑定` : '正在加载'}</summary>
    <p className="hint">全局卷自动生效；勾选的局部卷只用于当前聊天。</p>
    {error && <p className="hint" role="alert">{error} <button className="text-button" type="button" onClick={() => setReload(value => value + 1)}>重新加载</button></p>}
    {!error && !ready && <p className="hint" role="status">正在读取世界书…</p>}
    {ready && !!globalBooks.length && <div className="world-binding-group"><strong>全局卷 · 自动生效</strong>{globalBooks.map(book => <div className="world-binding-global" key={book.id}>
      <span>{book.title || '未命名世界书'}</span><small>{book.enabled ? '全局启用' : '已停用'}</small></div>)}</div>}
    {ready && !!localBooks.length && <div className="world-binding-group"><strong>局部卷 · 选择用于本聊天</strong>{localBooks.map(book => <label className="world-check" key={book.id}>
      <input type="checkbox" disabled={busy} checked={ids.includes(book.id)} onChange={event => setIds(current => event.target.checked
        ? [...current, book.id] : current.filter(id => id !== book.id))} />
      <span className="world-binding-copy"><strong>{book.title || '未命名世界书'}</strong><small>{book.entryCount} 条目{!book.enabled ? ' · 已停用，当前不会生效' : ''}</small></span>
    </label>)}</div>}
    {ready && !books.length && <p className="hint">还没有世界书，先创建一卷设定再回来绑定。</p>}
    {ready && !!books.length && !localBooks.length && <p className="hint">目前只有全局卷；如需只用于这个聊天，请新建局部卷。</p>}
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
      }}>{busy ? '保存中…' : dirty ? '保存绑定' : '绑定已保存'}</button>
      {dirty && <button className="btn-quiet" type="button" disabled={!ready || busy} onClick={() => setIds([...savedIds])}>撤销修改</button>}
      <button className="btn-secondary" type="button" disabled={!ready || busy} onClick={() => setManage(true)}>管理世界书</button>
    </div>
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
  const [booksLoading,setBooksLoading]=useState(true)
  const [entriesLoading,setEntriesLoading]=useState(false)
  const [entriesError,setEntriesError]=useState('')
  const [metaDirty,setMetaDirty]=useState(false)
  const [booksError,setBooksError]=useState('')
  const [query,setQuery]=useState('')
  const [filter,setFilter]=useState<'all'|'global'|'local'|'disabled'>('all')
  const page=useRef<HTMLElement>(null)
  const refresh=async()=>{
    const all=await app.lorebooks()
    setBooks(all)
    return all
  }
  useEffect(()=>{
    let active=true
    setBooksLoading(true);setBooksError('')
    void app.lorebooks().then(all=>{if(active)setBooks(all)},e=>{if(active)setBooksError(reason(e))})
      .finally(()=>{if(active)setBooksLoading(false)})
    const previous=document.activeElement
    page.current?.focus()
    return ()=>{active=false;if(previous instanceof HTMLElement&&previous.isConnected)previous.focus()}
  },[app])
  useEffect(()=>{let active=true;setEntriesLoading(!!selected?.id);setEntriesError('');setEntry(null);setEntryBaseline(null);setEntries([])
    if(selected?.id) void app.lorebookEntries(selected.id).then(v=>{if(active)setEntries(v)},e=>{if(active)setEntriesError(reason(e))})
      .finally(()=>{if(active)setEntriesLoading(false)})
    return ()=>{active=false}
  },[app,selected?.id])
  const run=async(work:()=>Promise<unknown>)=>{if(busy)return;setBusy(true)
    try{await work();await refresh()}catch(e){notify({text:reason(e),tone:'error'})}finally{setBusy(false)}}
  const reloadEntries=async()=>{if(selected?.id){setEntriesLoading(true);setEntriesError('')
    try{setEntries(await app.lorebookEntries(selected.id))}catch(e){setEntriesError(reason(e));throw e}finally{setEntriesLoading(false)}}}
  const entryDirty=!!entry && JSON.stringify(entry)!==JSON.stringify(entryBaseline)
  const confirmDiscard=()=>!metaDirty&&!entryDirty || confirm(entryDirty&&metaDirty?'卷设置和条目都有未保存修改，确定放弃？':entryDirty?'当前条目还有未保存的修改，确定放弃？':'当前世界书还有未保存的修改，确定放弃？')
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
  const filteredBooks=books.filter(book=>{
    const matchesFilter=filter==='all'||(filter==='global'?book.scope==='global':filter==='local'?book.scope==='conversation':!book.enabled)
    const needle=query.trim().toLocaleLowerCase()
    return matchesFilter&&(!needle||`${book.title} ${book.description}`.toLocaleLowerCase().includes(needle))
  })
  return <section ref={page} tabIndex={-1} className="lorebook-page" aria-labelledby="lorebook-page-title"
    onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();if(entry)cancelEntry();else closeSheet()}}}>
    <header className="lorebook-page-header">
      <button className="icon-button" type="button" aria-label={selected?'返回世界书列表':'返回'} disabled={busy} onClick={()=>selected?selectBook(null):closeSheet()}><BackIcon/></button>
      <div><h2 id="lorebook-page-title">{selected?(selected.title||'新建世界书'):'世界书'}</h2><p>{selected?'编辑卷设置与内容条目':'按主题整理设定，搜索并管理已创建的世界书'}</p></div>
      <span className="lorebook-total">{books.length} 卷</span>
    </header>
    {!selected&&<div className="lorebook-toolbar">
      <div className="lorebook-search" role="search" aria-label="搜索世界书"><SearchIcon/><input aria-label="搜索世界书" value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索卷名称或说明"/>
        {query&&<button type="button" aria-label="清除搜索" onClick={()=>setQuery('')}><CloseIcon/></button>}</div>
      <button className="btn-primary" type="button" disabled={busy} onClick={()=>selectBook({id:'',title:'',description:'',scope:'conversation',conversationId:null,enabled:true,entryCount:0,createdAt:0,updatedAt:0})}><span aria-hidden="true">＋</span>新建世界书</button>
      <label className="btn-quiet file-button">导入 JSON<input type="file" accept=".json" disabled={busy} onChange={e=>{
        const file=e.target.files?.[0];e.target.value='';if(!file)return
        if(file.size>16000000){notify({text:'文件超过 16 MB',tone:'error'});return}
        if(!confirmDiscard())return
        void run(async()=>{const b=await app.importWorldBook(await file.text());setMetaDirty(false);setSelected(b);notify({text:'已导入为局部卷，可在会话或角色资料中绑定。高级扩展保留在导出数据中。',tone:'ok'})})
      }}/></label>
    </div>}
    {selected ? <section className="lorebook-detail-page" aria-label={selected.id ? '编辑世界书' : '新建世界书'}>
      <div className="lorebook-detail-scroll">
        <header className="lorebook-editor-heading"><div><span>{selected.scope==='global'?'全局世界书':'局部世界书'} · {selected.id?'卷设置':'新建'}</span>
          {(metaDirty||entryDirty)&&<small className="lorebook-unsaved">有未保存的修改</small>}</div>
          <span className={'lorebook-state '+(selected.enabled?'enabled':'disabled')}>{selected.enabled?'已启用':'已停用'}</span></header>
        <section className="lorebook-card">
          <div className="lorebook-section-heading"><div><h4>基本信息</h4><p>设置这卷世界书的名称、用途和生效范围。</p></div></div>
          <div className="lorebook-meta">
            <label>名称<input disabled={busy} value={selected.title} maxLength={120} onChange={event=>{setMetaDirty(true);setSelected({...selected,title:event.target.value})}} placeholder="例如：现代都市设定"/></label>
            <label>说明<textarea disabled={busy} rows={2} value={selected.description} onChange={event=>{setMetaDirty(true);setSelected({...selected,description:event.target.value})}} placeholder="简单写下这卷内容，方便以后辨认"/></label>
            <label>生效范围<select disabled={busy} value={selected.scope} onChange={event=>{setMetaDirty(true);setSelected({...selected,scope:event.target.value as Lorebook['scope']})}}>
              <option value="conversation">局部 · 手动绑定到角色或会话</option><option value="global">全局 · 所有聊天自动生效</option>
            </select></label>
            <p className="lorebook-scope-help">{selected.scope==='global'?'全局卷会自动参与所有聊天。':'局部卷不会自动生效；保存后，在角色资料或聊天设置中绑定。'}</p>
            <label className="switch-row lorebook-enabled-toggle"><span><strong>启用这卷</strong><small>停用后保留内容和绑定，但不会注入聊天</small></span><input type="checkbox" disabled={busy} checked={selected.enabled} onChange={event=>{setMetaDirty(true);setSelected({...selected,enabled:event.target.checked})}}/></label>
          </div>
          <div className="lorebook-editor-actions">
            <button className="btn-primary" type="button" disabled={busy||!selected.title.trim()||!!selected.id&&!metaDirty} onClick={()=>void run(async()=>{setSelected(await app.saveLorebook({...selected,id:selected.id||undefined}));setMetaDirty(false)})}>{busy?'保存中…':selected.id&&!metaDirty?'设置已保存':'保存卷设置'}</button>
            {selected.id&&<button className="btn-quiet" type="button" disabled={busy} onClick={()=>void run(async()=>notify({text:'已导出：'+await app.exportWorldBook(selected.id),tone:'ok'}))}>导出 JSON</button>}
            {selected.id&&<button className="btn-danger" type="button" disabled={busy} onClick={()=>{if(!confirmDiscard())return;if(confirm(`删除“${selected.title}”及其中全部条目？此操作不可撤销。`))void run(async()=>{await app.deleteLorebook(selected.id);setMetaDirty(false);setSelected(null);setEntry(null);setEntryBaseline(null)})}}>删除整卷</button>}
          </div>
        </section>
        {selected.id&&<section className="lorebook-entries-section">
          <div className="lorebook-section-heading"><div><h4>内容条目 <span>{entries.length}</span></h4><p>{metaDirty?'请先保存卷设置，再添加或编辑条目。':'常驻条目会尝试每次注入；关键词条目在聊天内容命中时尝试注入。'}</p></div>
            {!entry&&<button className="btn-secondary" type="button" disabled={busy||!!metaDirty} title={metaDirty?'请先保存卷设置':''} onClick={()=>openEntry({title:'',content:'',keywords:[],secondaryKeywords:[],enabled:true,constant:true,selective:false,caseSensitive:false,ordinal:entries.length})}><span aria-hidden="true">＋</span>添加条目</button>}</div>
          {entriesLoading&&<p className="hint" role="status">正在读取条目…</p>}
          {entriesError&&<p className="hint" role="alert">{entriesError} <button type="button" className="text-button" onClick={()=>void reloadEntries().catch(error=>notify({text:reason(error),tone:'error'}))}>重试</button></p>}
          {entry&&<section className="lorebook-entry-form">
            <div className="lorebook-section-heading"><div><span className="lorebook-entry-kicker">条目设置</span><h4>{entry.id?'编辑条目':'新建条目'}</h4><p>保存条目不会自动保存上方的卷设置。</p></div>
              <button className="btn-quiet" type="button" aria-label="返回条目列表" onClick={cancelEntry}><BackIcon/>返回列表</button></div>
            {entryDirty&&<p className="lorebook-unsaved" role="status">条目有未保存的修改</p>}
            <label>条目标题<input disabled={busy} value={entry.title||''} onChange={event=>setEntry({...entry,title:event.target.value})} placeholder="给这条设定一个便于识别的标题"/></label>
            <label>设定内容<textarea disabled={busy} rows={7} value={entry.content||''} maxLength={65536} onChange={event=>setEntry({...entry,content:event.target.value})} placeholder="写下要让角色记住的背景信息"/></label>
            <label className="world-check lorebook-toggle-row"><input type="checkbox" disabled={busy} checked={!!entry.enabled} onChange={event=>setEntry({...entry,enabled:event.target.checked})}/><span><strong>启用条目</strong><small>关闭后这条设定不会参与聊天</small></span></label>
            <label className="world-check lorebook-toggle-row"><input type="checkbox" disabled={busy} checked={!!entry.constant} onChange={event=>setEntry({...entry,constant:event.target.checked})}/><span><strong>常驻注入</strong><small>每次回复都尝试加入上下文；关闭后改为关键词触发</small></span></label>
            {!entry.constant&&<>
              <label>触发关键词<input disabled={busy} value={entry.keywords?.join(', ')||''} onChange={event=>setEntry({...entry,keywords:event.target.value.split(/[,，]/)})} placeholder="多个关键词用逗号分隔"/><small className="hint">聊天内容包含任一关键词时，这条设定才会注入。</small></label>
              <label className="world-check lorebook-toggle-row"><input type="checkbox" disabled={busy} checked={!!entry.selective} onChange={event=>setEntry({...entry,selective:event.target.checked})}/><span><strong>同时要求附加关键词</strong><small>主关键词和附加关键词都命中时才触发</small></span></label>
              {entry.selective&&<label>附加关键词<input disabled={busy} value={entry.secondaryKeywords?.join(', ')||''} onChange={event=>setEntry({...entry,secondaryKeywords:event.target.value.split(/[,，]/)})} placeholder="多个关键词用逗号分隔"/></label>}
            </>}
            <details className="lorebook-advanced"><summary>高级选项</summary>
              <label className="world-check lorebook-toggle-row"><input type="checkbox" disabled={busy} checked={!!entry.caseSensitive} onChange={event=>setEntry({...entry,caseSensitive:event.target.checked})}/><span><strong>区分大小写</strong><small>仅影响英文关键词匹配</small></span></label>
              <label>注入顺序<input disabled={busy} type="number" value={entry.ordinal??0} onChange={event=>setEntry({...entry,ordinal:Number(event.target.value)})}/><small className="hint">数字越小越靠前；空间不足时，靠后的条目可能不会加入。</small></label>
            </details>
            {!entry.constant&&!entry.keywords?.some(keyword=>keyword.trim())&&<p className="lorebook-validation" role="status">添加至少一个触发关键词，或开启常驻注入。</p>}
            {!entry.constant&&entry.selective&&!entry.secondaryKeywords?.some(keyword=>keyword.trim())&&<p className="lorebook-validation" role="status">附加关键词已开启，请至少填写一个附加关键词。</p>}
            <div className="lorebook-editor-actions">
              <button className="btn-primary" type="button" disabled={busy||!entry.content?.trim()||(!entry.constant&&!entry.keywords?.some(keyword=>keyword.trim()))||(!entry.constant&&!!entry.selective&&!entry.secondaryKeywords?.some(keyword=>keyword.trim()))||(!entryDirty&&!!entry.id)} onClick={()=>void run(async()=>{await app.saveLorebookEntry({...entry,lorebookId:selected.id,content:entry.content!});await reloadEntries();setEntry(null);setEntryBaseline(null)})}>{busy?'保存中…':entry.id&&!entryDirty?'条目已保存':'保存条目'}</button>
              <button className="btn-quiet" type="button" disabled={busy} onClick={cancelEntry}>取消</button>
              {entry.id&&<button className="btn-danger" type="button" disabled={busy} onClick={()=>{if(confirm(`删除条目“${entry.title||'未命名条目'}”？`))void run(async()=>{await app.deleteLorebookEntry(entry.id!);await reloadEntries();setEntry(null);setEntryBaseline(null)})}}>删除条目</button>}
            </div>
          </section>}
          {!entriesLoading&&!entriesError&&!entry&&<div className="lorebook-entries">
            {entries.map(item=><article className="lorebook-entry" key={item.id}>
              <div className="card-heading"><div><strong>{item.title||'未命名条目'}</strong><small>{item.constant?'常驻注入':`关键词触发 · ${item.keywords.filter(keyword=>keyword.trim()).join('、')||'未设置'}`}</small></div>
                <span className={'lorebook-entry-state'+(item.enabled?'':' disabled')}>{item.enabled?'启用':'停用'}</span></div>
              <p>{item.content}</p>
              <div className="lorebook-entry-actions"><small>{item.selective?'还需匹配附加关键词':''}</small><button className="btn-quiet" type="button" disabled={busy} onClick={()=>openEntry({...item})}>编辑条目</button></div>
            </article>)}
            {!entries.length&&<div className="lorebook-entries-empty"><strong>这卷还没有条目</strong><p>先完成一条设定，再决定它常驻还是按关键词触发。</p></div>}
          </div>}
        </section>}
        {!selected.id&&<div className="lorebook-first-entry"><strong>先保存这卷，再添加内容条目</strong><p>保存后可以继续拆分添加多条设定，并分别设置常驻或关键词触发。</p></div>}
      </div>
    </section> : <section className="lorebook-library-page" aria-label="世界书列表">
      <div className="lorebook-library-heading"><div><h3>你的世界书</h3><p>每一卷都可以包含多条背景设定。</p></div><span>{filteredBooks.length} 卷</span></div>
        <nav className="lorebook-filters" aria-label="筛选世界书">
          {([['all','全部'],['global','全局'],['local','局部'],['disabled','已停用']] as const).map(([id,label])=><button type="button" key={id} aria-pressed={filter===id} onClick={()=>setFilter(id)}>{label}</button>)}
        </nav>
        <div className="lorebook-list">
          {booksLoading&&<p className="lorebook-list-state" role="status">正在读取世界书…</p>}
          {!booksLoading&&booksError&&<div className="lorebook-list-state" role="alert"><p>{booksError}</p><button className="btn-quiet" type="button" onClick={()=>{setBooksLoading(true);setBooksError('');void refresh().catch(e=>setBooksError(reason(e))).finally(()=>setBooksLoading(false))}}>重新加载</button></div>}
          {!booksLoading&&!booksError&&filteredBooks.map(book=><button className="world-book-row" type="button" disabled={busy} key={book.id} onClick={()=>selectBook({...book})}>
            <span className="world-book-mark" aria-hidden="true">{book.scope==='global'?'全':'局'}</span>
            <span className="world-book-row-copy"><strong>{book.title||'未命名世界书'}</strong><small>{book.description||'暂无说明'}</small></span>
            <span className="lorebook-row-meta"><i className={book.enabled?'enabled':'disabled'}>{book.enabled?'启用':'停用'}</i><small>{book.scope==='global'?'全局':'局部'} · {book.entryCount} 条目</small></span>
            <ChevronRightIcon/>
          </button>)}
          {!booksLoading&&!booksError&&!filteredBooks.length&&<div className="lorebook-empty"><strong>{books.length?'没有匹配结果':'还没有世界书'}</strong><p>{books.length?'换个关键词或筛选条件试试。':'新建一卷，或导入 Tavern 格式 JSON。'}</p></div>}
        </div>
      </section>}
  </section>
}
