import React, { useEffect, useRef, useState } from 'react'
import type { AppApi } from '../app/bootstrap'
import type { Actor, Conversation, SearchHit } from '../domain/types'

export function MessageSearch({ app, conversationId, open }: {
  app: AppApi; conversationId?: string; open: (hit: SearchHit) => void
}) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState(conversationId ?? '')
  const [author, setAuthor] = useState('')
  const [actors, setActors] = useState<Actor[]>([])
  const [rooms, setRooms] = useState<Conversation[]>([])
  const [hits, setHits] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [more, setMore] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    let active = true
    void Promise.all([app.actors(), app.conversations(true), app.whispers()]).then(([actors, rooms, whispers]) => {
      if (active) { setActors(actors); setRooms([...rooms, ...whispers]) }
    }).catch(reason => { if (active) setError(String(reason)) })
    return () => { active = false; generation.current++ }
  }, [app])
  const reset = () => { generation.current++; setHits([]); setMore(false); setBusy(false); setSearched(false); setError('') }
  const search = async (append = false) => {
    if (!query.trim()) { reset(); return }
    const ticket = ++generation.current
    setBusy(true); setError('')
    try {
      const results = await app.searchMessages(query, { beforeCreatedAt: append ? hits.at(-1)?.createdAt : undefined,
        beforeId: append ? hits.at(-1)?.id : undefined,
        conversationId: conversationId || scope || undefined, authorId: author || undefined })
      if (ticket !== generation.current) return
      setHits(current => append ? [...current, ...results] : results)
      setMore(results.length === 50); setSearched(true)
    } catch (reason) { if (ticket === generation.current) setError(String(reason)) }
    finally { if (ticket === generation.current) setBusy(false) }
  }
  return <div className="message-search">
    <form onSubmit={event => { event.preventDefault(); void search() }}>
      <label>关键词<input autoFocus type="search" value={query} onChange={event => { reset(); setQuery(event.target.value) }} /></label>
      {!conversationId && <label>会话<select value={scope} onChange={event => { reset(); setScope(event.target.value) }}>
        <option value="">全部会话</option>{rooms.map(room => <option key={room.id} value={room.id}>{room.title}</option>)}
      </select></label>}
      <label>发言人<select value={author} onChange={event => { reset(); setAuthor(event.target.value) }}>
        <option value="">全部发言人</option>{actors.map(actor => <option key={actor.id} value={actor.id}>{actor.name}</option>)}
      </select></label>
      <div className="actions"><button className="btn-primary" disabled={busy || !query.trim()}>搜索</button>
        {busy && <button className="btn-quiet" type="button" onClick={() => { generation.current++; setBusy(false) }}>取消搜索</button>}</div>
    </form>
    <div className="search-results" aria-live="polite">
      {error && <p role="alert">{error}</p>}
      {searched && <p>已找到 {hits.length} 条{more ? '，可继续加载' : ''}</p>}
      {hits.map(hit => <button className="row search-hit" key={hit.id} onClick={() => open(hit)}>
        <div className="row-copy"><strong>{hit.conversationTitle} · {hit.authorName}</strong><span><Match text={hit.body} query={query.trim()} /></span></div>
      </button>)}
      {busy && <p role="status">正在搜索本地记录…</p>}
      {searched && !hits.length && <p>没有找到匹配消息。</p>}
      {more && <button className="btn-secondary" disabled={busy} onClick={() => void search(true)}>加载更多结果</button>}
    </div>
  </div>
}

function Match({ text, query }: { text: string; query: string }) {
  const index = text.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0 || !query) return <>{text.slice(0, 200)}</>
  const start = Math.max(0, index - 40)
  return <>{start ? '…' : ''}{text.slice(start, index)}<mark>{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length, index + query.length + 140)}</>
}
