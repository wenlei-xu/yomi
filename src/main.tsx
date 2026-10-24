import { androidUpdates, Updater } from './update/bridge'
import { UpdateProvider, UpdateSettings } from './update/UpdateCenter'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App as CapacitorApp } from '@capacitor/app'
import { createApp, type AppApi, type RecoveryInfo } from './app/bootstrap'
import { Avatar, AvatarStack, conversationAvatar } from './components/avatar'
import {
  AgentsIcon,
  AtIcon,
  BackIcon,
  ChatIcon,
  CloseIcon,
  MeIcon,
  MoreIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  StopIcon,
  WhisperIcon
} from './components/icons'
import { MessageSearch } from './components/messageSearch'
import { ConversationMemoryPanel } from './components/conversationMemory'
import { MarkdownText } from './components/markdown'
import { LorebookSheet,WorldBookBindings,ActorWorldBookBindings } from './components/lorebooks'
import { MediaSheet,MediaSettingsPanel,MediaAttachment,MessageSpeech } from './components/media'
import { CardImport,OriginalCard,Greetings } from './components/cardImport'
import type {
  Actor,
  Conversation,
  ConversationNote,
  Lorebook,
  LorebookEntry,
  MediaAsset,
  Memory,
  Message,
  ModelBinding,
  ModelCallRecord,
  Provider,
  ProactiveRule,
  ProviderProtocol,
  RuntimeIssue,
  UsageSummary,
  StorageStats,
  Sticker,
  SearchHit
} from './domain/types'
import { backupModules, moduleIds, withDependencies, type BackupModule, type BackupPreview } from './data/modularBackup'
import './styles.css'
import './components/roleplay.css'

type Tab = 'messages' | 'whispers' | 'agents' | 'me'
type Notice = { text: string; tone: 'ok' | 'error' } | null

const tabs: { id: Tab; label: string; Icon: typeof ChatIcon }[] = [
  { id: 'messages', label: '消息', Icon: ChatIcon },
  { id: 'whispers', label: '私聊', Icon: WhisperIcon },
  { id: 'agents', label: '角色', Icon: AgentsIcon },
  { id: 'me', label: '我', Icon: MeIcon }
]

function App() {
  const [app, setApp] = useState<AppApi | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('messages')
  const [version, setVersion] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [targetMessageId, setTargetMessageId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)

  useEffect(() => {
    void createApp(() => setVersion(value => value + 1))
      .then(setApp, reason => setError(String(reason?.message ?? reason)))
  }, [])

  useEffect(() => {
    if (!app || !androidUpdates()) return
    let second = 0
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { void Updater.confirmWeb().catch(() => {}) }) })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [app])

  useEffect(() => {
    const onPopState = () => {
      setSelected(null)
      setTargetMessageId(null)
    }
    if (!window.history.state) window.history.replaceState({ yomiRoot: true }, '', location.href)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (selected) {
      window.history.pushState({ yomiChat: selected }, '')
    }
  }, [selected])

  useEffect(() => {
    if (!notice) return
    const timeout = setTimeout(() => setNotice(null), 3600)
    return () => clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    if (!selected) return
    window.history.replaceState({ yomiChat: selected }, '')
  }, [selected])

  useEffect(() => {
    if (!app) return
    let listener: { remove: () => Promise<void> } | null = null
    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) app.cancelMedia()
      app.runtime.setForeground(isActive)
    }).then(handle => { listener = handle })
    return () => { void listener?.remove() }
  }, [app])

  if (error) return <div className="center error">启动失败：{error}</div>
  if (!app) return <div className="center">正在打开本地数据…</div>

  const openConversation = (conversationId: string, messageId: string | null = null) => {
    setSelected(conversationId)
    setTargetMessageId(messageId)
  }

  const closeConversation = () => {
    if (window.history.state?.yomiChat) window.history.back()
    else {
      setSelected(null)
      setTargetMessageId(null)
    }
  }

  return <div className={`app tab-${tab}`}>
    {notice && <div className={`toast ${notice.tone}`}>{notice.text}</div>}
    <main className={selected ? 'deep-screen' : 'tab-screen'}>
      {tab === 'messages' && <Messages
        app={app}
        version={version}
        selected={selected}
        targetMessageId={targetMessageId}
        openConversation={openConversation}
        close={closeConversation}
        notify={setNotice}
        goToAgents={() => { setTab('agents'); setSelected(null) }}
      />}
      {tab === 'whispers' && <Whispers
        app={app}
        version={version}
        selected={selected}
        openConversation={openConversation}
        close={closeConversation}
      />}
      {tab === 'agents' && <Agents
        app={app}
        version={version}
        notify={setNotice}
        openConversation={conversation => { openConversation(conversation.id); setTab('messages') }}
      />}
      {tab === 'me' && <Me app={app} version={version} notify={setNotice} />}
    </main>
    {!selected && <nav className="mobile-tabbar" aria-label="主导航">
      {tabs.map(item => <button
        key={item.id}
        className={tab === item.id ? 'active' : ''}
        onClick={() => { setTab(item.id); setSelected(null) }}
      >
        <span className="tab-icon"><item.Icon strokeWidth={tab === item.id ? 2 : 1.5} /></span>
        <span>{item.label}</span>
      </button>)}
    </nav>}
  </div>
}

function Messages(props: {
  app: AppApi
  version: number
  selected: string | null
  targetMessageId: string | null
  openConversation: (id: string, messageId?: string | null) => void
  close: () => void
  notify: (notice: Notice) => void
  goToAgents: () => void
}) {
  const { app, version, selected, targetMessageId, openConversation, close, notify, goToAgents } = props
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [issues, setIssues] = useState<RuntimeIssue[]>([])
  const [includeHidden, setIncludeHidden] = useState(false)
  const [actors, setActors] = useState<Actor[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [filter, setFilter] = useState<'all' | 'groups' | 'pinned'>('all')

  useEffect(() => {
    void Promise.all([app.conversations(includeHidden), app.runtimeIssues(), app.actors()])
      .then(([items, pending, actorItems]) => { setConversations(items); setIssues(pending); setActors(actorItems) })
  }, [app, includeHidden, version])

  if (selected) return <Chat
    key={selected}
    app={app}
    version={version}
    conversationId={selected}
    targetMessageId={targetMessageId}
    close={close}
    notify={notify}
    readOnly={false}
    openBranch={id => openConversation(id)}
  />

  const pinned = conversations.filter(item => item.pinned)
  const filtered = conversations.filter(item => {
    if (filter === 'groups') return item.kind === 'group'
    if (filter === 'pinned') return item.pinned
    return true
  })
  const running = app.runtime.snapshot().running.length + app.runtime.snapshot().waiting.length

  return <section className="list conversation-page">
    <div className="page-sticky">
      <div className="brand-header">
        <img src="/logo.png" alt="" className="brand-mark" />
        <h1>Yomi</h1>
        <button
          className={`round-tool ${searchOpen ? 'active' : ''}`}
          onClick={() => setSearchOpen(value => !value)}
          aria-label={searchOpen ? '关闭搜索' : '搜索'}
        >{searchOpen ? <CloseIcon /> : <SearchIcon />}</button>
      </div>
      <div className="pill-filters" aria-label="会话筛选">
        {([
          ['all', '全部'],
          ['groups', '群聊'],
          ['pinned', '置顶']
        ] as const).map(([id, label]) => <button
          key={id}
          className={filter === id ? 'active' : ''}
          onClick={() => setFilter(id)}
        >{label}</button>)}
        <button
          className={includeHidden ? 'active filter-more' : 'filter-more'}
          onClick={() => setIncludeHidden(value => !value)}
        >{includeHidden ? '收起隐藏' : '更多'}</button>
      </div>
      {running > 0 && <button className="runtime-chip" onClick={() => app.stopAll()}>
        <span className="typing-dots"><i /><i /><i /></span>
        {running} 个角色正在回应 · 全部停止
      </button>}
    </div>
    {searchOpen ? <MessageSearch app={app} open={hit => openConversation(hit.conversationId, hit.id)} /> : <>
      {pinned.length > 0 && filter === 'all' && <div className="pinned-strip">
        {pinned.map(item => {
          const visual = conversationAvatar(item, actors)
          return <button key={item.id} onClick={() => openConversation(item.id)}>
            <span className="pinned-avatar">
              {visual.actor
                ? <Avatar actor={visual.actor} size={38} showStatus={false} />
                : <AvatarStack actors={actors.filter(actor => item.members.includes(actor.id))} names={visual.names} size={38} />}
              {item.unread > 0 && <i>{item.unread > 99 ? '99+' : item.unread}</i>}
            </span>
            <span>{item.title}</span>
          </button>
        })}
      </div>}
      {issues.length > 0 && <div className="issue-stack">
        {issues.slice(0, 3).map(issue => <div className="issue" key={`${issue.conversationId}-${issue.updatedAt}`}>
          <div>
            <strong>上次回应被中断</strong>
            <span>{issue.conversationTitle} · {issue.reason || '应用在生成期间离开前台'}</span>
          </div>
          <div className="actions">
            <button onClick={() => openConversation(issue.conversationId)}>打开</button>
            <button onClick={() => void app.retry(issue.conversationId)}>重试</button>
            <button className="ghost" onClick={() => void app.ignoreRecovery(issue.conversationId)}>略过</button>
          </div>
        </div>)}
      </div>}
      {filtered.length === 0
        ? <Empty text="还没有聊天。先创建角色，再打开单聊或建群。" action="去创建角色" onAction={goToAgents} />
        : <div className="conversation-rows scroll-region">{filtered.map(item => {
          const visual = conversationAvatar(item, actors)
          return <button className="row conversation-row" key={item.id} onClick={() => openConversation(item.id)}>
          {visual.actor
            ? <Avatar actor={visual.actor} size={48} />
            : <AvatarStack actors={actors.filter(actor => item.members.includes(actor.id))} names={visual.names} size={48} />}
          <div className="row-copy">
            <strong>{item.title} {item.muted && <span className="muted-mark">静音</span>}</strong>
            <span>{item.lastMessage || '暂无消息'}</span>
          </div>
          <div className="row-meta">
            {item.paused && <small>已停止</small>}
            {item.hidden && <small>已隐藏</small>}
            {item.unread > 0 && <i>{item.unread > 99 ? '99+' : item.unread}</i>}
            {!item.paused && !item.hidden && item.unread === 0 && <small>{formatRelative(item.updatedAt)}</small>}
          </div>
        </button>
        })}</div>}
    </>}
  </section>
}

function Chat(props: {
  app: AppApi
  version: number
  conversationId: string
  targetMessageId: string | null
  close: () => void
  notify: (notice: Notice) => void
  readOnly: boolean
  openBranch?: (id: string) => void
}) {
  const { app, version, conversationId, targetMessageId: requestedTarget, close, notify, readOnly, openBranch } = props
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [quoted, setQuoted] = useState<Message | null>(null)
  const [busy, setBusy] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [hasOlder, setHasOlder] = useState(false)
  const [hasNewer, setHasNewer] = useState(false)
  const [members, setMembers] = useState<Actor[]>([])
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [selectedMentions, setSelectedMentions] = useState<Actor[]>([])
  const [confirmStop, setConfirmStop] = useState(false)
  const [editor, setEditor] = useState<Message | null>(null)
  const [editBody, setEditBody] = useState('')
  const [messageBusy, setMessageBusy] = useState(false)
  const [chatSearch, setChatSearch] = useState(false)
  const [jumpId, setJumpId] = useState<string | null>(null)
  const targetMessageId = jumpId ?? requestedTarget
  const [chatMediaActor,setChatMediaActor]=useState<Actor|null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const targetRef = useRef<HTMLElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [draftReadyFor, setDraftReadyFor] = useState<string | null>(null)
  const pendingSend = useRef<{ fingerprint: string; id: string } | null>(null)
  const sendingRef = useRef(false)

  useEffect(() => {
    let active = true
    setDraftReadyFor(null)
    pendingSend.current = null
    if (readOnly) return
    void app.draft(conversationId).then(async saved => {
      const quote = saved.quotedId ? await app.message(saved.quotedId) : null
      if (!active) return
      setDraft(saved.body)
      setQuoted(quote?.deleted ? null : quote)
      setDraftReadyFor(conversationId)
    }).catch(reason => { if (active) notify({ text: errorText(reason), tone: 'error' }) })
    return () => { active = false }
  }, [app, conversationId, readOnly, notify])

  useEffect(() => {
    let active = true
    const messagesPromise = targetMessageId
      ? app.messagesAround(conversationId, targetMessageId)
      : app.messages(conversationId).then(messages => ({
        messages, hasOlder: messages.length >= 50, hasNewer: false
      }))
    void Promise.all([
      app.conversation(conversationId),
      messagesPromise,
      app.actors()
    ])
      .then(([item, window, actors]) => {
        if (!active) return
        setConversation(item)
        setMessages(window.messages)
        setHasOlder(window.hasOlder)
        setHasNewer(window.hasNewer)
        setMembers(actors.filter(actor =>
          item.members.includes(actor.id) && actor.id !== 'local-user'))
        const last = window.messages.at(-1)
        if (!readOnly && last) void app.markRead(conversationId, last.sequence).catch(() => undefined)
      }, reason => { if (active) notify({ text: errorText(reason), tone: 'error' }) })
    return () => { active = false }
  }, [app, conversationId, targetMessageId, version, readOnly, notify])

  useEffect(() => {
    if (targetMessageId) {
      targetRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } else {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    }
  }, [messages, targetMessageId])

  useEffect(() => {
    if (readOnly || draftReadyFor !== conversationId || busy) return
    const timeout = setTimeout(() => {
      if (sendingRef.current) return
      void app.saveDraft(conversationId, draft, quoted?.id).catch(reason =>
        notify({ text: errorText(reason), tone: 'error' }))
    }, 300)
    return () => clearTimeout(timeout)
  }, [app, conversationId, draft, quoted, readOnly, draftReadyFor, busy, notify])

  if (!conversation) return <div className="center">正在读取聊天…</div>

  const send = async () => {
    if (!draft.trim() || sendingRef.current || readOnly || draftReadyFor !== conversationId) return
    sendingRef.current = true
    setBusy(true)
    const sentBody = draft
    const fingerprint = JSON.stringify([conversationId, draft, quoted?.id, selectedMentions.map(actor => actor.id)])
    if (pendingSend.current?.fingerprint !== fingerprint) pendingSend.current = { fingerprint, id: crypto.randomUUID() }
    try {
      await app.sendUser(conversationId, draft, quoted?.id, selectedMentions.map(actor => actor.id), pendingSend.current.id)
      pendingSend.current = null
      setDraft(current => current === sentBody ? '' : current)
      setQuoted(null)
      setSelectedMentions([])
    } catch (reason) {
      notify({ text: errorText(reason), tone: 'error' })
    } finally { sendingRef.current = false; setBusy(false) }
  }

  const loadOlder = async () => {
    const first = messages[0]
    if (!first) return
    try {
      const older = await app.messages(conversationId, first.sequence)
      setHasOlder(older.length >= 50)
      setMessages(current => [...older, ...current])
    } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
  }

  const loadNewer = async () => {
    const latest = messages.at(-1)
    if (!latest) return
    try {
      const fresh = await app.messages(conversationId)
      setMessages(current => {
        const merged = new Map(current.map(item => [item.id, item]))
        for (const item of fresh) merged.set(item.id, item)
        return [...merged.values()].sort((a, b) => a.sequence - b.sequence)
      })
      setHasNewer(false)
    } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
  }

  const streaming = (app.runtime.snapshot().streaming ?? []).filter(item => item.conversationId === conversationId && item.text)
  const running = app.runtime.snapshot().running.filter(run => run.conversationId === conversationId)
  const waiting = app.runtime.snapshot().waiting.filter(job => job.conversationId === conversationId)
  const mentionMatches = mentionQuery === null
    ? []
    : members.filter(actor => actor.name.toLowerCase().includes(mentionQuery.toLowerCase()))

  return <section className="chat">
    <header className="chat-header">
      <button className="icon-button" onClick={close} aria-label="返回"><BackIcon /></button>
      <button className="title-button" onClick={() => setShowInfo(true)}>
        <strong>{conversation.title}</strong>
        <span>
          {readOnly ? '角色私聊 · 只读旁观' : conversation.kind === 'group'
            ? `${members.length} 位角色 · ${running.length ? '正在回应' : conversation.paused ? '已停止' : '在线'}`
            : conversation.paused ? '已停止' : '角色在线'}
        </span>
      </button>
      {running.length > 0 || waiting.length > 0
        ? <button className="header-stop" onClick={() => setConfirmStop(true)} aria-label="停止生成"><StopIcon /></button>
        : conversation.paused
          ? <button className="header-text-action" onClick={() => app.resume(conversationId)}>继续</button>
          : null}
      <button className="icon-button" onClick={() => setShowMore(true)} aria-label="更多"><MoreIcon /></button>
    </header>
    {readOnly && <div className="readonly-banner">角色间对话，你正在旁观。你不能在这里代任何角色发言。</div>}
    {conversation.paused && <div className="status-banner">互动已停止；历史仍保留，点击“继续”才会重新判断。</div>}
    {running.length > 0 && <div className="typing-banner">
      <span className="typing-dots"><i /><i /><i /></span>
      <span>{running.map(run => members.find(actor => actor.id === run.agentId)?.name || '角色').join('、')} 正在思考</span>
      <button onClick={() => setConfirmStop(true)}>停止</button>
    </div>}
    {waiting.length > 0 && running.length === 0 && <div className="status-banner" role="status">
      {waiting.some(job => job.kind === 'rate') ? '角色互动频率受限，稍后继续。' : '连接暂时不可用，稍后自动重试。'}
      <button className="link" onClick={() => app.stop(conversationId)}>停止等待</button>
    </div>}
    {hasNewer && <button className="refresh-strip attention" disabled={refreshing} onClick={async () => {
      setRefreshing(true)
      try {
        const [freshConversation, freshMessages] = await Promise.all([
          app.conversation(conversationId),
          app.messages(conversationId)
        ])
        setConversation(freshConversation)
        setMessages(freshMessages)
      } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
      finally { setRefreshing(false) }
    }}>{refreshing ? '正在同步…' : '有新回复 · 刷新'}</button>}
    <div className="messages" onClick={() => setMentionQuery(null)}>
      {hasOlder && <button className="load-older" onClick={() => void loadOlder()}>加载更早消息</button>}
      {messages.map(item => {
        const mine = item.authorId === 'local-user'
        const author = members.find(actor => actor.id === item.authorId)
        if (item.authorKind === 'system') {
          return <article key={item.id} id={`message-${item.id}`} className="system-message">
            <div className="message-stack">
              <div className="message-meta"><small>系统</small><span>{formatClock(item.createdAt)}</span></div>
              <div className="message-bubble">
                {item.deleted ? <p className="deleted-message">消息已删除</p> : <MarkdownText text={item.body} />}
              </div>
            </div>
          </article>
        }
        return <article
          key={item.id}
          id={`message-${item.id}`}
          ref={item.id === targetMessageId ? targetRef : undefined}
          className={`${mine ? 'mine' : ''} ${item.id === targetMessageId ? 'target' : ''}`}
        >
          {!mine && <Avatar actor={author} name={item.authorName} size={30} showStatus={false} className="message-avatar" />}
          <div className="message-stack">
            <div className="message-meta">
              <small>{mine ? '你' : item.authorName}</small>
              <span>{formatClock(item.createdAt)}{item.editedAt && !item.recalled ? ' · 已编辑' : ''}</span>
            </div>
            <div className="message-bubble">
              {item.quotedId && <button
                className="quote"
                onClick={() => {
                  const target = messages.find(message => message.id === item.quotedId)
                  if (target) document.getElementById(`message-${target.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                  else if (item.quotedId) setJumpId(item.quotedId)
                }}
              >{messages.find(message => message.id === item.quotedId)?.body.slice(0, 100) ?? '引用的消息不可见'}</button>}
              {item.deleted
                ? <p className="deleted-message">消息已删除</p>
                : <MarkdownText text={item.body} />}
              {!item.deleted && item.mediaId && <MediaAttachment app={app} assetId={item.mediaId}/>}
              {!item.deleted && item.authorKind==='agent' && !item.mediaId &&
                <MessageSpeech app={app} message={item} version={version} notify={notify}/>}
            </div>
            {!item.deleted && !item.recalled && <div className="message-actions">
              {!readOnly && <button className="link" onClick={() => {
                setQuoted(item)
                requestAnimationFrame(() => textareaRef.current?.focus())
              }}>引用</button>}
              {!readOnly && ['❤️','👍','😂','😮','😢','🙏'].map(emoji => <button key={emoji} className="link" aria-label={`表情 ${emoji}`}
                onClick={() => void app.react(item.id, emoji).catch(reason => notify({text:errorText(reason),tone:'error'}))}>{emoji}</button>)}
              {!readOnly && <button className="link" onClick={() => { setEditor(item); setEditBody(item.body) }}>编辑</button>}
              {!readOnly && mine && <button className="link" onClick={async () => {
                if (!confirm('撤回这条消息？角色会看到撤回提示，原文不再提供给后续请求。')) return
                try { await app.recallMessage(item.id) } catch(reason) { notify({text:errorText(reason),tone:'error'}) }
              }}>撤回</button>}
              {!readOnly && item.authorKind === 'agent' && openBranch && <button className="link" disabled={messageBusy} onClick={async () => {
                if (!confirm('从这条回复之前新建分支并重新生成？原会话及后续消息会保留。')) return
                setMessageBusy(true)
                try { openBranch(await app.regenerateMessage(item.id)) } catch(reason) { notify({text:errorText(reason),tone:'error'}) }
                finally { setMessageBusy(false) }
              }}>重新生成</button>}
              <button className="link" onClick={() => {
                if (confirm('删除这条消息？引用和自动来源记忆将失效。')) void app.deleteMessage(item.id).catch(reason => notify({text:errorText(reason),tone:'error'}))
              }}>删除</button>
              {item.reactions.map(reaction => <span key={reaction.emoji}>{reaction.emoji}{reaction.actorIds.length}</span>)}
            </div>}
          </div>
        </article>
      })}
      {!readOnly && !messages.length && conversation.kind==='direct' && members[0] &&
        <Greetings app={app} actorId={members[0].id} conversationId={conversationId} notify={notify}/>}
      {!messages.length && <Empty text={readOnly ? '角色还没有开始私聊。' : '还没有消息，先打个招呼吧。'} />}
      {hasNewer && <button className="load-newer" onClick={() => void loadNewer()}>有新消息 · 跳到最新</button>}
      {streaming.map(item => <article className="message streaming-message" key={`stream-${item.agentId}`} aria-live="polite">
        <div className="message-stack"><small>{members.find(actor => actor.id === item.agentId)?.name ?? '角色'} · 正在输入</small>
          <div className="message-bubble"><MarkdownText text={item.text}/></div><small>生成预览，完成后保存</small></div>
      </article>)}
      <div ref={bottomRef} />
    </div>
    {chatMediaActor && <MediaSheet app={app} agent={chatMediaActor} conversationId={conversationId} notify={notify} close={()=>setChatMediaActor(null)}/>}
    {!readOnly && <form onSubmit={event => { event.preventDefault(); void send() }}>
      {quoted && <div className="composer-quote"><span>回复 {quoted.authorName}：{quoted.body.slice(0, 80)}</span><button type="button" onClick={() => setQuoted(null)}>×</button></div>}
      {selectedMentions.length > 0 && <div className="mention-chips">
        {selectedMentions.map(actor => <button type="button" key={actor.id} onClick={() =>
          setSelectedMentions(current => current.filter(item => item.id !== actor.id))
        }>@{actor.name} ×</button>)}
      </div>}
      {mentionQuery !== null && <div className="mention-menu">
        <div className="mention-menu-title">点名角色</div>
        {mentionMatches.length
          ? mentionMatches.map(actor => <button type="button" key={actor.id} onClick={() => {
            setSelectedMentions(current => current.some(item => item.id === actor.id) ? current : [...current, actor])
            setDraft(current => current.replace(/(^|\s)@[^\s@]*$/, '$1'))
            setMentionQuery(null)
            requestAnimationFrame(() => textareaRef.current?.focus())
          }}>
            <Avatar actor={actor} size={34} showStatus={false} />
            <span>{actor.name}</span>
          </button>)
          : <div className="quiet-loading">没有匹配的角色</div>}
      </div>}
      <div className="composer-row">
        <button className="composer-tool" type="button" disabled={!members.length || busy || conversation.paused} aria-label="图片、语音与表情包"
          onClick={()=>setChatMediaActor(members[0])}><PlusIcon/></button>
        {conversation.kind === 'group' && <button
          className="composer-tool"
          type="button"
          onClick={() => { setMentionQuery(''); textareaRef.current?.focus() }}
          aria-label="点名角色"
        ><AtIcon /></button>}
        <textarea
          ref={textareaRef}
          disabled={draftReadyFor !== conversationId}
          value={draft}
          onChange={event => {
            const value = event.target.value
            setDraft(value)
            if (conversation.kind === 'group') {
              const match = /(^|\s)@([^\s@]*)$/.exec(value)
              setMentionQuery(match ? match[2] : null)
            }
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault(); void send()
            }
          }}
          placeholder={conversation.kind === 'group' ? '发消息给群聊' : `发消息给 ${conversation.title}`}
          rows={1}
        />
        <button className="send-button" type="submit" disabled={busy || draftReadyFor !== conversationId || !draft.trim()} aria-label="发送">
          {busy ? <span className="send-spinner" /> : <SendIcon />}
        </button>
      </div>
    </form>}
    {showInfo && <ConversationSheet
      app={app}
      conversation={conversation}
      close={() => setShowInfo(false)}
      notify={notify}
    />}
    {showMore && <div className="sheet-backdrop" onClick={() => setShowMore(false)}>
      <div className="sheet menu-sheet action-sheet" onClick={event => event.stopPropagation()}>
        <div className="sheet-handle" />
        <h3>{conversation.title}</h3>
        <button onClick={() => {setChatSearch(true);setShowMore(false)}}>搜索本会话</button>
        <button onClick={async () => {
          try { notify({ text: `已导出：${await app.exportConversation(conversationId, 'markdown')}`, tone: 'ok' }) }
          catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
        }}>导出 Markdown</button>
        <button onClick={async () => {
          try { notify({ text: `已导出：${await app.exportConversation(conversationId, 'json')}`, tone: 'ok' }) }
          catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
        }}>导出 JSON</button>
        <button className="danger" onClick={async () => {
          if (!confirm('清空该会话的全部消息和本会话来源记忆？')) return
          await app.clearConversation(conversationId)
          setShowMore(false)
        }}>清空聊天</button>
        {!readOnly && <button className="danger" onClick={async () => {
          if (!confirm('删除整个会话？聊天记录和本会话来源记忆将永久删除。')) return
          try {
            await app.deleteConversation(conversationId)
            setShowMore(false)
            close()
          } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
        }}>删除会话</button>}
        <button className="ghost sheet-cancel" onClick={() => setShowMore(false)}>取消</button>
      </div>
    </div>}
    {chatSearch && <div className="sheet-backdrop" onClick={() => setChatSearch(false)}><div className="sheet" role="dialog" aria-modal="true" aria-label="搜索本会话" onClick={event => event.stopPropagation()}>
      <button onClick={() => setChatSearch(false)}>关闭搜索</button>
      <MessageSearch app={app} conversationId={conversationId} open={hit => {setJumpId(hit.id);setChatSearch(false)}}/>
    </div></div>}
    {editor && <div className="sheet-backdrop" onClick={() => {if(!messageBusy)setEditor(null)}}><div className="sheet" role="dialog" aria-modal="true" aria-label="编辑消息" onClick={event => event.stopPropagation()}>
      <h3>编辑消息</h3><p>会停止当前生成并使相关自动记忆、摘要失效；后续消息保留，不会自动重跑。</p>
      <textarea aria-label="消息正文" rows={7} maxLength={32768} value={editBody} disabled={messageBusy} onChange={event => setEditBody(event.target.value)}/>
      {(editor.editHistory ?? []).length > 0 && <details><summary>历史版本（选择后保存）</summary>{[...(editor.editHistory ?? [])].reverse().map((entry,index) =>
        <button className="history-version" key={index} disabled={messageBusy} onClick={() => setEditBody(entry.body)}>{new Date(entry.at).toLocaleString()} · {entry.body.slice(0,120)}</button>)}</details>}
      <div className="actions"><button disabled={messageBusy || !editBody.trim()} onClick={async () => {
        setMessageBusy(true)
        try {await app.editMessage(editor.id,editBody);setEditor(null)} catch(reason){notify({text:errorText(reason),tone:'error'})}
        finally{setMessageBusy(false)}
      }}>保存</button><button disabled={messageBusy} onClick={() => setEditor(null)}>取消</button></div>
    </div></div>}
    {confirmStop && <div className="dialog-backdrop" onClick={() => setConfirmStop(false)}>
      <div className="dialog" onClick={event => event.stopPropagation()}>
        <div className="dialog-icon"><StopIcon /></div>
        <h3>停止本轮互动？</h3>
        <p>当前生成和本轮剩余发言会同时取消。已完成的回复会保留，重启后可手动重试。</p>
        <div className="dialog-actions">
          <button className="ghost" onClick={() => setConfirmStop(false)}>继续等待</button>
          <button className="danger" onClick={() => { app.stop(conversationId); setConfirmStop(false) }}>停止</button>
        </div>
      </div>
    </div>}
  </section>
}

function ConversationSheet(props: {
  app: AppApi
  conversation: Conversation
  close: () => void
  notify: (notice: Notice) => void
}) {
  const { app, conversation, close, notify } = props
  const [title, setTitle] = useState(conversation.title)
  const [topic, setTopic] = useState(conversation.topic)
  const [agents, setAgents] = useState<Actor[]>([])
  const [members, setMembers] = useState<string[]>(conversation.members)
  const [pinned, setPinned] = useState(conversation.pinned)
  const [muted, setMuted] = useState(conversation.muted)
  const [autonomyPaused, setAutonomyPaused] = useState(conversation.autonomyPaused)
  const [hidden, setHidden] = useState(conversation.hidden)
  const [detailMembers, setDetailMembers] = useState<Actor[]>([])


  useEffect(() => { void app.actors().then(items => {
    setAgents(items.filter(item => item.kind === 'agent' && !item.archived))
    setDetailMembers(items.filter(item => conversation.members.includes(item.id) && item.id !== 'local-user'))
  }) }, [app, conversation.members])



  return <div className="sheet-backdrop" onClick={close}>
    <div className="sheet info-sheet" onClick={event => event.stopPropagation()}>
      <div className="sheet-handle" />
      <div className="sheet-heading"><h3>会话资料</h3><button className="sheet-close" onClick={close}><CloseIcon /></button></div>
      <div className="conversation-hero">
        {conversation.kind === 'direct' && detailMembers[0]
          ? <Avatar actor={detailMembers[0]} size={76} />
          : <AvatarStack actors={detailMembers} size={54} />}
        <h2>{conversation.title}</h2>
        <p>{conversation.topic || (conversation.kind === 'group' ? `${detailMembers.length} 位角色在这个群聊` : '单聊')}</p>
      </div>
      {conversation.kind === 'group' && <>
        <label>名称<input value={title} onChange={event => setTitle(event.target.value)} /></label>
        <label>话题<textarea value={topic} onChange={event => setTopic(event.target.value)} /></label>
        <h4>群成员</h4>
        <div className="pick-list">
          {agents.map(agent => <label key={agent.id}>
            <input type="checkbox" checked={members.includes(agent.id)} onChange={event => setMembers(current =>
              event.target.checked ? [...current, agent.id] : current.filter(id => id !== agent.id))} />
            {agent.name}
          </label>)}
        </div>
      </>}
      {conversation.kind === 'direct' && <div className="member-summary">
        <p>{conversation.memberNames.filter(name => name !== '我').join('、')}</p>
        <p className="hint">角色记忆可在“角色”页管理。单聊由你与一个角色组成。</p>
      </div>}
      <div className="switch-row"><span>置顶</span><button className="ghost" onClick={() => setPinned(value => !value)}>{pinned ? '已开启' : '关闭'}</button></div>
      <div className="switch-row"><span>静音</span><button className="ghost" onClick={() => setMuted(value => !value)}>{muted ? '已开启' : '关闭'}</button></div>
      <div className="switch-row"><span>暂停角色自主互动</span><button className="ghost" onClick={() => setAutonomyPaused(value => !value)}>{autonomyPaused ? '已暂停' : '运行中'}</button></div>
      <div className="switch-row"><span>从列表隐藏</span><button className="ghost" onClick={() => setHidden(value => !value)}>{hidden ? '将隐藏' : '隐藏'}</button></div>
      <WorldBookBindings app={app} conversationId={conversation.id} notify={notify}/>
      <ConversationNotes app={app} conversation={conversation} members={detailMembers} notify={notify} />
      <ConversationMemoryPanel app={app} conversation={conversation} members={detailMembers} notify={notify} />
      <ProactiveRules app={app} conversation={conversation} members={detailMembers} notify={notify} />
      <button className="wide-primary" onClick={async () => {
        try {
          await app.updateConversation(conversation.id, {
            ...(conversation.kind === 'group' ? { title, topic } : {}),
            pinned, muted, autonomyPaused, hidden
          })
          if (conversation.kind === 'group') {
            await app.updateMembers(conversation.id, members, conversation.members.filter(id =>
              id !== 'local-user' && !members.includes(id)))
          }
          notify({ text: '会话资料已保存', tone: 'ok' })
          close()
        } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
      }}>保存</button>
    </div>
  </div>
}

function Whispers(props: {
  app: AppApi
  version: number
  selected: string | null
  openConversation: (id: string) => void
  close: () => void
}) {
  const { app, version, selected, openConversation, close } = props
  const [items, setItems] = useState<Conversation[]>([])
  useEffect(() => { void app.whispers().then(setItems) }, [app, version])
  if (selected) return <Chat
    key={selected}
    app={app}
    version={version}
    conversationId={selected}
    targetMessageId={null}
    close={close}
    notify={() => undefined}
    readOnly
  />
  return <section className="list whispers-page">
    <div className="page-sticky">
      <div className="simple-title">
        <h1>私聊</h1>
        <span>角色之间的对话</span>
      </div>
    </div>
    <div className="info-banner">这里显示角色之间的对话。你是设备所有者，可以旁观和管理，但不能以任何角色身份插入发言。</div>
    {items.length === 0
      ? <Empty text="角色之间还没有自动开启私聊。" />
      : <div className="conversation-rows scroll-region">{items.map(item => <button className="row conversation-row" key={item.id} onClick={() => openConversation(item.id)}>
        <Avatar name={item.title.slice(0, 1)} size={48} status="#8A78C8" />
        <div className="row-copy"><strong>{item.title}</strong><span>{item.lastMessage || '暂无消息'}</span></div>
        <div className="row-meta">{item.paused && <small>已停止</small>}</div>
      </button>)}</div>}
  </section>
}

function Agents(props: {
  app: AppApi
  version: number
  notify: (notice: Notice) => void
  openConversation: (conversation: Conversation) => void
}) {
  const { app, version, notify, openConversation } = props
  const [agents, setAgents] = useState<Actor[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState<Partial<Actor> | 'new' | null>(null)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupTopic, setGroupTopic] = useState('')
  const [selectedAgents, setSelectedAgents] = useState<string[]>([])
  const [memoryAgent, setMemoryAgent] = useState<Actor | null>(null)
  const [mediaAgent, setMediaAgent] = useState<Actor | null>(null)

  useEffect(() => { void app.actors().then(items => setAgents(items.filter(item => item.kind === 'agent'))) }, [app, version])
  const visible = agents.filter(item => showArchived ? true : !item.archived)
  const active = agents.filter(item => !item.archived && item.enabled)

  return <section className="list agents-page">
    <div className="page-sticky">
      <div className="agents-title">
        <h1>你的角色 <em>共 {active.length} 位</em></h1>
        <p>每个角色独立判断，在合适时加入对话</p>
      </div>
    </div>
    <div className="agents-scroll scroll-region">
      <div className="agent-stat-row">
        <span><b>{active.length}</b> 可用</span>
        <span><b>{agents.filter(agent => !agent.archived && !agent.enabled).length}</b> 停用</span>
        <span><b>{agents.filter(agent => agent.archived).length}</b> 归档</span>
      </div>
      <div className="agent-actions">
        <button onClick={() => setEditing('new')}><PlusIcon /> 新角色</button>
        <button onClick={() => setCreatingGroup(true)} disabled={!active.length}><ChatIcon /> 建群</button>
        <label className="agent-action-file">导入<input type="file" accept=".json,.yomi-character.json" onChange={async event => {
          const file = event.target.files?.[0]
          if (!file) return
          try {
            const actor = await app.importAgent(file.name, await file.text())
            notify({ text: `已导入角色：${actor.name}`, tone: 'ok' })
          } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
          event.target.value = ''
        }} /></label>
        <CardImport app={app} notify={notify}/>
        <button className="ghost" onClick={() => setShowArchived(value => !value)}>{showArchived ? '收起归档' : '归档'}</button>
      </div>
      <div className="agent-grid">
        {visible.map(agent => <article className={`agent-card ${agent.archived ? 'archived' : ''}`} key={agent.id}>
          <button className="agent-card-main" disabled={agent.archived} onClick={async () => {
            try { openConversation(await app.openDirect(agent.id)) }
            catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
          }}>
            <Avatar actor={agent} size={48} status={agent.enabled ? undefined : '#B8C4D1'} />
            <div className="agent-copy">
              <h3>{agent.name}</h3>
              <div className="agent-role">{agent.speakingStyle || '独立角色'}</div>
              <span className={`agent-status ${agent.archived ? 'resting' : agent.enabled ? 'avail' : 'waiting'}`}>
                <i />{agent.archived ? '已归档' : agent.enabled ? '可参与聊天' : '已停用'}
              </span>
            </div>
          </button>
          {agent.bio && <p>“{agent.bio}”</p>}
          <div className="agent-tools">
            <span>chat</span><span>memory</span><span>whisper</span>
          </div>
          <div className="agent-card-actions">
            <button onClick={() => setEditing(agent)}>编辑资料</button>
            <button onClick={() => setMemoryAgent(agent)}>记忆</button>
            <button onClick={() => setMediaAgent(agent)}>多媒体</button>
          </div>
        </article>)}
      </div>
      <button className="hire-agent" onClick={() => setEditing('new')}>
        <span className="hire-plus"><PlusIcon /></span>
        <span><strong>创建新角色</strong><small>设计一位新的对话伙伴</small></span>
      </button>
    </div>
    {editing && <AgentEditor
      app={app}
      initial={editing === 'new' ? null : editing}
      close={() => setEditing(null)}
      notify={notify}
    />}
    {creatingGroup && <div className="sheet-backdrop" onClick={() => setCreatingGroup(false)}>
      <div className="sheet tall" onClick={event => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-heading"><h3>新建群聊</h3><button className="sheet-close" onClick={() => setCreatingGroup(false)}><CloseIcon /></button></div>
        <input value={groupName} onChange={event => setGroupName(event.target.value)} placeholder="群名称" />
        <input value={groupTopic} onChange={event => setGroupTopic(event.target.value)} placeholder="话题（可选）" />
        <div className="pick-list agent-pick-list">
          {active.map(agent => <label key={agent.id}>
            <input type="checkbox" checked={selectedAgents.includes(agent.id)} onChange={event =>
              setSelectedAgents(current => event.target.checked
                ? [...current, agent.id]
                : current.filter(id => id !== agent.id))} />
            <Avatar actor={agent} size={38} showStatus={false} />
            {agent.name}
          </label>)}
        </div>
        <button className="wide-primary" onClick={async () => {
          try {
            const conversation = await app.createGroup(groupName, selectedAgents, groupTopic)
            setCreatingGroup(false)
            setGroupName(''); setGroupTopic(''); setSelectedAgents([])
            openConversation(conversation)
          } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
        }}>创建</button>
      </div>
    </div>}
    {memoryAgent && <MemorySheet
      app={app}
      agent={memoryAgent}
      close={() => setMemoryAgent(null)}
      notify={notify}
    />}
    {mediaAgent && <MediaSheet
      app={app}
      agent={mediaAgent}
      close={() => setMediaAgent(null)}
      notify={notify}
    />}
  </section>
}

function AgentEditor(props: {
  app: AppApi
  initial: Partial<Actor> | null
  close: () => void
  notify: (notice: Notice) => void
}) {
  const { app, initial, close, notify } = props
  const [privateMemo, setPrivateMemo] = useState('')
  const [privateMemoId, setPrivateMemoId] = useState<string | undefined>()
  const [privateMemoReady, setPrivateMemoReady] = useState(!initial?.id)
  useEffect(() => {
    if (!initial?.id) return
    void app.memories(initial.id).then(items => {
      const memo = items.find(item => item.kind === 'private-note' && !item.conversationId && item.origin === 'human')
      setPrivateMemo(memo?.body ?? ''); setPrivateMemoId(memo?.id); setPrivateMemoReady(true)
    }, reason => notify({ text: errorText(reason), tone: 'error' }))
  }, [app, initial?.id, notify])
  const [modelProviders, setModelProviders] = useState<Provider[]>([])
  const [modelsReady, setModelsReady] = useState(false)
  const [models, setModels] = useState<Record<ModelBinding['purpose'], {
    providerId: string; modelId: string; contextTokens: number; outputTokens: number
  }>>({ main: { providerId: '', modelId: '', contextTokens: 32768, outputTokens: 2048 },
    triage: { providerId: '', modelId: '', contextTokens: 32768, outputTokens: 512 },
    summary: { providerId: '', modelId: '', contextTokens: 32768, outputTokens: 1800 } })
  useEffect(() => {
    void Promise.all([app.providers(), app.bindings()]).then(([providers, bindings]) => {
      setModelProviders(providers)
      setModels(current => Object.fromEntries(Object.entries(current).map(([purpose, defaults]) => {
        const binding = initial?.id ? bindings.find(item => item.agentId === initial.id && item.purpose === purpose) : undefined
        return [purpose, binding ? { providerId: binding.providerId ?? '', modelId: binding.modelId,
          contextTokens: binding.contextTokens, outputTokens: binding.outputTokens } : defaults]
      })) as typeof current)
      setModelsReady(true)
    }, reason => notify({ text: errorText(reason), tone: 'error' }))
  }, [app, initial?.id, notify])
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    bio: initial?.bio ?? '',
    persona: initial?.persona ?? '',
    speakingStyle: initial?.speakingStyle ?? '',
    color: initial?.color ?? '#7c3aed',
    avatarData: initial?.avatarData ?? '',
    enabled: initial?.enabled ?? true,
    archived: initial?.archived ?? false,
    allowPrivate: initial?.allowPrivate ?? true,
    allowGroup: initial?.allowGroup ?? true
  })
  const save = async (patch: Partial<typeof form> = {}): Promise<boolean> => {
    try {
      if (!modelsReady || !privateMemoReady) throw new Error('角色设置仍在加载，请稍候')
      for (const model of Object.values(models)) {
        if (model.providerId && (!model.modelId.trim() || model.contextTokens < model.outputTokens + 1024)) {
          throw new Error('请填写独立模型名称，并确保上下文大于输出预留')
        }
      }

      const saved = await app.saveAgent({ ...(initial ?? {}), ...form, ...patch, name: patch.name ?? form.name })
      if (privateMemo.trim()) await app.saveMemory({ id: privateMemoId, agentId: saved.id,
        body: privateMemo, kind: 'private-note', origin: 'human', pinned: true })
      else if (privateMemoId) await app.deleteMemory(privateMemoId)
      for (const purpose of ['main', 'triage', 'summary'] as const) {
        const model = models[purpose]
        if (model.providerId) await app.saveBinding({ ...model, id: crypto.randomUUID(), purpose, agentId: saved.id, revision: 1 })
        else await app.clearAgentBinding(saved.id, purpose)
      }
      notify({ text: `已保存角色：${saved.name}`, tone: 'ok' })
      close()
      return true
    } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
    return false
  }
  return <div className="sheet-backdrop" onClick={close}>
    <div className="sheet tall" onClick={event => event.stopPropagation()}>
      <div className="sheet-handle" />
      <div className="sheet-heading"><h3>{initial ? '编辑角色' : '新建角色'}</h3><button className="sheet-close" onClick={close}><CloseIcon /></button></div>
      <label>名称<input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="角色名称" /></label>
      <label>简介<input value={form.bio} onChange={event => setForm({ ...form, bio: event.target.value })} placeholder="公开简介" /></label>
      <label>人设<textarea value={form.persona} onChange={event => setForm({ ...form, persona: event.target.value })} placeholder="身份、经历、边界与行为方式" /></label>
      <label>对角色的私有备忘<textarea value={privateMemo} disabled={!privateMemoReady}
        onChange={event => setPrivateMemo(event.target.value)} placeholder="只供这个角色参考，跨会话保留" /></label>
      <label>说话风格<textarea value={form.speakingStyle} onChange={event => setForm({ ...form, speakingStyle: event.target.value })} placeholder="语气、长度和表达习惯" /></label>
      <details className="settings-card">
        <summary>模型设置 · 默认继承应用配置</summary>
        {(['main', 'triage', 'summary'] as const).map(purpose => <div key={purpose}>
          <label>{{ main: '角色主模型', triage: '辅助判断模型', summary: '摘要模型' }[purpose]}
            <select value={models[purpose].providerId} onChange={event => setModels(current => ({ ...current,
              [purpose]: { ...current[purpose], providerId: event.target.value } }))}>
              <option value="">继承应用默认</option>
              {modelProviders.map(provider => <option value={provider.id} key={provider.id}>{provider.name}</option>)}
            </select>
          </label>
          {models[purpose].providerId && <>
            <label>模型 ID<input value={models[purpose].modelId} onChange={event => setModels(current => ({ ...current,
              [purpose]: { ...current[purpose], modelId: event.target.value } }))} /></label>
            <div className="two-cols">
              <label>上下文<input type="number" value={models[purpose].contextTokens} onChange={event => setModels(current => ({ ...current,
                [purpose]: { ...current[purpose], contextTokens: Number(event.target.value) } }))} /></label>
              <label>输出上限<input type="number" value={models[purpose].outputTokens} onChange={event => setModels(current => ({ ...current,
                [purpose]: { ...current[purpose], outputTokens: Number(event.target.value) } }))} /></label>
            </div>
          </>}
        </div>)}
      </details>
      <label>头像颜色<input type="color" value={form.color} onChange={event => setForm({ ...form, color: event.target.value })} /></label>
      {form.avatarData && <div className="avatar-preview"><img src={form.avatarData} alt="头像预览" />
        <button className="ghost" onClick={() => setForm({ ...form, avatarData: '' })}>移除头像</button></div>}
      <label className="file-button">选择头像图片<input type="file" accept="image/png,image/jpeg,image/webp" onChange={async event => {
        const file = event.target.files?.[0]
        if (!file) return
        if (file.size > 2_000_000) { notify({ text: '头像图片不能超过 2 MB', tone: 'error' }); return }
        setForm({ ...form, avatarData: await readImageThumbnail(file) })
        event.target.value = ''
      }} /></label>
      <div className="switch-row"><span>启用</span><input type="checkbox" checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} /></div>
      <div className="switch-row"><span>允许主动私聊</span><input type="checkbox" checked={form.allowPrivate} onChange={event => setForm({ ...form, allowPrivate: event.target.checked })} /></div>
      <div className="switch-row"><span>允许建立角色小组</span><input type="checkbox" checked={form.allowGroup} onChange={event => setForm({ ...form, allowGroup: event.target.checked })} /></div>
      {initial?.id && <ActorWorldBookBindings app={app} actorId={initial.id} notify={notify}/>}
      {!initial?.id && <p className="hint">保存角色后，可在编辑资料中绑定已有世界书。</p>}
      {initial?.id && <OriginalCard app={app} actorId={initial.id} notify={notify}/>}
      <button className="wide-primary" onClick={() => void save()}>保存角色</button>
      {initial && <div className="danger-zone">
        <button className="ghost" onClick={() => void save({ archived: !form.archived })}>{form.archived ? '取消归档' : '归档角色'}</button>
        <button className="ghost" onClick={async () => {
          try {
            await app.saveAgent({ ...(initial ?? {}), ...form, name: form.name })
            await app.copyAgent(initial.id!)
            close()
          }
          catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
        }}>复制角色</button>
        <button className="ghost" onClick={async () => {
          try { notify({ text: `已导出：${await app.exportAgent(initial.id!)}`, tone: 'ok' }) }
          catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
        }}>导出角色</button>
        <button className="danger" onClick={async () => {
          if (!confirm('彻底删除角色、记忆及角色间私聊关联？历史消息仍保留作者名称。')) return
          try { await app.deleteAgent(initial.id!); close() }
          catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
        }}>删除角色</button>
      </div>}
    </div>
  </div>
}

function ConversationNotes(props: {
  app: AppApi
  conversation: Conversation
  members: Actor[]
  notify: (notice: Notice) => void
}) {
  const { app, conversation, members, notify } = props
  const [notes, setNotes] = useState<ConversationNote[]>([])
  const [scope, setScope] = useState<'shared' | 'private'>('shared')
  const [targetActorId, setTargetActorId] = useState('')
  const [body, setBody] = useState('')
  const [editingId, setEditingId] = useState<string | undefined>()

  const load = () => { void app.conversationNotes(conversation.id).then(setNotes,
    reason => notify({ text: errorText(reason), tone: 'error' })) }
  useEffect(load, [app, conversation.id, notify])

  const shared = notes.filter(note => note.scope === 'shared')
  const privateNotes = notes.filter(note => note.scope === 'private')
  const memberName = (actorId: string) => members.find(item => item.id === actorId)?.name ?? '该成员'

  return <div className="conversation-notes">
    <h4>群共享记忆与备注</h4>
    <p className="hint">共享内容供本群所有成员参考；私下备注仅传给指定成员，作为其回应参考。</p>
    <div className="pick-list">
      <label><input type="radio" name={`note-scope-${conversation.id}`} checked={scope === 'shared'}
        onChange={() => setScope('shared')} />群共享备注</label>
      <label><input type="radio" name={`note-scope-${conversation.id}`} checked={scope === 'private'}
        onChange={() => setScope('private')} />对某成员的私下备注</label>
    </div>
    {scope === 'private' && <label>对象
      <select value={targetActorId} onChange={event => setTargetActorId(event.target.value)}>
        <option value="">选择成员</option>
        {members.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select>
    </label>}
    <label>内容<textarea value={body} onChange={event => setBody(event.target.value)}
      placeholder="例如：这个群上周约定周末去看海，还没去成" /></label>
    <button disabled={!body.trim() || (scope === 'private' && !targetActorId)} onClick={async () => {
      try {
        await app.saveConversationNote({ id: editingId, conversationId: conversation.id, scope,
          targetActorId: scope === 'private' ? targetActorId : null, body })
        setBody(''); setEditingId(undefined)
        notify({ text: '备注已保存', tone: 'ok' })
        load()
      } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
    }}>保存备注</button>
    {editingId && <button className="link" onClick={() => { setEditingId(undefined); setBody('') }}>取消编辑</button>}
    {!!shared.length && <div className="note-list">
      <h5>群共享</h5>
      {shared.map(note => <div key={note.id} className="note-row">
        <p>{note.body}</p>
        <button className="link" onClick={() => { setEditingId(note.id); setScope(note.scope); setTargetActorId(note.targetActorId ?? ''); setBody(note.body) }}>编辑</button>
        <button className="link danger-text" onClick={() => void app.deleteConversationNote(note.id).then(load).catch(reason => notify({ text: errorText(reason), tone: 'error' }))}>删除</button>
      </div>)}
    </div>}
    {!!privateNotes.length && <div className="note-list">
      <h5>私下备注</h5>
      {privateNotes.map(note => <div key={note.id} className="note-row">
        <small>{memberName(note.targetActorId ?? '')}</small>
        <p>{note.body}</p>
        <button className="link" onClick={() => { setEditingId(note.id); setScope(note.scope); setTargetActorId(note.targetActorId ?? ''); setBody(note.body) }}>编辑</button>
        <button className="link danger-text" onClick={() => void app.deleteConversationNote(note.id).then(load).catch(reason => notify({ text: errorText(reason), tone: 'error' }))}>删除</button>
      </div>)}
    </div>}
  </div>
}

function ProactiveRules(props: {
  app: AppApi
  conversation: Conversation
  members: Actor[]
  notify: (notice: Notice) => void
}) {
  const { app, conversation, members, notify } = props
  const [rules, setRules] = useState<ProactiveRule[]>([])
  const [mode, setMode] = useState<'interval' | 'daily'>('interval')
  const [intervalMinutes, setIntervalMinutes] = useState(120)
  const [dailyAt, setDailyAt] = useState(540)
  const [actorId, setActorId] = useState('')
  const [prompt, setPrompt] = useState('')

  const load = () => { void app.proactiveRules(conversation.id).then(setRules,
    reason => notify({ text: errorText(reason), tone: 'error' })) }
  useEffect(load, [app, conversation.id, notify])

  const formatDaily = (minutes: number) =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  const memberName = (id: string | null) => id ? members.find(item => item.id === id)?.name ?? '该成员' : '全体成员'

  return <div className="proactive-rules">
    <h4>主动发言</h4>
    <p className="hint">到点后由角色自行判断是否开口，不保证一定发言。会话暂停、存在未处理任务或角色停用时跳过本次触发。</p>
    <div className="pick-list">
      <label><input type="radio" name={`proactive-mode-${conversation.id}`} checked={mode === 'interval'}
        onChange={() => setMode('interval')} />固定间隔</label>
      <label><input type="radio" name={`proactive-mode-${conversation.id}`} checked={mode === 'daily'}
        onChange={() => setMode('daily')} />每天定时</label>
    </div>
    {mode === 'interval'
      ? <label>间隔（分钟，5～10080）<input type="number" min={5} max={10080} value={intervalMinutes}
          onChange={event => setIntervalMinutes(Number(event.target.value))} /></label>
      : <label>每天时刻<input type="time" value={formatDaily(dailyAt)}
          onChange={event => {
            const [hours, minutes] = event.target.value.split(':').map(Number)
            setDailyAt(hours * 60 + (minutes || 0))
          }} /></label>}
    <label>发起者
      <select value={actorId} onChange={event => setActorId(event.target.value)}>
        <option value="">全体成员</option>
        {members.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select>
    </label>
    <label>提示（可选）<input value={prompt} onChange={event => setPrompt(event.target.value)}
      placeholder="例如：聊聊今天有没有什么新鲜事" /></label>
    <button onClick={async () => {
      try {
        await app.saveProactiveRule({ conversationId: conversation.id, actorId: actorId || null,
          mode, intervalMinutes, dailyAt, prompt })
        setPrompt('')
        notify({ text: '主动发言已安排', tone: 'ok' })
        load()
      } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
    }}>添加规则</button>
    {rules.map(rule => <div key={rule.id} className={`note-row ${rule.enabled ? '' : 'disabled'}`}>
      <div>
        <strong>{rule.mode === 'interval' ? `每 ${rule.intervalMinutes} 分钟` : `每天 ${formatDaily(rule.dailyAt)}`}</strong>
        <small>{memberName(rule.actorId)}{rule.enabled ? '' : ' · 已停用'}</small>
        {rule.prompt && <p className="hint">{rule.prompt}</p>}
      </div>
      <div className="actions">
        <button className="link" onClick={() => void app.saveProactiveRule({ id: rule.id,
          conversationId: rule.conversationId, actorId: rule.actorId, mode: rule.mode,
          intervalMinutes: rule.intervalMinutes, dailyAt: rule.dailyAt, prompt: rule.prompt,
          enabled: !rule.enabled }).then(load).catch(reason => notify({ text: errorText(reason), tone: 'error' }))}>{rule.enabled ? '停用' : '启用'}</button>
        <button className="link danger-text" onClick={() => void app.deleteProactiveRule(rule.id).then(load).catch(reason => notify({ text: errorText(reason), tone: 'error' }))}>删除</button>
      </div>
    </div>)}
  </div>
}

function MemorySheet(props: {
  app: AppApi
  agent: Actor
  close: () => void
  notify: (notice: Notice) => void
}) {
  const { app, agent, close, notify } = props
  const [items, setItems] = useState<Memory[]>([])
  const [body, setBody] = useState('')
  const [editing, setEditing] = useState<Memory | null>(null)
  const [moving, setMoving] = useState<Memory | null>(null)
  const [scope, setScope] = useState('')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const load = () => void app.memories(agent.id).then(setItems, reason =>
    notify({ text: errorText(reason), tone: 'error' }))
  useEffect(() => {
    load()
    void app.conversations(true).then(items => setConversations(items.filter(item =>
      item.members.includes(agent.id))))
  }, [app, agent.id])
  return <div className="sheet-backdrop" onClick={close}>
    <div className="sheet tall" onClick={event => event.stopPropagation()}>
      <div className="sheet-handle" />
      <div className="sheet-heading"><h3>{agent.name} 的记忆</h3><button className="sheet-close" onClick={close}><CloseIcon /></button></div>
      <p className="hint">文字记忆按角色隔离。自动记忆只属于当前会话；你创建的全局记忆可被该角色在其他会话读取。</p>
      <textarea value={body} onChange={event => setBody(event.target.value)} placeholder="记录一条角色记忆" />
      <select value={scope} onChange={event => setScope(event.target.value)}>
        <option value="">全局（该角色所有会话）</option>
        {conversations.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
      <button className="wide-primary" disabled={!body.trim()} onClick={async () => {
        try {
          await app.saveMemory({ agentId: agent.id, conversationId: scope || null, body, origin: 'human', pinned: false })
          setBody(''); load()
        } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
      }}>添加记忆</button>
      <div className="memory-list">
        {items.map(memory => <div className="memory-card" key={memory.id}>
          <div className="message-meta"><small>{memory.conversationId ? '会话记忆' : '全局记忆'} · {memory.origin === 'human' ? '你创建' : '角色记录'} · {new Date(memory.updatedAt).toLocaleDateString()}</small>
            {memory.pinned && <span className="badge">置顶</span>}</div>
          <p>{memory.body}</p>
          <div className="actions">
            <button className="link" onClick={async () => {
              await app.saveMemory({ ...memory, agentId: agent.id, body: memory.body, pinned: !memory.pinned, origin: memory.origin })
              load()
            }}>{memory.pinned ? '取消置顶' : '置顶'}</button>
            <button className="link" onClick={() => setEditing(memory)}>编辑</button>
            <button className="link" onClick={() => {
              if (memory.conversationId) {
                void app.moveMemoryScope(memory.id, null).then(load, reason =>
                  notify({ text: errorText(reason), tone: 'error' }))
              } else {
                setMoving(memory)
              }
            }}>{memory.conversationId ? '设为全局' : '限定会话'}</button>
            <button className="link danger-text" onClick={async () => {
              if (!confirm('删除这条记忆？')) return
              await app.deleteMemory(memory.id); load()
            }}>删除</button>
          </div>
        </div>)}
        {!items.length && <Empty text="还没有记忆。" />}
      </div>
      {editing && <div className="edit-memory">
        <textarea value={editing.body} onChange={event => setEditing({ ...editing, body: event.target.value })} />
        <button onClick={async () => {
          await app.saveMemory({
            id: editing.id, agentId: agent.id, conversationId: editing.conversationId,
            body: editing.body, kind: editing.kind, about: editing.about,
            pinned: editing.pinned, origin: 'human'
          })
          setEditing(null); load()
        }}>保存修改</button>
      </div>}
      {moving && <div className="memory-scope-picker">
        <div className="sheet-heading"><h4>选择记忆所属会话</h4><button className="link" onClick={() => setMoving(null)}>取消</button></div>
        {conversations.map(item => <button key={item.id} onClick={async () => {
          try {
            await app.moveMemoryScope(moving.id, item.id)
            setMoving(null)
            load()
          } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
        }}>
          <ChatIcon />
          <span>{item.title}</span>
        </button>)}
        {!conversations.length && <p className="hint">该角色还没有可关联的会话。</p>}
      </div>}
    </div>
  </div>
}

function Me(props: {
  app: AppApi
  version: number
  notify: (notice: Notice) => void
}) {
  const { app, version, notify } = props
  const [lorebookOpen, setLorebookOpen] = useState(false)
  const [profile, setProfile] = useState({ name: '', bio: '' })
  const profileDirty = useRef(false)
  const [providers, setProviders] = useState<Provider[]>([])
  const [bindings, setBindings] = useState<ModelBinding[]>([])
  const [usage, setUsage] = useState<ModelCallRecord[]>([])
  const [providerForm, setProviderForm] = useState({
    id: '',
    name: '',
    protocol: 'responses' as ProviderProtocol,
    purpose: 'main' as ModelBinding['purpose'],
    baseUrl: '',
    model: '',
    contextTokens: 32768,
    outputTokens: 2048
  })
  const [testing, setTesting] = useState('')
  const [showUsage, setShowUsage] = useState(false)
  const [showProviderForm, setShowProviderForm] = useState(false)
  const [vaultReady, setVaultReady] = useState(false)
  const [backupPassword, setBackupPassword] = useState('')
  const [backupBusy, setBackupBusy] = useState(false)
  const [recovery, setRecovery] = useState<RecoveryInfo | null>(null)
  const [usageTotals, setUsageTotals] = useState<UsageSummary | null>(null)
  const [storage, setStorage] = useState<StorageStats | null>(null)

  useEffect(() => {
    void Promise.all([app.localUser(), app.providers(), app.bindings(), app.usage(), app.secureVaultStatus(),
      app.dataRecovery(), app.usageSummary(), app.storageStats()])
      .then(([user, connectionItems, bindingItems, calls, secure, recoveryInfo, totals, stats]) => {
        if (!profileDirty.current) setProfile({ name: user.name, bio: user.bio })
        setProviders(connectionItems)
        setBindings(bindingItems.filter(item => !item.agentId))
        setUsage(calls)
        setVaultReady(secure)
        setRecovery(recoveryInfo)
        setUsageTotals(totals)
        setStorage(stats)
      }, reason => notify({ text: errorText(reason), tone: 'error' }))
  }, [app, version, notify])

  const mainBinding = bindings.find(item => item.purpose === 'main')
  const totalTokens = (usageTotals?.inputTokens ?? 0) + (usageTotals?.outputTokens ?? 0)

  const editProvider = (provider?: Provider) => {
    if (!provider) {
      setProviderForm({ id: '', name: '', protocol: 'responses', purpose: 'main', baseUrl: '', model: '',
        contextTokens: 32768, outputTokens: 2048 })
      setShowProviderForm(true)
      return
    }
    const binding = mainBinding?.providerId === provider.id ? mainBinding : bindings.find(item => item.providerId === provider.id)
    setProviderForm({
      id: provider.id, name: provider.name, protocol: provider.protocol,
      purpose: binding?.purpose ?? 'main',
      baseUrl: provider.baseUrl, model: binding?.modelId ?? '',
      contextTokens: binding?.contextTokens ?? 32768,
      outputTokens: binding?.outputTokens ?? 2048
    })
    setShowProviderForm(true)
  }

  const addSummaryBinding = async () => {
    const main = bindings.find(item => item.purpose === 'main')
    if (!main?.providerId) {
      notify({ text: '请先保存一个主模型连接', tone: 'error' })
      return
    }
    try {
      await app.saveBinding({ ...main, id: crypto.randomUUID(), purpose: 'summary', revision: 1 })
      notify({ text: '摘要模型已继承主模型', tone: 'ok' })
    } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
  }

  return <section className="me scroll-region">
    <div className="me-hero">
      <div className="me-avatar"><Avatar name={profile.name || '我'} size={92} status="#6EC56A" /></div>
      <h1>{profile.name || '我'}</h1>
      <p>{profile.bio || '本地优先的对话空间'}</p>
      <span className="local-badge"><i /> LOCAL · 数据保存在此设备</span>
    </div>
    <Section title="本地资料">
    <div className="settings-card">
      <label>昵称<input value={profile.name} onChange={event => { profileDirty.current = true; setProfile({ ...profile, name: event.target.value }) }} /></label>
      <label>自我介绍<textarea value={profile.bio} onChange={event => { profileDirty.current = true; setProfile({ ...profile, bio: event.target.value }) }} /></label>
      <button className="wide-primary" onClick={async () => {
        try { await app.saveUserProfile(profile.name, profile.bio); profileDirty.current = false; notify({ text: '本地资料已保存', tone: 'ok' }) }
        catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
      }}>保存资料</button>
    </div>
    </Section>

    <Section title="模型连接">
    <div className="settings-card">
      <div className="card-heading"><span className="card-kicker">当前连接</span><button className="text-button" onClick={() => editProvider()}>＋ 添加连接</button></div>
      {providers.map(provider => <div className="provider-row" key={provider.id}>
        <div><strong>{provider.name}</strong><span>{provider.protocol} · {provider.credentialState === 'stored' ? 'Key 已安全保存' : '缺少 Key'}</span></div>
        <button className="chevron-button" onClick={() => editProvider(provider)}>编辑</button>
      </div>)}
      {!providers.length && <p className="hint">尚未配置模型。Yomi 不会自动连接任何官方服务。</p>}
      {mainBinding && <div className="binding-row">
        <span>上下文摘要：{bindings.some(item => item.purpose === 'summary') ? '已配置' : '未配置'}</span>
        {!bindings.some(item => item.purpose === 'summary') &&
          <button className="link" onClick={() => void addSummaryBinding()}>继承主模型</button>}
      </div>}
      {showProviderForm && <div className="provider-form nested-panel">
        <h4>{providerForm.id ? '编辑连接' : '新连接'}</h4>
        <label>名称<input value={providerForm.name} onChange={event => setProviderForm({ ...providerForm, name: event.target.value })} placeholder="例如：我的模型" /></label>
        <label>协议<select value={providerForm.protocol} onChange={event => setProviderForm({ ...providerForm, protocol: event.target.value as ProviderProtocol })}>
          <option value="responses">Responses</option>
          <option value="chat-completions">Chat Completions</option>
        </select></label>
        <label>Base URL<input value={providerForm.baseUrl} onChange={event => setProviderForm({ ...providerForm, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
        <label>模型 ID<input value={providerForm.model} onChange={event => setProviderForm({ ...providerForm, model: event.target.value })} placeholder="模型名称" /></label>
        <label>默认用途<select value={providerForm.purpose} onChange={event => {
          const purpose = event.target.value as ModelBinding['purpose']
          const existing = bindings.find(item => item.purpose === purpose && item.providerId === providerForm.id)
          setProviderForm({ ...providerForm, purpose, ...(existing ? { model: existing.modelId,
            contextTokens: existing.contextTokens, outputTokens: existing.outputTokens } : {}) })
        }}>
          <option value="main">角色主模型</option><option value="triage">辅助判断模型</option><option value="summary">上下文摘要模型</option>
        </select></label>
        <div className="secure-key-note">
          <strong>API Key</strong>
          <span>{providerForm.id ? '保存时可在系统安全窗口替换 Key；取消则保留原 Key。' : '保存连接时由系统安全窗口输入，网页层不会接收。'}</span>
        </div>
        <div className="two-cols">
          <label>上下文<input type="number" value={providerForm.contextTokens} onChange={event => setProviderForm({ ...providerForm, contextTokens: Number(event.target.value) })} /></label>
          <label>输出上限<input type="number" value={providerForm.outputTokens} onChange={event => setProviderForm({ ...providerForm, outputTokens: Number(event.target.value) })} /></label>
        </div>
        <div className="actions">
          <button className="wide-primary" onClick={async () => {
            try {
              if (!providerForm.name.trim() || !providerForm.baseUrl.trim() || !providerForm.model.trim()) {
                throw new Error('请填写连接名称、Base URL 和模型 ID')
              }
              if (!vaultReady) throw new Error('安全凭证模块不可用，无法保存 API Key')
              const provider = await app.saveProvider({
                id: providerForm.id || crypto.randomUUID(),
                name: providerForm.name,
                protocol: providerForm.protocol,
                baseUrl: providerForm.baseUrl,
                credentialRef: '',
                credentialState: providerForm.id ? providers.find(item => item.id === providerForm.id)?.credentialState ?? 'missing' : 'missing',
                enabled: true,
                configVersion: 1,
                createdAt: 0,
                updatedAt: 0
              }, '__prompt__')
              await app.saveBinding({
                id: crypto.randomUUID(),
                providerId: provider.id,
                modelId: providerForm.model,
                contextTokens: providerForm.contextTokens,
                outputTokens: providerForm.outputTokens,
                purpose: providerForm.purpose,
                revision: 1
              })
              if (providerForm.purpose === 'main' && !bindings.some(item => item.purpose === 'summary')) {
                await app.saveBinding({
                  id: crypto.randomUUID(), providerId: provider.id, modelId: providerForm.model,
                  contextTokens: providerForm.contextTokens, outputTokens: providerForm.outputTokens,
                  purpose: 'summary', revision: 1
                })
              }
              setShowProviderForm(false)
              notify({
                text: provider.credentialState === 'stored'
                  ? '连接已保存到设备'
                  : '连接已保存，API Key 尚未设置',
                tone: 'ok'
              })
            } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
          }}>保存连接</button>
          {providerForm.id && <button className="ghost" onClick={async () => {
            try {
              setTesting(providerForm.id)
              const response = await app.testProvider(providerForm.id, providerForm.model)
              notify({ text: `连接可用：${response}`, tone: 'ok' })
            } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
            finally { setTesting('') }
          }} disabled={testing === providerForm.id}>{testing === providerForm.id ? '测试中…' : '测试连接'}</button>}
          {providerForm.id && <button className="danger" onClick={async () => {
            if (!confirm('删除连接和本机保存的 Key？相关绑定会变为未配置。')) return
            try { await app.deleteProvider(providerForm.id); editProvider(); notify({ text: '连接已删除', tone: 'ok' }) }
            catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
          }}>删除连接</button>}
        </div>
        <p className="hint">Key 由 Android Keystore 加密；数据库和备份不保存明文。主模型需要支持工具调用。</p>
        {!vaultReady && <p className="hint">安全凭证模块自检失败，连接元数据仍可查看，但不能保存 Key。</p>}
      </div>}
    </div>
    </Section>

    <Section title="多媒体设置"><MediaSettingsPanel app={app} notify={notify}/></Section>
    <Section title="世界书">
    <div className="settings-card">
      <p className="hint">世界书存放世界设定。全局卷对全部会话生效；局部卷可绑定聊天或角色。角色绑定在“角色 → 编辑资料 → 角色世界书”管理。条目可以设为常驻，或用关键词在对话命中时注入。</p>
      <div className="actions">
        <button onClick={() => setLorebookOpen(true)}>管理世界书</button>
      </div>
    </div>
    </Section>

    <Section title="后台互动"><div className="settings-card">
      <div className="switch-row"><span>允许锁屏后按规则主动发言</span><button disabled={!app.backgroundSupported()}
        onClick={async () => {
          try { await app.setBackgroundEnabled(!app.runtime.backgroundActive()) }
          catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
        }}>{app.runtime.backgroundActive() ? '已开启' : '关闭'}</button></div>
      <p className="hint">开启后会显示常驻通知并增加耗电；角色新消息会通知你。关闭后仅在应用前台检查定时规则。</p>
      <p className="hint">本次运行有效：应用被系统终止或从最近任务划掉后停止，不会自动重试中断对话。系统省电策略仍可能延迟触发。</p>
      {!app.backgroundSupported() && <p className="hint">当前平台支持前台定时；后台互动目前仅 Android 可用。</p>}
    </div></Section>

    <Section title="用量">
    <div className="settings-card">
      <div className="card-heading"><span className="card-kicker">调用记录</span><button className="text-button" onClick={() => setShowUsage(value => !value)}>{showUsage ? '收起' : '查看'}</button></div>
      <p>{usageTotals?.calls ?? 0} 次模型调用 · 已知 {totalTokens.toLocaleString()} tokens</p>
      {!!usageTotals?.unknownCalls && <p className="hint">{usageTotals.unknownCalls} 次调用的用量不完整；未知部分不计作零。</p>}
      <p className="hint">统计本机保留的全部调用记录；下方最多展示最近 30 条。</p>
      {showUsage && <p className="hint">{usageTotals?.purposes.map(item =>
        `${({ main: '角色回复', triage: '辅助判断', summary: '上下文摘要' } as Record<string, string>)[item.purpose] ?? item.purpose} ${item.calls} 次`).join(' · ')}</p>}
      {showUsage && <div className="usage-list">{usage.slice(0, 30).map(call => <div key={call.id}>
        <span>{new Date(call.startedAt).toLocaleString()}</span>
        <strong>{call.purpose} · {call.status}</strong>
        <small>{call.modelId} · {call.inputTokens === null && call.outputTokens === null ? '用量未知' : `${(call.inputTokens ?? 0) + (call.outputTokens ?? 0)} tokens`}</small>
      </div>)}</div>}
    </div>
    </Section>

    <ModularBackupPanel app={app} notify={notify} />
    <Section title="整机备份与回退">
    <div className="settings-card">
      <p className="hint">备份包含聊天、角色、世界书、媒体、表情包和连接设置，不包含 API Key。文件使用密码加密；恢复会替换本地数据。</p>
      <label>备份密码<input type="password" value={backupPassword} autoComplete="new-password"
        onChange={event => setBackupPassword(event.target.value)} placeholder="导出至少 8 位；恢复填写原密码" disabled={backupBusy} /></label>
      <p className="hint">请妥善保存密码，遗忘后无法解密。旧版未加密的 JSON 备份仍可恢复。</p>
      <div className="actions">
        <button disabled={backupBusy} onClick={async () => {
          setBackupBusy(true)
          try { notify({ text: `备份已写入：${await app.exportBackup(backupPassword)}`, tone: 'ok' }); setBackupPassword('') }
          catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
          finally { setBackupBusy(false) }
        }}>{backupBusy ? '处理中…' : '导出备份'}</button>
        <label className="file-button primary-file">恢复备份<input type="file" disabled={backupBusy} accept=".json,.yomi" onChange={async event => {
          const input = event.currentTarget
          const file = event.target.files?.[0]
          if (!file) return
          input.value = ''
          if (file.size > 150_000_000) { notify({ text: '备份文件超过 150 MB，无法恢复', tone: 'error' }); return }
          if (!confirm('恢复会停止当前生成并替换全部聊天、角色和记忆。API Key 需重新配置。继续？')) return
          setBackupBusy(true)
          try {
            profileDirty.current = false
            await app.importBackup(file.name, await file.text(), backupPassword)
            setBackupPassword('')
            notify({ text: '备份已恢复；请检查模型连接并重新填写 Key', tone: 'ok' })
          } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
          finally { setBackupBusy(false) }
        }} /></label>
      </div>
      {recovery?.note && <p className="hint" role="status">{recovery.note}</p>}
      {recovery?.canRollback && <div>
        <p className="hint">保留了一份切换前的本地数据，可切回。回退不会自动恢复聊天生成。</p>
        <div className="actions">
          <button disabled={backupBusy} onClick={async () => {
            if (!confirm('切回上一份本地数据？当前数据会保留为回退副本，正在生成的回复会停止。')) return
            setBackupBusy(true)
            try { profileDirty.current = false; await app.rollbackData(); notify({ text: '已切回上一份本地数据', tone: 'ok' }) }
            catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
            finally { setBackupBusy(false) }
          }}>切回上一份数据</button>
          <button disabled={backupBusy} className="ghost" onClick={async () => {
            if (!confirm('删除上一份回退副本？当前使用的数据会保留。')) return
            setBackupBusy(true)
            try { await app.discardRecovery(); notify({ text: '回退副本已删除', tone: 'ok' }) }
            catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
            finally { setBackupBusy(false) }
          }}>删除回退副本</button>
        </div>
      </div>}
      <button className="danger" disabled={backupBusy} onClick={async () => {
        const answer = prompt('此操作会删除聊天、角色、记忆和本机 API Key。请输入“清空”确认：')
        if (answer !== '清空') return
        try { await app.clearAll(); notify({ text: '全部本地数据已清空', tone: 'ok' }) }
        catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
      }}>清空全部数据</button>
    </div>
    </Section>
    <Section title="存储与诊断">
    <div className="settings-card">
      {storage && <>
        <p>当前数据库 {(storage.bytes / 1048576).toFixed(1)} MB · 可回收 {(storage.freeBytes / 1048576).toFixed(1)} MB</p>
        <p className="hint">{storage.agents} 个角色 · {storage.conversations} 个会话 · {storage.messages} 条消息 · {storage.memories} 条有效记忆 · {storage.logs} 条运行记录。回退副本单独保留。</p>
      </>}
      <div className="actions">
        <button disabled={backupBusy} className="ghost" onClick={async () => {
          if (!confirm('清理已结束的模型调用与工具记录？聊天和记忆会保留，用量统计也会随记录清理。')) return
          try { await app.clearFinishedLogs(); notify({ text: '已结束的调用与工具记录已清理', tone: 'ok' }) }
          catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
        }}>清理运行记录</button>
        <button disabled={backupBusy} className="ghost" onClick={async () => {
          if (!confirm('压缩本地数据库会停止当前生成，并回收已删除数据的空闲页。继续？')) return
          setBackupBusy(true)
          try { await app.compactStorage(); notify({ text: '数据库已压缩', tone: 'ok' }) }
          catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
          finally { setBackupBusy(false) }
        }}>压缩数据库</button>
        <button disabled={backupBusy} className="ghost" onClick={async () => {
          try { notify({ text: `诊断已写入：${await app.exportDiagnostics()}`, tone: 'ok' }) }
          catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
        }}>导出诊断</button>
      </div>
      <p className="hint">诊断仅包含版本、数量、模型协议、状态和用量，不包含聊天正文、角色资料、模型地址或 API Key。</p>
    </div>
    </Section>
    <Section title="应用更新"><UpdateSettings /></Section>
    <Section title="关于 Yomi">
    <div className="settings-card about">
      <p>本地优先的多 Agent 角色聊天。聊天事实保存在设备 SQLite；回复由你配置的模型服务生成。</p>
      <p>当前版本使用文字记忆和关键词检索，不发送 embedding 请求，支持世界书与角色卡导入，不包含工作型工具。</p>
      <p className="hint">Android v1 · 数据不会自动上传或云同步</p>
    </div>
    </Section>
    <div className="version-note">YOMI · ANDROID v1</div>
    {lorebookOpen && <LorebookSheet app={app} close={() => setLorebookOpen(false)} notify={notify} />}
  </section>
}

function ModularBackupPanel({ app, notify }: { app: AppApi; notify: (notice: Notice) => void }) {
  const [password, setPassword] = useState('')
  const [selected, setSelected] = useState<BackupModule[]>([...moduleIds])
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const [preview, setPreview] = useState<BackupPreview | null>(null)
  const [restoring, setRestoring] = useState<BackupModule[]>([])
  const [overwrite, setOverwrite] = useState(false)
  const [busy, setBusy] = useState(false)
  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    try { await work() } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
    finally { setBusy(false) }
  }
  const toggle = (items: BackupModule[], id: BackupModule) => items.includes(id) ? items.filter(item => item !== id) : [...items, id]
  return <Section title="按模块备份与合并恢复"><div className="settings-card">
    <p className="hint">ZIP 内各模块使用密码加密，不含 API Key。会话、记忆等模块会附带必要的角色和聊天依赖。</p>
    <label>备份密码<input type="password" value={password} disabled={busy}
      onChange={event => { setPassword(event.target.value); setPreview(null); setBytes(null) }} placeholder="至少 8 位；读取备份时填写原密码" /></label>
    <div className="pick-list">{moduleIds.map(id => <label key={id}>
      <input type="checkbox" disabled={busy} checked={selected.includes(id)} onChange={() => setSelected(toggle(selected, id))} />
      {backupModules[id].label}
    </label>)}</div>
    {!!selected.length && <p className="hint">将包含：{withDependencies(selected).map(id => backupModules[id].label).join('、')}</p>}
    <button disabled={busy || !selected.length} onClick={() => void run(async () => {
      const file = await app.exportBackupZip(password, selected)
      notify({ text: `模块备份已写入：${file}`, tone: 'ok' })
    })}>导出加密 ZIP</button>
    <label className="file-button">读取 ZIP 备份<input type="file" accept=".zip" disabled={busy} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''
      setPreview(null); setBytes(null)
      if (!file) return
      void run(async () => {
        if (file.size > 150_000_000) throw new Error('备份文件超过 150 MB')
        const data = new Uint8Array(await file.arrayBuffer())
        const info = await app.previewBackupZip(data, password)
        setBytes(data); setPreview(info); setRestoring(info.modules); setOverwrite(false)
      })
    }} /></label>
    {preview && <div className="nested-panel">
      <p>选择要合并恢复的模块</p>
      <div className="pick-list">{preview.modules.map(id => <label key={id}>
        <input type="checkbox" disabled={busy} checked={restoring.includes(id)} onChange={() => setRestoring(toggle(restoring, id))} />
        {backupModules[id].label} · {preview.counts[id]} 条记录
      </label>)}</div>
      <label className="switch-row"><span>同 ID 内容使用备份版本</span><input type="checkbox" disabled={busy} checked={overwrite} onChange={event => setOverwrite(event.target.checked)} /></label>
      <p className="hint">默认保留现有同 ID 内容，只补充缺失记录。不删除本机新增聊天；未选模块的依赖仅补齐缺失项。恢复的主动发言规则默认停用。</p>
      <button disabled={busy || !restoring.length} onClick={() => void run(async () => {
        if (!bytes || !confirm('合并所选模块？将停止当前生成并保留一份可回退的数据。')) return
        await app.restoreBackupZip(bytes, password, restoring, overwrite)
        setPreview(null); setBytes(null); setPassword('')
        notify({ text: '所选模块已合并，可在下方切回上一份数据', tone: 'ok' })
      })}>合并恢复所选模块</button>
    </div>}
    {busy && <p className="hint">正在处理备份…</p>}
  </div></Section>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="settings-section">
    <h4><span>↳</span> {title}</h4>
    {children}
  </section>
}

async function readImageThumbnail(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('无法读取图片'))
    reader.readAsDataURL(file)
  })
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const size = 256
      const scale = Math.min(size / image.width, size / image.height, 1)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.width * scale))
      canvas.height = Math.max(1, Math.round(image.height * scale))
      const context = canvas.getContext('2d')
      if (!context) { reject(new Error('无法处理图片')); return }
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', 0.84))
    }
    image.onerror = () => reject(new Error('头像图片格式无效'))
    image.src = dataUrl
  })
}

function Empty({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) {
  return <div className="empty"><p>{text}</p>{action && <button onClick={onAction}>{action}</button>}</div>
}

function errorText(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'object' && error && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error || '操作失败')
  const known: Record<string, string> = {
    credential_missing: '凭证缺失，请重新填写 API Key。',
    origin_mismatch: '连接地址已改变，请重新填写 API Key。',
    cancelled: '请求已取消。',
    network_error: '无法连接模型服务，请检查网络和地址。',
    http_401: '模型服务拒绝了凭证，请检查 API Key。',
    http_403: '模型服务不允许当前请求。',
    http_429: '模型服务暂时限流，请稍后再试。'
  }
  return known[message] ?? message ?? '操作失败'
}

function formatClock(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

function formatRelative(value: number): string {
  const elapsed = Date.now() - value
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时`
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)} 天`
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(value))
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><UpdateProvider><App /></UpdateProvider></React.StrictMode>)
