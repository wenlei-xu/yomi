import { useEffect, useState } from 'react'
import type { AppApi } from '../app/bootstrap'
import type { Actor, Conversation, ConversationMemorySource, SummaryEntry } from '../domain/types'

type Notify = (notice: { text: string; tone: 'ok' | 'error' }) => void
const reason = (error: unknown) => error instanceof Error ? error.message : '读取失败'

export function ConversationMemoryPanel({ app, conversation, members, notify }: {
  app: AppApi; conversation: Conversation; members: Actor[]; notify: Notify
}) {
  const [agentId,setAgentId]=useState('')
  useEffect(()=>{if (!members.some(member=>member.id===agentId)) setAgentId(members[0]?.id ?? '')},[members,agentId])
  return <details className="settings-card">
    <summary>摘要时间线与会话关联</summary>
    {!members.length ? <p className="hint">添加角色后可查看摘要、关联会话。</p> : <>
      <label>查看角色<select value={agentId} onChange={event=>setAgentId(event.target.value)}>
        {members.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}
      </select></label>
      {agentId && <MemoryDetails key={agentId} app={app} conversation={conversation} agentId={agentId} notify={notify}/>}
    </>}
  </details>
}

function MemoryDetails({app,conversation,agentId,notify}:{app:AppApi;conversation:Conversation;agentId:string;notify:Notify}) {
  const [entries,setEntries]=useState<SummaryEntry[]>([])
  const [sources,setSources]=useState<ConversationMemorySource[]>([])
  const [selected,setSelected]=useState<string[]>([])
  const [saved,setSaved]=useState<string[]>([])
  const [ready,setReady]=useState(false)
  const [error,setError]=useState('')
  const [revision,setRevision]=useState(0)
  const [busy,setBusy]=useState(false)
  const [paging,setPaging]=useState(false)
  const [hasMore,setHasMore]=useState(false)
  useEffect(()=>{
    let active=true
    setReady(false);setError('');setEntries([])
    void Promise.all([app.summaryTimeline(conversation.id,agentId),app.conversationMemorySources(conversation.id,agentId)])
      .then(([timeline,available])=>{
        if(!active)return
        const ids=available.filter(source=>source.linked).map(source=>source.id)
        setEntries(timeline);setHasMore(timeline.length===20);setSources(available)
        setSelected(ids);setSaved(ids);setReady(true)
      },error=>{if(active)setError(reason(error))})
    return()=>{active=false}
  },[app,conversation.id,agentId,revision])
  const dirty=selected.length!==saved.length || selected.some(id=>!saved.includes(id))
  return <>
    <div className="card-heading"><h4>摘要时间线</h4><button type="button" disabled={busy||paging} onClick={()=>setRevision(value=>value+1)}>重新加载</button></div>
    {error && <p className="hint" role="alert">{error}</p>}
    {!ready&&!error && <p className="hint" role="status">正在读取摘要和关联…</p>}
    {ready && <>
      <p className="hint">按消息区间查看每次新增段落，展开可看当时的累计摘要。修改历史后，旧记录会标为失效并保留供查阅。</p>
      {!entries.length && <p className="hint">还没有摘要。消息达到 80 条后，角色回应时会自动整理较早的对话，保留最近消息原文。</p>}
      {entries.map(entry=><details className="memory" key={entry.id}>
        <summary>第 {entry.startSequence}～{entry.throughSequence} 条 · {entry.kind==='segment'?'分段摘要':'累计快照'}{!entry.valid?' · 已失效':''}</summary>
        <small>{new Date(entry.createdAt).toLocaleString()}</small>
        <p style={{whiteSpace:'pre-wrap'}}>{entry.body}</p>
        {entry.kind==='segment' && <details><summary>查看当时的累计摘要（第 {entry.cumulativeStartSequence}～{entry.throughSequence} 条）</summary>
          <p style={{whiteSpace:'pre-wrap'}}>{entry.cumulativeBody}</p></details>}
      </details>)}
      {hasMore && <button type="button" disabled={paging||busy} onClick={async()=>{
        setPaging(true)
        try {
          const older=await app.summaryTimeline(conversation.id,agentId,entries.at(-1)?.throughSequence)
          setEntries(current=>[...current,...older.filter(entry=>!current.some(old=>old.id===entry.id))])
          setHasMore(older.length===20)
        }catch(error){notify({text:reason(error),tone:'error'})}finally{setPaging(false)}
      }}>{paging?'正在读取…':'加载更早摘要'}</button>}
      <h4>本会话的记忆来源</h4>
      <p className="hint">勾选其他会话后，该角色在这里回应时会参考自己的来源摘要、会话记忆和最近 6 条可见消息。最多关联 8 个来源；其他角色不直接获得这些资料。</p>
      {conversation.originConversationId && <p className="hint">这是重新生成的分支，默认不继承会话关联。手动关联会允许角色参考所选会话的当前背景。</p>}
      {sources.map(source=><label className="world-check" key={source.id}>
        <input type="checkbox" checked={selected.includes(source.id)}
          disabled={busy || (!selected.includes(source.id) && (!source.available || selected.length>=8))}
          onChange={event=>{const checked=event.target.checked;setSelected(current=>checked ? [...current,source.id] : current.filter(id=>id!==source.id))}}/>
        {source.title}{!source.available?' · 已离开，关联暂不生效':''}
      </label>)}
      {!sources.length && <p className="hint">该角色还没有其他可关联的会话。</p>}
      <div className="actions"><button type="button" disabled={busy||!dirty} onClick={async()=>{
        if(busy)return
        setBusy(true)
        try{await app.setConversationMemorySources(conversation.id,agentId,selected);setSaved([...selected]);notify({text:'会话记忆来源已保存',tone:'ok'})}
        catch(error){notify({text:reason(error),tone:'error'})}finally{setBusy(false)}
      }}>{busy?'保存中…':'保存会话关联'}</button>
      <button type="button" disabled={busy||!dirty} onClick={()=>setSelected([...saved])}>撤销关联选择</button></div>
      <p className="hint">关联方向为“所选来源 → 本会话”，保存后用于后续生成。取消勾选并保存可停止引用，原会话和记忆会保留。</p>
    </>}
  </>
}
