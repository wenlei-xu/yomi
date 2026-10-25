import { androidUpdates, Updater } from './update/bridge'
import { UpdateProvider, UpdateSettings } from './update/UpdateCenter'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App as CapacitorApp } from '@capacitor/app'
import { createApp, type AppApi, type RecoveryInfo } from './app/bootstrap'
import { Avatar, AvatarStack, conversationAvatar } from './components/avatar'
import { AgentEditor } from './components/agentEditor'
import { AgentProfile } from './components/agentProfile'
import { readImageThumbnail } from './components/avatarImage'
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
  SmileIcon,
  KeyboardIcon,
  SettingsIcon,
  MemoryIcon,
  UploadIcon,
  RefreshIcon,
  ChevronRightIcon,
  StopIcon,
  WhisperIcon
} from './components/icons'
import { MessageSearch } from './components/messageSearch'
import { ConversationMemoryPanel } from './components/conversationMemory'
import { MarkdownText, EmoticonText } from './components/markdown'
import { LorebookSheet,WorldBookBindings } from './components/lorebooks'
import { MediaSheet,MediaAttachment,MessageAudio } from './components/media'
import { ChatExpressionPicker } from './components/chatExpressions'
import { ChatInput, type ChatInputHandle } from './components/chatInput'
import { ModelSettings } from './components/modelSettings'
import { GroupInfo } from './components/groupInfo'
import { CardImport,Greetings } from './components/cardImport'
import type {
  Actor,
  AgentStatus,
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
  RuntimeIssue,
  UsageSummary,
  StorageStats,
  Sticker,
  SearchHit
} from './domain/types'
import { backupModules, moduleIds, withDependencies, type BackupModule, type BackupPreview } from './data/modularBackup'
import './styles.css'
import './components/roleplay.css'
import './components/settings.css'
import './components/agents.css'
import './components/agentProfile.css'
import './components/expressions.css'
import './components/groupInfo.css'

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
            <button className="btn-secondary" onClick={() => openConversation(issue.conversationId)}>打开</button>
            <button className="btn-primary" onClick={() => void app.retry(issue.conversationId)}>重试</button>
            <button className="btn-quiet" onClick={() => void app.ignoreRecovery(issue.conversationId)}>略过</button>
          </div>
        </div>)}
      </div>}
      {filtered.length === 0
        ? <Empty text="还没有聊天。先创建角色，再打开单聊或建群。" action="去创建角色" onAction={goToAgents} icon={<ChatIcon />} />
        : <div className="conversation-rows scroll-region">{filtered.map(item => {
          const visual = conversationAvatar(item, actors)
          return <button className="row conversation-row" key={item.id} onClick={() => openConversation(item.id)}>
          {visual.actor
            ? <Avatar actor={visual.actor} size={48} />
            : <AvatarStack actors={actors.filter(actor => item.members.includes(actor.id))} names={visual.names} size={48} />}
          <div className="row-copy">
            <strong>{item.title} {item.muted && <span className="muted-mark">静音</span>}</strong>
            <span><EmoticonText text={item.lastMessage || '暂无消息'}/></span>
          </div>
          <div className="row-meta">
            <small className="row-time">{formatRelative(item.updatedAt)}</small>
            {item.unread > 0 && <i>{item.unread > 99 ? '99+' : item.unread}</i>}
            {(item.paused || item.hidden) && <span className="row-state">{item.paused ? '已停止' : '已隐藏'}</span>}
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
  const [groupInfoPage, setGroupInfoPage] = useState<'home' | 'announcement'>('home')
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
  const [profileAgent, setProfileAgent] = useState<Actor | null>(null)
  const [editingChatAgent, setEditingChatAgent] = useState<Actor | null>(null)
  const [agentStatusBusy, setAgentStatusBusy] = useState(false)
  const [expressionOpen,setExpressionOpen]=useState(false)
  const [messageMenuId, setMessageMenuId] = useState<string | null>(null)
  const [messageReactionId, setMessageReactionId] = useState<string | null>(null)
  const [messageMenuPlacement, setMessageMenuPlacement] = useState<'above' | 'below'>('below')
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressStart = useRef<{ x: number; y: number } | null>(null)
  const longPressTriggered = useRef(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const targetRef = useRef<HTMLElement>(null)
  const chatInputRef = useRef<ChatInputHandle>(null)
  const [draftReadyFor, setDraftReadyFor] = useState<string | null>(null)
  const pendingSend = useRef<{ fingerprint: string; id: string } | null>(null)
  const sendingRef = useRef(false)

  useEffect(() => { setExpressionOpen(false); setMessageMenuId(null); setMessageReactionId(null) }, [conversationId, readOnly])
  useEffect(() => () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current)
  }, [])

  const clearMessageLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current)
    longPressTimer.current = null
    longPressStart.current = null
  }
  const showMessageActions = (messageId: string, bubble?: HTMLDivElement) => {
    const stack = bubble?.closest<HTMLElement>('.message-stack')
    const viewport = bubble?.closest<HTMLElement>('.messages')
    if (stack && viewport) {
      const stackRect = stack.getBoundingClientRect()
      const viewportRect = viewport.getBoundingClientRect()
      const spaceAbove = stackRect.top - viewportRect.top
      const spaceBelow = viewportRect.bottom - stackRect.bottom
      setMessageMenuPlacement(spaceBelow < 260 && spaceAbove > spaceBelow ? 'above' : 'below')
    }
    longPressTriggered.current = true
    setMessageMenuId(messageId)
    setMessageReactionId(null)
  }
  const startMessageLongPress = (event: React.PointerEvent<HTMLDivElement>, messageId: string) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('button:not(.media-image-button),a,audio,input,textarea,video')) return
    clearMessageLongPress()
    longPressTriggered.current = false
    longPressStart.current = { x: event.clientX, y: event.clientY }
    const bubble = event.currentTarget
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null
      showMessageActions(messageId, bubble)
    }, 500)
  }
  const moveMessageLongPress = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = longPressStart.current
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) clearMessageLongPress()
  }

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
  const directAgent = conversation.kind === 'direct' ? members[0] : undefined
  const directUnavailable = conversation.kind === 'direct' && (!directAgent || !directAgent.enabled || directAgent.archived)

  const send = async () => {
    if (!draft.trim() || sendingRef.current || readOnly || directUnavailable || draftReadyFor !== conversationId) return
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

  const insertEmoji = (code: string) => {
    chatInputRef.current?.insert(code)
    setMentionQuery(null)
  }

  const sendSticker = async (sticker: Sticker, commandId: string) => {
    if (directUnavailable) throw new Error('请先启用角色再发送消息')
    if (conversation.paused || readOnly) throw new Error('请先恢复聊天')
    await app.sendSticker(conversationId, sticker.id, commandId)
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
    : members.filter(actor => actor.enabled && !actor.archived && actor.name.toLowerCase().includes(mentionQuery.toLowerCase()))

  return <section className="chat">
    <header className="chat-header">
      <button className="icon-button" onClick={close} aria-label="返回"><BackIcon /></button>
      {directAgent && <button className="chat-role-avatar" aria-label={`查看角色资料 ${directAgent.name}`} onClick={() => setProfileAgent(directAgent)}>
        <Avatar actor={directAgent} size={36} showStatus={false} /></button>}
      <button className="title-button" onClick={() => {
        if (conversation.kind === 'direct' && directAgent) setProfileAgent(directAgent)
        else { setGroupInfoPage('home'); setShowInfo(true) }
      }}>
        <strong>{conversation.title}</strong>
        <span>
          {readOnly ? '角色私聊 · 只读旁观' : conversation.kind === 'group'
            ? `${conversation.members.length} 位成员 · ${running.length ? '正在回应' : conversation.paused ? '已停止' : '在线'}`
            : !directAgent ? '角色已删除 · 历史保留' : directAgent.archived ? '角色已归档' : !directAgent.enabled ? '角色已停用' : conversation.paused ? '已停止' : '角色在线'}
        </span>
      </button>
      {running.length > 0 || waiting.length > 0
        ? <button className="header-stop" onClick={() => setConfirmStop(true)} aria-label="停止生成"><StopIcon /></button>
        : conversation.paused
          ? <button className="header-text-action" onClick={() => app.resume(conversationId)}>继续</button>
          : null}
      <button className="icon-button" onClick={() => {
        if (conversation.kind === 'group') { setGroupInfoPage('home'); setShowInfo(true) }
        else setShowMore(true)
      }} aria-label="更多"><MoreIcon /></button>
    </header>
    {conversation.kind === 'group' && conversation.announcement && <button type="button" className="group-announcement-banner" onClick={() => { setGroupInfoPage('announcement'); setShowInfo(true) }}>
      <strong>群公告</strong><span>{conversation.announcement}</span><ChevronRightIcon/>
    </button>}
    {readOnly && <div className="readonly-banner">角色间对话，你正在旁观。你不能在这里代任何角色发言。</div>}
    {directUnavailable && <div className="status-banner agent-disabled-banner">
      <span>{!directAgent ? '角色已删除，仍可查看历史消息。' : directAgent.archived ? '角色已归档，恢复并启用后可继续聊天。' : '角色已停用，聊天与记忆已保留。'}</span>
      {directAgent && <button className="link" disabled={agentStatusBusy} onClick={async () => {
        setAgentStatusBusy(true)
        try { await app.setAgentStatus(directAgent.id, 'active'); notify({ text: '角色已启用，可以继续聊天', tone: 'ok' }) }
        catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
        finally { setAgentStatusBusy(false) }
      }}>{agentStatusBusy ? '处理中…' : directAgent.archived ? '恢复并启用' : '启用角色'}</button>}
    </div>}
    {conversation.paused && <div className="status-banner">互动已停止；历史仍保留，点击“继续”才会重新判断。</div>}
    {running.length > 0 && <div className="typing-banner">
      <span className="typing-dots"><i /><i /><i /></span>
      <span>{running.map(run => members.find(actor => actor.id === run.agentId)?.name || '角色').join('、')} 正在思考</span>
      <button className="btn-danger" onClick={() => setConfirmStop(true)}>停止</button>
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
    <div className="messages" onPointerDownCapture={() => { longPressTriggered.current = false }} onClick={() => {
      if (longPressTriggered.current) { longPressTriggered.current = false; return }
      setMentionQuery(null); setExpressionOpen(false); setMessageMenuId(null); setMessageReactionId(null); chatInputRef.current?.blur()
    }}>
      {hasOlder && <button className="load-older" onClick={() => void loadOlder()}>加载更早消息</button>}
      {messages.map(item => {
        const mine = item.authorId === 'local-user'
        const author = members.find(actor => actor.id === item.authorId)
        const stickerMessage = !item.deleted && Boolean(item.mediaId) && (item.sticker || item.body.startsWith('表情包：'))
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
              <small>{mine ? '你' : author?.name ?? item.authorName}</small>
              <span>{formatClock(item.createdAt)}{item.editedAt && !item.recalled ? ' · 已编辑' : ''}{item.recalled ? ' · 已撤回' : ''}</span>
            </div>
            <div className={'message-bubble' + (stickerMessage ? ' sticker-bubble' : '')}
              tabIndex={!item.deleted && !item.recalled ? 0 : undefined}
              aria-haspopup={!item.deleted && !item.recalled ? 'menu' : undefined}
              aria-expanded={!item.deleted && !item.recalled ? messageMenuId === item.id : undefined}
              onPointerDown={!item.deleted && !item.recalled ? event => startMessageLongPress(event, item.id) : undefined}
              onPointerMove={moveMessageLongPress}
              onPointerUp={clearMessageLongPress}
              onPointerCancel={clearMessageLongPress}
              onPointerLeave={() => { if (longPressTimer.current) clearMessageLongPress() }}
              onClickCapture={event => {
                if (!longPressTriggered.current) return
                event.preventDefault()
                event.stopPropagation()
                longPressTriggered.current = false
              }}
              onContextMenu={!item.deleted && !item.recalled ? event => {
                event.preventDefault()
                clearMessageLongPress()
                showMessageActions(item.id, event.currentTarget)
              } : undefined}
              onKeyDown={!item.deleted && !item.recalled ? event => {
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault()
                  showMessageActions(item.id, event.currentTarget)
                }
              } : undefined}>
              {item.quotedId && <button
                className="quote"
                onClick={() => {
                  const target = messages.find(message => message.id === item.quotedId)
                  if (target) document.getElementById(`message-${target.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                  else if (item.quotedId) setJumpId(item.quotedId)
                }}
              ><EmoticonText text={messages.find(message => message.id === item.quotedId)?.body.slice(0, 100) ?? '引用的消息不可见'}/></button>}
              {item.deleted
                ? <p className="deleted-message">消息已删除</p>
                : item.recalled
                  ? <p className="recalled-message">{mine ? '你撤回了一条消息' : `${author?.name ?? item.authorName}撤回了一条消息`}</p>
                  : (!stickerMessage || !item.body.startsWith('表情包：')) && <MarkdownText text={item.body} />}
              {!item.deleted && item.mediaId && <MediaAttachment app={app} assetId={item.mediaId} variant={stickerMessage ? 'sticker' : undefined} notify={notify}/>}
              {!item.deleted && item.authorKind==='agent' && !item.mediaId &&
                <MessageAudio app={app} message={item} version={version}/>}
            </div>
            {!item.deleted && !item.recalled && <>
              {!!item.reactions.length && <div className="message-reactions" aria-label="消息表情">
                {item.reactions.map(reaction => <button type="button" key={reaction.emoji} className={reaction.actorIds.includes('local-user') ? 'mine' : ''}
                  aria-label={`${reaction.emoji} ${reaction.actorIds.length} 人，点击切换`} onClick={() => void app.react(item.id, reaction.emoji).catch(reason => notify({text:errorText(reason),tone:'error'}))}>
                  {reaction.emoji}<small>{reaction.actorIds.length}</small></button>)}
              </div>}
              {messageMenuId === item.id && <div className={`message-action-menu${messageMenuPlacement === 'above' ? ' menu-above' : ''}`} role="menu" aria-label="消息操作" onClick={event => event.stopPropagation()}>
                {!readOnly && <button type="button" role="menuitem" onClick={() => {
                  setQuoted(item); setMessageMenuId(null); setMessageReactionId(null); requestAnimationFrame(() => chatInputRef.current?.focus())
                }}>回复</button>}
                {!readOnly && <button type="button" role="menuitem" onClick={() => {
                  setMessageMenuId(null); setMessageReactionId(item.id)
                }}>表情</button>}
                {!readOnly && <button type="button" role="menuitem" onClick={() => { setEditor(item); setEditBody(item.body); setMessageMenuId(null); setMessageReactionId(null) }}>编辑消息</button>}
                {!readOnly && mine && <button type="button" role="menuitem" onClick={async () => {
                  setMessageMenuId(null); setMessageReactionId(null)
                  if (!confirm('撤回这条消息？角色会看到撤回提示，原文不再提供给后续请求。')) return
                  try { await app.recallMessage(item.id) } catch(reason) { notify({text:errorText(reason),tone:'error'}) }
                }}>撤回消息</button>}
                {!readOnly && item.authorKind === 'agent' && openBranch && <button type="button" role="menuitem" disabled={messageBusy} onClick={async () => {
                  setMessageMenuId(null); setMessageReactionId(null)
                  if (!confirm('从这条回复之前新建分支并重新生成？原会话及后续消息会保留。')) return
                  setMessageBusy(true)
                  try { openBranch(await app.regenerateMessage(item.id)) } catch(reason) { notify({text:errorText(reason),tone:'error'}) }
                  finally { setMessageBusy(false) }
                }}>重新生成</button>}
                <button type="button" role="menuitem" className="danger" onClick={() => {
                  setMessageMenuId(null); setMessageReactionId(null)
                  if (confirm('删除这条消息？引用和自动来源记忆将失效。')) void app.deleteMessage(item.id).catch(reason => notify({text:errorText(reason),tone:'error'}))
                }}>删除消息</button>
              </div>}
              {messageReactionId === item.id && <div className={`message-reaction-menu${messageMenuPlacement === 'above' ? ' menu-above' : ''}`} role="group" aria-label="选择表情" onClick={event => event.stopPropagation()}>
                <div className="message-emoji-row" aria-label="快速表情">
                  {['❤️','👍','😂','😮','😢','🙏'].map(emoji => <button type="button" key={emoji} aria-label={`表情 ${emoji}`}
                    onClick={() => { void app.react(item.id, emoji).catch(reason => notify({text:errorText(reason),tone:'error'})); setMessageReactionId(null) }}>{emoji}</button>)}
                </div>
              </div>}
            </>}
          </div>
        </article>
      })}
      {!readOnly && !messages.length && conversation.kind==='direct' && members[0] &&
        <Greetings app={app} actorId={members[0].id} conversationId={conversationId} version={version} notify={notify}/>}
      {!messages.length && <Empty text={readOnly ? '角色还没有开始私聊。' : '还没有消息，先打个招呼吧。'} />}
      {hasNewer && <button className="load-newer" onClick={() => void loadNewer()}>有新消息 · 跳到最新</button>}
      {streaming.map(item => <article className="message streaming-message" key={`stream-${item.agentId}`} aria-live="polite">
        <div className="message-stack"><small>{members.find(actor => actor.id === item.agentId)?.name ?? '角色'} · 正在输入</small>
          <div className="message-bubble"><MarkdownText text={item.text}/></div><small>生成预览，完成后保存</small></div>
      </article>)}
      <div ref={bottomRef} />
    </div>
    {chatMediaActor && <MediaSheet app={app} agent={chatMediaActor} conversationId={conversationId} notify={notify} close={()=>setChatMediaActor(null)}/>}
    {editingChatAgent && <AgentEditor key={editingChatAgent.id} app={app} initial={editingChatAgent} close={() => setEditingChatAgent(null)} notify={notify} />}
    {profileAgent && <AgentProfile actor={profileAgent} close={() => setProfileAgent(null)}
      edit={() => { setEditingChatAgent(profileAgent); setProfileAgent(null) }}
      openMedia={() => { setChatMediaActor(profileAgent); setProfileAgent(null) }} />}
    {!readOnly && <form className={'chat-composer' + (expressionOpen ? ' expressions-open' : '')} onSubmit={event => { event.preventDefault(); void send() }}>
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
            requestAnimationFrame(() => chatInputRef.current?.focus())
          }}>
            <Avatar actor={actor} size={34} showStatus={false} />
            <span>{actor.name}</span>
          </button>)
          : <div className="quiet-loading">没有匹配的角色</div>}
      </div>}
      <div className="composer-row">
        {conversation.kind === 'group' && <button
          className="composer-tool"
          type="button"
          onClick={() => { setMentionQuery(''); chatInputRef.current?.focus() }}
          aria-label="点名角色"
        ><AtIcon /></button>}
        <ChatInput
          ref={chatInputRef}
          disabled={directUnavailable || draftReadyFor !== conversationId}
          value={draft}
          onChange={value => {
            setDraft(value)
            if (conversation.kind === 'group') {
              const match = /(^|\s)@([^\s@]*)$/.exec(value)
              setMentionQuery(match ? match[2] : null)
            }
          }}
          onFocus={() => setExpressionOpen(false)}
          onSend={() => void send()}
          placeholder={directUnavailable ? '角色启用后可继续聊天' : conversation.kind === 'group' ? '发消息给群聊' : `发消息给 ${conversation.title}`}
        />
        <button className="composer-tool expression-toggle" type="button" disabled={directUnavailable || !members.length || busy || conversation.paused}
          aria-label={expressionOpen ? '切换到键盘' : '打开表情'} aria-expanded={expressionOpen} onPointerDown={event => event.preventDefault()}
          onClick={() => {
            if (expressionOpen) { setExpressionOpen(false); chatInputRef.current?.focus() }
            else { chatInputRef.current?.blur(); setMentionQuery(null); setExpressionOpen(true) }
          }}>{expressionOpen ? <KeyboardIcon/> : <SmileIcon/>}</button>
        {!draft.trim() && <button className="composer-tool" type="button" disabled={directUnavailable || !members.length || busy || conversation.paused} aria-label="图片与语音"
          onClick={() => { setExpressionOpen(false); setChatMediaActor(members[0]) }}><PlusIcon/></button>}
        {Boolean(draft.trim()) && <button className="send-button composer-send" type="submit" disabled={directUnavailable || busy || draftReadyFor !== conversationId} aria-label="发送" onPointerDown={event => event.preventDefault()}>
          {busy ? <span className="send-spinner" /> : <SendIcon />}
        </button>}
      </div>
      {expressionOpen && <ChatExpressionPicker app={app} version={version} disabled={directUnavailable || busy || conversation.paused || draftReadyFor !== conversationId}
        hasDraft={!!draft} close={() => setExpressionOpen(false)} onEmoji={insertEmoji} onBackspace={() => chatInputRef.current?.backspace()}
        onSticker={sendSticker} notify={notify} />}
    </form>}
    {showInfo && (conversation.kind === 'group' ? <GroupInfo
      app={app} version={version} conversation={conversation} initialPage={groupInfoPage}
      close={() => setShowInfo(false)} deleted={() => { setShowInfo(false); close() }}
      search={() => { setShowInfo(false); setChatSearch(true) }}
      viewAgent={agent => { setShowInfo(false); setProfileAgent(agent) }}
      renderAdvanced={(room, actors) => <>
        <WorldBookBindings app={app} conversationId={room.id} notify={notify}/>
        <ConversationNotes app={app} conversation={room} members={actors} notify={notify}/>
        <ConversationMemoryPanel app={app} conversation={room} members={actors} notify={notify}/>
        <ProactiveRules app={app} conversation={room} members={actors} notify={notify}/>
      </>}
      notify={notify}
    /> : <ConversationSheet
      app={app}
      version={version}
      conversation={conversation}
      viewAgent={agent => { setShowInfo(false); setProfileAgent(agent) }}
      close={() => setShowInfo(false)}
      notify={notify}
    />)}
    {showMore && <div className="sheet-backdrop" onClick={() => setShowMore(false)}>
      <div className="sheet menu-sheet action-sheet" onClick={event => event.stopPropagation()}>
        <div className="sheet-handle" />
        <h3>{conversation.title}</h3>
        {directAgent && <button className="sheet-action" onClick={() => { setProfileAgent(directAgent); setShowMore(false) }}>查看角色资料</button>}
        {conversation.kind === 'direct' && <button className="sheet-action" onClick={() => { setShowInfo(true); setShowMore(false) }}>会话资料与设置</button>}
        <button className="sheet-action" onClick={() => {setChatSearch(true);setShowMore(false)}}>搜索本会话</button>
        <button className="sheet-action" onClick={async () => {
          try { notify({ text: `已导出：${await app.exportConversation(conversationId, 'markdown')}`, tone: 'ok' }) }
          catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
        }}>导出 Markdown</button>
        <button className="sheet-action" onClick={async () => {
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
      <div className="sheet-heading"><h3>搜索本会话</h3><button type="button" className="sheet-close" aria-label="关闭搜索" onClick={() => setChatSearch(false)}><CloseIcon /></button></div>
      <MessageSearch app={app} conversationId={conversationId} open={hit => {setJumpId(hit.id);setChatSearch(false)}}/>
    </div></div>}
    {editor && <div className="sheet-backdrop" onClick={() => {if(!messageBusy)setEditor(null)}}><div className="sheet" role="dialog" aria-modal="true" aria-label="编辑消息" onClick={event => event.stopPropagation()}>
      <h3>编辑消息</h3><p>会停止当前生成并使相关自动记忆、摘要失效；后续消息保留，不会自动重跑。</p>
      <textarea aria-label="消息正文" rows={7} maxLength={32768} value={editBody} disabled={messageBusy} onChange={event => setEditBody(event.target.value)}/>
      {(editor.editHistory ?? []).length > 0 && <details><summary>历史版本（选择后保存）</summary>{[...(editor.editHistory ?? [])].reverse().map((entry,index) =>
        <button className="history-version" key={index} disabled={messageBusy} onClick={() => setEditBody(entry.body)}>{new Date(entry.at).toLocaleString()} · {entry.body.slice(0,120)}</button>)}</details>}
      <div className="actions"><button className="btn-primary" disabled={messageBusy || !editBody.trim()} onClick={async () => {
        setMessageBusy(true)
        try {await app.editMessage(editor.id,editBody);setEditor(null)} catch(reason){notify({text:errorText(reason),tone:'error'})}
        finally{setMessageBusy(false)}
      }}>保存</button><button className="btn-quiet" disabled={messageBusy} onClick={() => setEditor(null)}>取消</button></div>
    </div></div>}
    {confirmStop && <div className="dialog-backdrop" onClick={() => setConfirmStop(false)}>
      <div className="dialog" onClick={event => event.stopPropagation()}>
        <div className="dialog-icon"><StopIcon /></div>
        <h3>停止本轮互动？</h3>
        <p>当前生成和本轮剩余发言会同时取消。已完成的回复会保留，重启后可手动重试。</p>
        <div className="dialog-actions">
          <button className="btn-quiet" onClick={() => setConfirmStop(false)}>继续等待</button>
          <button className="btn-danger" onClick={() => { app.stop(conversationId); setConfirmStop(false) }}>停止</button>
        </div>
      </div>
    </div>}
  </section>
}

function ConversationSheet(props: {
  app: AppApi
  version: number
  conversation: Conversation
  viewAgent: (agent: Actor) => void
  close: () => void
  notify: (notice: Notice) => void
}) {
  const { app, version, conversation, viewAgent, close, notify } = props
  const [pinned, setPinned] = useState(conversation.pinned)
  const [muted, setMuted] = useState(conversation.muted)
  const [autonomyPaused, setAutonomyPaused] = useState(conversation.autonomyPaused)
  const [hidden, setHidden] = useState(conversation.hidden)
  const [detailMembers, setDetailMembers] = useState<Actor[]>([])
  const [savingField, setSavingField] = useState('')


  useEffect(() => { void app.actors().then(items => {
    setDetailMembers(items.filter(item => conversation.members.includes(item.id) && item.id !== 'local-user'))
  }).catch(reason => notify({ text: errorText(reason), tone: 'error' })) }, [app, conversation.members, version, notify])

  const saveToggle = async (field: 'pinned' | 'muted' | 'autonomyPaused' | 'hidden', next: boolean) => {
    if (savingField) return
    setSavingField(field)
    try {
      await app.updateConversation(conversation.id, { [field]: next })
      if (field === 'pinned') setPinned(next)
      if (field === 'muted') setMuted(next)
      if (field === 'autonomyPaused') setAutonomyPaused(next)
      if (field === 'hidden') setHidden(next)
    } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
    finally { setSavingField('') }
  }


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
      <div className="conversation-section-heading"><span>会话角色</span><small>点击查看角色资料</small></div>
      <div className="conversation-role-list" aria-label="管理会话角色">
        {detailMembers.map(agent => <button type="button" key={agent.id} onClick={() => viewAgent(agent)}>
          <Avatar actor={agent} size={38} showStatus={false} />
          <span><strong>{agent.name}</strong><small>{agent.archived ? '已归档' : agent.enabled ? '已启用' : '已停用'}</small></span>
          <span>查看资料 <ChevronRightIcon /></span>
        </button>)}
      </div>
      <div className="conversation-section-heading"><span>聊天设置</span><small>开关修改后会立即保存</small></div>
      <div className="settings-toggle-group">
        <div className="switch-row"><span>置顶聊天</span><input type="checkbox" aria-label="置顶聊天" checked={pinned} disabled={!!savingField} onChange={event => void saveToggle('pinned', event.target.checked)} /></div>
        <div className="switch-row"><span>消息免打扰</span><input type="checkbox" aria-label="消息免打扰" checked={muted} disabled={!!savingField} onChange={event => void saveToggle('muted', event.target.checked)} /></div>
        <div className="switch-row"><span>暂停角色自主互动</span><input type="checkbox" aria-label="暂停角色自主互动" checked={autonomyPaused} disabled={!!savingField} onChange={event => void saveToggle('autonomyPaused', event.target.checked)} /></div>
        <div className="switch-row"><span>从消息列表隐藏</span><input type="checkbox" aria-label="从消息列表隐藏" checked={hidden} disabled={!!savingField} onChange={event => void saveToggle('hidden', event.target.checked)} /></div>
      </div>
      <WorldBookBindings app={app} conversationId={conversation.id} notify={notify}/>
      <ConversationNotes app={app} conversation={conversation} members={detailMembers} notify={notify} />
      <ConversationMemoryPanel app={app} conversation={conversation} members={detailMembers} notify={notify} />
      <ProactiveRules app={app} conversation={conversation} members={detailMembers} notify={notify} />
      <button className="wide-primary" onClick={close}>完成</button>
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
  const [actors, setActors] = useState<Actor[]>([])
  const [loadError, setLoadError] = useState('')
  useEffect(() => {
    let active = true
    void Promise.all([app.whispers(), app.actors()]).then(([conversations, people]) => {
      if (active) { setItems(conversations); setActors(people); setLoadError('') }
    }, reason => { if (active) setLoadError(errorText(reason)) })
    return () => { active = false }
  }, [app, version])
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
    {loadError && <p className="hint" role="alert">{loadError}</p>}
    {items.length === 0
      ? <Empty text="角色之间还没有自动开启私聊。" />
      : <div className="conversation-rows scroll-region">{items.map(item => <button className="row conversation-row" key={item.id} onClick={() => openConversation(item.id)}>
        <AvatarStack actors={actors.filter(actor => item.members.includes(actor.id) && actor.kind === 'agent')} names={item.memberNames} size={44} />
        <div className="row-copy"><strong>{item.title} {item.muted && <span className="muted-mark">静音</span>}</strong><span><EmoticonText text={item.lastMessage || '暂无消息'}/></span></div>
        <div className="row-meta">
          <small className="row-time">{formatRelative(item.updatedAt)}</small>
          {item.unread > 0 && <i>{item.unread > 99 ? '99+' : item.unread}</i>}
          {item.paused && <span className="row-state">已停止</span>}
        </div>
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
  const [agentFilter, setAgentFilter] = useState<'current' | 'active' | 'disabled' | 'archived'>('current')
  const [agentQuery, setAgentQuery] = useState('')
  const [managing, setManaging] = useState<Actor | null>(null)
  const [agentBusy, setAgentBusy] = useState(false)
  const [statusAgentId, setStatusAgentId] = useState('')
  const [editing, setEditing] = useState<Partial<Actor> | 'new' | null>(null)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupTopic, setGroupTopic] = useState('')
  const [selectedAgents, setSelectedAgents] = useState<string[]>([])
  const [memoryAgent, setMemoryAgent] = useState<Actor | null>(null)
  const [mediaAgent, setMediaAgent] = useState<Actor | null>(null)

  useEffect(() => {
    let current = true
    void app.actors().then(items => { if (current) setAgents(items.filter(item => item.kind === 'agent')) },
      reason => { if (current) notify({ text: errorText(reason), tone: 'error' }) })
    return () => { current = false }
  }, [app, version, notify])
  const visible = agents.filter(item => (agentFilter === 'archived' ? item.archived : !item.archived &&
    (agentFilter === 'current' || (agentFilter === 'active' ? item.enabled : !item.enabled))) &&
    `${item.name} ${item.bio}`.toLowerCase().includes(agentQuery.trim().toLowerCase()))
  const active = agents.filter(item => !item.archived && item.enabled)
  const changeAgentStatus = async (agent: Actor, status: AgentStatus) => {
    if (agentBusy) return
    setAgentBusy(true); setStatusAgentId(agent.id)
    try {
      await app.setAgentStatus(agent.id, status)
      setManaging(null)
      notify({ text: status === 'active' ? '角色已启用，从新消息继续聊天' : status === 'archived' ? '角色已归档，聊天与记忆保留' : '角色已停用，聊天与记忆保留', tone: 'ok' })
    } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
    finally { setAgentBusy(false); setStatusAgentId('') }
  }

  return <section className="list agents-page">
    <div className="page-sticky">
      <div className="agents-title">
        <h1>你的角色 <em>共 {agents.length} 位</em></h1>
        <p>随时调整角色资料、头像与互动状态</p>
      </div>
    </div>
    <div className="agents-scroll scroll-region">
      <div className="agent-stat-row agent-filter-row" aria-label="角色状态筛选">
        {([{ id: 'current', label: '全部', count: agents.filter(agent => !agent.archived).length },
          { id: 'active', label: '已启用', count: active.length },
          { id: 'disabled', label: '已停用', count: agents.filter(agent => !agent.archived && !agent.enabled).length },
          { id: 'archived', label: '已归档', count: agents.filter(agent => agent.archived).length }] as const).map(filter =>
          <button type="button" key={filter.id} aria-pressed={agentFilter === filter.id} onClick={() => setAgentFilter(filter.id)}>{filter.label} <b>{filter.count}</b></button>)}
      </div>
      <div className="agent-actions">
        {(agents.length > 0 || !!agentQuery || agentFilter !== 'current') &&
          <button className="btn-primary" onClick={() => setEditing('new')}><PlusIcon /> 新角色</button>}
        <button className="btn-secondary" onClick={() => setCreatingGroup(true)} disabled={!active.length}><ChatIcon /> 建群</button>
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
      </div>
      <input className="agent-search" type="search" aria-label="搜索角色" placeholder="搜索角色名称或简介" value={agentQuery} onChange={event => setAgentQuery(event.target.value)} />
      <div className="agent-grid">
        {visible.map(agent => <article className={`agent-card ${agent.archived ? 'archived' : ''}`} key={agent.id}>
          <button className="agent-card-main" aria-label={`编辑角色 ${agent.name}`} onClick={() => setEditing(agent)}>
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
          <div className="agent-card-actions">
            <button className="btn-quiet" onClick={() => setEditing(agent)}>编辑资料</button>
            <button className="btn-quiet" onClick={async () => {
              try { openConversation(await app.openDirect(agent.id)) }
              catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
            }}>{agent.enabled && !agent.archived ? '聊天' : '聊天记录'}</button>
            <button className="btn-quiet" disabled={agentBusy} onClick={() => void changeAgentStatus(agent, agent.archived ? 'active' : agent.enabled ? 'disabled' : 'active')}>
              {statusAgentId === agent.id ? '处理中…' : agent.archived ? '恢复并启用' : agent.enabled ? '停用' : '启用'}</button>
            <button className="btn-icon" aria-label={`管理角色 ${agent.name}`} onClick={() => setManaging(agent)}><MoreIcon /></button>
          </div>
        </article>)}
      </div>
      {!visible.length && <Empty text={agentQuery ? '没有找到这个角色。' : agentFilter === 'archived' ? '还没有归档角色。' : agentFilter === 'disabled' ? '没有停用的角色。' : '这里还没有角色。'}
        action={!agents.length && !agentQuery && agentFilter === 'current' ? '创建第一个角色' : undefined} onAction={() => setEditing('new')} icon={<AgentsIcon />} />}
    </div>
    {editing && <AgentEditor
      key={editing === 'new' ? 'new' : editing.id}
      app={app}
      initial={editing === 'new' ? null : editing}
      close={() => setEditing(null)}
      notify={notify}
    />}
    {managing && <div className="sheet-backdrop" onClick={() => { if (!agentBusy) setManaging(null) }}>
      <div className="sheet menu-sheet action-sheet" role="dialog" aria-label={`${managing.name}的角色管理`} onClick={event => event.stopPropagation()}>
        <div className="sheet-handle" /><h3>{managing.name}</h3>
        <button className="btn-quiet" disabled={agentBusy} onClick={() => { setEditing(managing); setManaging(null) }}>编辑头像与资料</button>
        <button className="btn-quiet" disabled={agentBusy} onClick={() => { setMemoryAgent(managing); setManaging(null) }}>管理记忆</button>
        <button className="btn-quiet" disabled={agentBusy} onClick={() => { setMediaAgent(managing); setManaging(null) }}>图片、语音与表情</button>
        <button className="btn-quiet" disabled={agentBusy} onClick={async () => {
          setAgentBusy(true)
          try { const copied = await app.copyAgent(managing.id); setManaging(null); setEditing(copied); notify({ text: `已复制：${copied.name}`, tone: 'ok' }) }
          catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
          finally { setAgentBusy(false) }
        }}>复制角色</button>
        <button className="btn-quiet" disabled={agentBusy} onClick={async () => {
          setAgentBusy(true)
          try { const file = await app.exportAgent(managing.id); notify({ text: `已导出：${file}`, tone: 'ok' }); setManaging(null) }
          catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
          finally { setAgentBusy(false) }
        }}>导出角色</button>
        <button className="btn-quiet" disabled={agentBusy} onClick={() => void changeAgentStatus(managing, managing.archived ? 'active' : 'archived')}>
          {managing.archived ? '恢复并启用' : '归档角色'}</button>
        <button className="sheet-cancel" disabled={agentBusy} onClick={() => setManaging(null)}>取消</button>
      </div>
    </div>}
    {creatingGroup && <div className="sheet-backdrop" onClick={() => setCreatingGroup(false)}>
      <div className="sheet tall" onClick={event => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-heading"><h3>新建群聊</h3><button className="sheet-close" onClick={() => setCreatingGroup(false)}><CloseIcon /></button></div>
        <input value={groupName} maxLength={50} onChange={event => setGroupName(event.target.value)} placeholder="群名称" />
        <input value={groupTopic} maxLength={4000} onChange={event => setGroupTopic(event.target.value)} placeholder="话题（可选）" />
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

  return <details className="conversation-notes conversation-note-section">
    <summary><span><strong>群共享记忆与备注</strong><small>共享背景或只给某位成员的私下提示</small></span><span className="section-count">{notes.length}</span></summary>
    <div className="conversation-note-content">
    <div className="segmented-choice" role="radiogroup" aria-label="备注范围">
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
    <div className="form-actions"><button className="btn-primary" disabled={!body.trim() || (scope === 'private' && !targetActorId)} onClick={async () => {
      try {
        await app.saveConversationNote({ id: editingId, conversationId: conversation.id, scope,
          targetActorId: scope === 'private' ? targetActorId : null, body })
        setBody(''); setEditingId(undefined)
        notify({ text: '备注已保存', tone: 'ok' })
        load()
      } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
    }}>{editingId ? '保存修改' : '添加备注'}</button>
    {editingId && <button className="btn-quiet" onClick={() => { setEditingId(undefined); setBody('') }}>取消编辑</button>}</div>
    {!!shared.length && <div className="note-list">
      <h5>群共享</h5>
      {shared.map(note => <div key={note.id} className="note-row">
        <p>{note.body}</p>
        <div className="note-actions"><button className="btn-quiet" onClick={() => { setEditingId(note.id); setScope(note.scope); setTargetActorId(note.targetActorId ?? ''); setBody(note.body) }}>编辑</button>
        <button className="btn-danger" onClick={() => { if (confirm('删除这条群共享备注？')) void app.deleteConversationNote(note.id).then(load).catch(reason => notify({ text: errorText(reason), tone: 'error' })) }}>删除</button></div>
      </div>)}
    </div>}
    {!!privateNotes.length && <div className="note-list">
      <h5>私下备注</h5>
      {privateNotes.map(note => <div key={note.id} className="note-row">
        <small>{memberName(note.targetActorId ?? '')}</small>
        <p>{note.body}</p>
        <div className="note-actions"><button className="btn-quiet" onClick={() => { setEditingId(note.id); setScope(note.scope); setTargetActorId(note.targetActorId ?? ''); setBody(note.body) }}>编辑</button>
        <button className="btn-danger" onClick={() => { if (confirm('删除这条私下备注？')) void app.deleteConversationNote(note.id).then(load).catch(reason => notify({ text: errorText(reason), tone: 'error' })) }}>删除</button></div>
      </div>)}
    </div>}
    </div>
  </details>
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

  return <details className="proactive-rules proactive-rule-section">
    <summary><span><strong>主动发言</strong><small>按时间让角色自行决定是否开口</small></span><span className="section-count">{rules.length}</span></summary>
    <div className="proactive-rule-content">
    <p className="hint">到点后由角色自行判断是否开口，不保证一定发言。会话暂停、存在未处理任务或角色停用时跳过本次触发。</p>
    <div className="segmented-choice" role="radiogroup" aria-label="主动发言频率">
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
    <div className="form-actions"><button className="btn-primary" onClick={async () => {
      try {
        await app.saveProactiveRule({ conversationId: conversation.id, actorId: actorId || null,
          mode, intervalMinutes, dailyAt, prompt })
        setPrompt('')
        notify({ text: '主动发言已安排', tone: 'ok' })
        load()
      } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
    }}>添加规则</button></div>
    {rules.map(rule => <div key={rule.id} className={`note-row ${rule.enabled ? '' : 'disabled'}`}>
      <div>
        <strong>{rule.mode === 'interval' ? `每 ${rule.intervalMinutes} 分钟` : `每天 ${formatDaily(rule.dailyAt)}`}</strong>
        <small>{memberName(rule.actorId)}{rule.enabled ? '' : ' · 已停用'}</small>
        {rule.prompt && <p className="hint">{rule.prompt}</p>}
      </div>
      <div className="note-actions">
        <button className="btn-quiet" onClick={() => void app.saveProactiveRule({ id: rule.id,
          conversationId: rule.conversationId, actorId: rule.actorId, mode: rule.mode,
          intervalMinutes: rule.intervalMinutes, dailyAt: rule.dailyAt, prompt: rule.prompt,
          enabled: !rule.enabled }).then(load).catch(reason => notify({ text: errorText(reason), tone: 'error' }))}>{rule.enabled ? '停用' : '启用'}</button>
        <button className="btn-danger" onClick={() => { if (confirm('删除这条主动发言规则？')) void app.deleteProactiveRule(rule.id).then(load).catch(reason => notify({ text: errorText(reason), tone: 'error' })) }}>删除</button>
      </div>
    </div>)}
    </div>
  </details>
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
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<'all' | 'global' | 'conversation'>('all')
  const load = () => void app.memories(agent.id).then(setItems, reason =>
    notify({ text: errorText(reason), tone: 'error' }))
  useEffect(() => {
    load()
    void app.conversations(true).then(items => setConversations(items.filter(item =>
      item.members.includes(agent.id))))
  }, [app, agent.id])
  const visible = items.filter(memory => filter === 'all' || (filter === 'global' ? !memory.conversationId : !!memory.conversationId))
  const conversationName = (id: string | null) => conversations.find(item => item.id === id)?.title ?? '已离开的会话'
  return <div className="sheet-backdrop" onClick={close}>
    <div className="sheet tall" onClick={event => event.stopPropagation()}>
      <div className="sheet-handle" />
      <div className="sheet-heading"><h3>{agent.name} 的记忆</h3><button className="sheet-close" onClick={close}><CloseIcon /></button></div>
      <p className="hint">文字记忆按角色隔离。自动记忆只属于当前会话；你创建的全局记忆可被该角色在其他会话读取。</p>
      <section className="memory-compose" aria-label="添加记忆">
        <div className="card-heading"><strong>添加一条记忆</strong><span>{scope ? '只在此会话使用' : '该角色所有会话可用'}</span></div>
        <textarea rows={3} value={body} maxLength={8000} onChange={event => setBody(event.target.value)} placeholder="例如：她不喜欢临时改变计划，但会直接说出来" />
        <select aria-label="记忆生效范围" value={scope} onChange={event => setScope(event.target.value)}>
          <option value="">全局 · 该角色所有会话</option>
          {conversations.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <button className="btn-primary" disabled={busy || !body.trim()} onClick={async () => {
          setBusy(true)
          try {
            await app.saveMemory({ agentId: agent.id, conversationId: scope || null, body, origin: 'human', pinned: false })
            setBody(''); load()
            notify({ text: '记忆已添加', tone: 'ok' })
          } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
          finally { setBusy(false) }
        }}>添加记忆</button>
      </section>
      <div className="memory-filter" role="group" aria-label="筛选记忆">
        {([['all', `全部 ${items.length}`], ['global', '全局'], ['conversation', '会话']] as const).map(([id, label]) =>
          <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
      </div>
      <div className="memory-list">
        {visible.map(memory => <article className={'memory-card' + (memory.pinned ? ' pinned' : '')} key={memory.id}>
          <div className="memory-card-meta"><span>{memory.conversationId ? conversationName(memory.conversationId) : '全局记忆'}</span><small>{memory.origin === 'human' ? '你创建' : '角色记录'} · {new Date(memory.updatedAt).toLocaleDateString()}</small>
            {memory.pinned && <span className="badge">置顶</span>}</div>
          <p>{memory.body}</p>
          <div className="memory-card-actions">
            <button className="btn-quiet" disabled={busy} onClick={async () => {
              setBusy(true)
              try {
                await app.saveMemory({ ...memory, agentId: agent.id, body: memory.body, pinned: !memory.pinned, origin: memory.origin })
                load()
              } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
              finally { setBusy(false) }
            }}>{memory.pinned ? '取消置顶' : '置顶'}</button>
            <button className="btn-quiet" disabled={busy} onClick={() => setEditing(memory)}>编辑</button>
            <button className="btn-quiet" disabled={busy} onClick={() => {
              if (memory.conversationId) {
                if (!confirm('将这条会话记忆改为全局记忆？其他会话之后也能读取。')) return
                setBusy(true)
                void app.moveMemoryScope(memory.id, null).then(load, reason =>
                  notify({ text: errorText(reason), tone: 'error' })).finally(() => setBusy(false))
              } else {
                setMoving(memory)
              }
            }}>{memory.conversationId ? '设为全局' : '限定会话'}</button>
            <button className="btn-danger" disabled={busy} onClick={async () => {
              if (!confirm('删除这条记忆？删除后不会再进入后续上下文。')) return
              setBusy(true)
              try { await app.deleteMemory(memory.id); load(); notify({ text: '记忆已删除', tone: 'ok' }) }
              catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
              finally { setBusy(false) }
            }}>删除</button>
          </div>
        </article>)}
        {!visible.length && <Empty text={items.length ? '这个范围下没有记忆。' : '还没有记忆。'} />}
      </div>
      {editing && <div className="edit-memory">
        <div className="card-heading"><strong>编辑记忆</strong><button className="sheet-close" type="button" aria-label="关闭记忆编辑" onClick={() => setEditing(null)}><CloseIcon /></button></div>
        <textarea rows={4} value={editing.body} maxLength={8000} onChange={event => setEditing({ ...editing, body: event.target.value })} />
        <div className="actions"><button className="btn-primary" disabled={busy || !editing.body.trim()} onClick={async () => {
          setBusy(true)
          try {
            await app.saveMemory({
              id: editing.id, agentId: agent.id, conversationId: editing.conversationId,
              body: editing.body, kind: editing.kind, about: editing.about,
              pinned: editing.pinned, origin: 'human'
            })
            setEditing(null); load(); notify({ text: '记忆已更新', tone: 'ok' })
          } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
          finally { setBusy(false) }
        }}>保存修改</button><button className="btn-quiet" type="button" disabled={busy} onClick={() => setEditing(null)}>取消</button></div>
      </div>}
      {moving && <div className="memory-scope-picker">
        <div className="card-heading"><strong>选择记忆所属会话</strong><button className="sheet-close" type="button" aria-label="关闭会话选择" onClick={() => setMoving(null)}><CloseIcon /></button></div>
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

type MeView = 'home' | 'providers' | 'models' | 'profile' | 'background' | 'usage' | 'backup' | 'storage' | 'updates' | 'about'

function Me(props: {
  app: AppApi
  version: number
  notify: (notice: Notice) => void
}) {
  const { app, version, notify } = props
  const [view, setView] = useState<MeView>('home')
  const region = useRef<HTMLElement>(null)
  const [lorebookOpen, setLorebookOpen] = useState(false)
  const [profile, setProfile] = useState({ name: '', bio: '', avatarData: '' })
  const profileDirtyRef = useRef(false)
  const [profileDirty, setProfileDirty] = useState(false)
  const [providers, setProviders] = useState<Provider[]>([])
  const [bindings, setBindings] = useState<ModelBinding[]>([])
  const [usage, setUsage] = useState<ModelCallRecord[]>([])
  const [showUsage, setShowUsage] = useState(false)
  const [usagePurpose, setUsagePurpose] = useState<'all' | 'main' | 'triage' | 'summary' | 'sticker-analysis'>('all')
  const [backupPassword, setBackupPassword] = useState('')
  const [backupBusy, setBackupBusy] = useState(false)
  const [recovery, setRecovery] = useState<RecoveryInfo | null>(null)
  const [usageTotals, setUsageTotals] = useState<UsageSummary | null>(null)
  const [storage, setStorage] = useState<StorageStats | null>(null)

  useEffect(() => {
    let active = true
    void Promise.all([app.localUser(), app.providers(), app.bindings(), app.usage(),
      app.dataRecovery(), app.usageSummary(), app.storageStats()])
      .then(([user, connectionItems, bindingItems, calls, recoveryInfo, totals, stats]) => {
        if (!active) return
        if (!profileDirtyRef.current) setProfile({ name: user.name, bio: user.bio, avatarData: user.avatarData })
        setProviders(connectionItems)
        setBindings(bindingItems.filter(item => !item.agentId))
        setUsage(calls)
        setRecovery(recoveryInfo)
        setUsageTotals(totals)
        setStorage(stats)
      }, reason => { if (active) notify({ text: errorText(reason), tone: 'error' }) })
    return () => { active = false }
  }, [app, version, notify])

  const mainBinding = bindings.find(item => item.purpose === 'main')
  const totalTokens = (usageTotals?.inputTokens ?? 0) + (usageTotals?.outputTokens ?? 0)
  const visibleUsage = usage.filter(call => usagePurpose === 'all' || call.purpose === usagePurpose)
  const labels: Record<MeView, string> = { home: '我', providers: '提供商', models: '默认模型', profile: '本地资料',
    background: '后台互动', usage: '用量统计', backup: '备份与恢复', storage: '存储与诊断', updates: '应用更新', about: '关于 Yomi' }
  const open = (next: MeView) => { setView(next); region.current?.scrollTo({ top: 0 }) }

  return <section ref={region} className={'me scroll-region ' + (view === 'home' ? 'me-home' : 'me-detail')}>
    {view !== 'home' && <header className="settings-page-header">
      <button type="button" aria-label="返回我" onClick={() => open('home')}><BackIcon /></button>
      <h1>{labels[view]}</h1>
    </header>}
    {view === 'home' && <>
      <div className="me-home-hero">
        <Avatar name={profile.name || '我'} avatarData={profile.avatarData} size={64} status="#6EC56A" />
        <div className="me-home-identity"><h1>{profile.name || '我'}</h1><p>{profile.bio || '本地优先的对话空间'}</p><span className="me-local-status"><i />数据保存在此设备</span></div>
        <button className="text-button" type="button" onClick={() => open('profile')}>编辑资料</button>
      </div>
      <nav className="settings-home-menu" aria-label="个人设置">
        <div className="settings-menu-group"><h2>聊天与模型</h2>
          <SettingsMenuRow Icon={SettingsIcon} title="提供商" description="管理 API 地址、Key 和可用模型"
            value={`${providers.length} 个`} onClick={() => open('providers')} />
          <SettingsMenuRow Icon={AtIcon} title="默认模型" description="为聊天、图片和语音选择默认模型"
            value={mainBinding?.providerId && providers.some(item => item.id === mainBinding.providerId) ? '已配置' : '待配置'} onClick={() => open('models')} />
          <SettingsMenuRow Icon={MemoryIcon} title="世界书" description="管理世界设定；到角色或会话中绑定" onClick={() => setLorebookOpen(true)} />
          <SettingsMenuRow Icon={ChatIcon} title="后台互动" description="角色主动发言与锁屏互动"
            value={app.runtime.backgroundActive() ? '已开启' : '关闭'} onClick={() => open('background')} />
        </div>
        <div className="settings-menu-group"><h2>数据管理</h2>
          <SettingsMenuRow Icon={AtIcon} title="用量统计" description={'已知 ' + totalTokens.toLocaleString() + ' tokens'} value={(usageTotals?.calls ?? 0) + ' 次调用'} onClick={() => open('usage')} />
          <SettingsMenuRow Icon={UploadIcon} title="备份与恢复" description="整机备份、按模块恢复与数据回退" onClick={() => open('backup')} />
          <SettingsMenuRow Icon={MoreIcon} title="存储与诊断" description="空间清理与运行诊断" value={storage ? (storage.bytes / 1048576).toFixed(1) + ' MB' : undefined} onClick={() => open('storage')} />
        </div>
        <div className="settings-menu-group"><h2>应用</h2>
          <SettingsMenuRow Icon={RefreshIcon} title="应用更新" description="检查新版本与页面更新" onClick={() => open('updates')} />
          <SettingsMenuRow Icon={MeIcon} title="关于 Yomi" description="版本与本地数据说明" onClick={() => open('about')} />
        </div>
      </nav>
      <div className="version-note">YOMI · 你的本地对话空间</div>
    </>}
    {(view === 'providers' || view === 'models') && <ModelSettings key={view} page={view === 'providers' ? 'providers' : 'defaults'}
      openProviders={() => open('providers')} app={app} version={version} notify={notice => notify(notice)} />}
      {view === 'profile' && <>
    <Section>
    <div className="settings-card profile-card">
      <div className="profile-avatar-editor">
        <Avatar name={profile.name || '我'} avatarData={profile.avatarData} size={76} showStatus={false} />
        <div className="profile-avatar-actions">
          <strong>个人头像</strong>
          <span>支持 PNG、JPG、WebP，图片会自动压缩后保存在本机。</span>
          <label className="file-button btn-secondary">{profile.avatarData ? '更换头像' : '上传头像'}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={async event => {
            const input = event.currentTarget
            const file = input.files?.[0]
            input.value = ''
            if (!file) return
            if (file.size > 2_000_000) { notify({ text: '头像图片不能超过 2 MB', tone: 'error' }); return }
            try {
              const avatarData = await readImageThumbnail(file)
              profileDirtyRef.current = true
              setProfileDirty(true)
              setProfile(current => ({ ...current, avatarData }))
            } catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
          }} /></label>
          {profile.avatarData && <button className="btn-quiet" type="button" onClick={() => {
            profileDirtyRef.current = true
            setProfileDirty(true)
            setProfile(current => ({ ...current, avatarData: '' }))
          }}>移除头像</button>}
        </div>
      </div>
      <label>昵称<input value={profile.name} maxLength={80} onChange={event => { profileDirtyRef.current = true; setProfileDirty(true); setProfile({ ...profile, name: event.target.value }) }} /></label>
      <label>自我介绍<textarea rows={3} maxLength={1000} value={profile.bio} onChange={event => { profileDirtyRef.current = true; setProfileDirty(true); setProfile({ ...profile, bio: event.target.value }) }} placeholder="这段介绍会出现在你的本地资料中" /></label>
      <p className="hint">资料只保存在此设备，不会自动上传；角色在聊天中仍以“你”称呼你。</p>
      <button className="wide-primary" disabled={!profile.name.trim() || !profileDirty} onClick={async () => {
        try {
          await app.saveUserProfile(profile.name, profile.bio, profile.avatarData)
          profileDirtyRef.current = false
          setProfileDirty(false)
          notify({ text: '本地资料已保存', tone: 'ok' })
        }
        catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
      }}>{profileDirty ? '保存资料' : '已保存'}</button>
    </div>
    </Section>
    </>}
    {view === 'background' && <>
    <Section><div className="settings-card">
      <div className="background-status"><span className={app.runtime.backgroundActive() ? 'ready' : ''}><i />{app.runtime.backgroundActive() ? '后台互动已开启' : '后台互动已关闭'}</span><small>{app.backgroundSupported() ? '仅 Android 可用' : '当前平台仅支持前台定时'}</small></div>
      <div className="switch-row"><span>允许锁屏后按规则主动发言</span><input type="checkbox" aria-label="允许锁屏后按规则主动发言" checked={app.runtime.backgroundActive()} disabled={!app.backgroundSupported()}
        onClick={async () => {
          try { await app.setBackgroundEnabled(!app.runtime.backgroundActive()) }
          catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
        }} /></div>
      <p className="hint">开启后会显示常驻通知并增加耗电；角色新消息会通知你。关闭后仅在应用前台检查定时规则。</p>
      <p className="hint">本次运行有效：应用被系统终止或从最近任务划掉后停止，不会自动重试中断对话。系统省电策略仍可能延迟触发。</p>
      {!app.backgroundSupported() && <p className="hint">当前平台支持前台定时；后台互动目前仅 Android 可用。</p>}
    </div></Section>
    </>}
    {view === 'usage' && <>
    <Section>
    <div className="settings-card">
      <div className="usage-summary">
        <div><strong>{usageTotals?.calls ?? 0}</strong><span>模型调用</span></div>
        <div><strong>{totalTokens.toLocaleString()}</strong><span>已知 tokens</span></div>
        <div><strong>{usageTotals?.unknownCalls ?? 0}</strong><span>用量不完整</span></div>
      </div>
      {!!usageTotals?.unknownCalls && <p className="hint">{usageTotals.unknownCalls} 次调用的用量不完整；未知部分不计作零。</p>}
      <p className="hint">统计本机保留的全部调用记录，不包含聊天正文或 API Key。</p>
      <div className="card-heading"><span className="card-kicker">最近调用</span><button className="text-button" type="button" onClick={() => setShowUsage(value => !value)}>{showUsage ? '收起' : '展开'}</button></div>
      {showUsage && <div className="usage-purpose-filter" role="group" aria-label="按用途筛选">
        {([['all','全部'],['main','角色回复'],['triage','辅助判断'],['summary','摘要'],['sticker-analysis','表情识图']] as const).map(([id,label]) =>
          <button type="button" key={id} aria-pressed={usagePurpose===id} onClick={()=>setUsagePurpose(id)}>{label}</button>)}
      </div>}
      {showUsage && <div className="usage-list">{visibleUsage.slice(0, 30).map(call => <div key={call.id}>
        <span>{new Date(call.startedAt).toLocaleString()}</span>
        <strong>{({ main: '角色回复', triage: '辅助判断', summary: '摘要', 'sticker-analysis': '表情识图' } as Record<string, string>)[call.purpose] ?? call.purpose} · {call.status === 'success' ? '成功' : call.status === 'error' ? '失败' : call.status}</strong>
        <small>{call.modelId} · {call.inputTokens === null && call.outputTokens === null ? '用量未知' : `${(call.inputTokens ?? 0) + (call.outputTokens ?? 0)} tokens`}</small>
      </div>)}</div>}
      {showUsage && !visibleUsage.length && <p className="hint">这个用途还没有调用记录。</p>}
    </div>
    </Section>
    </>}
    {view === 'backup' && <>
    <ModularBackupPanel app={app} notify={notify} />
    <Section title="整机备份与回退">
    <div className="settings-card">
      <p className="hint">备份包含聊天、角色、世界书、媒体、表情包和连接设置，不包含 API Key。文件使用密码加密；恢复会替换本地数据。</p>
      <label>备份密码<input type="password" value={backupPassword} autoComplete="new-password"
        onChange={event => setBackupPassword(event.target.value)} placeholder="导出至少 8 位；恢复填写原密码" disabled={backupBusy} /></label>
      <p className="hint">请妥善保存密码，遗忘后无法解密。旧版未加密的 JSON 备份仍可恢复。</p>
      <div className="actions">
        <button className="btn-primary" disabled={backupBusy} onClick={async () => {
          setBackupBusy(true)
          try { notify({ text: `备份已写入：${await app.exportBackup(backupPassword)}`, tone: 'ok' }); setBackupPassword('') }
          catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
          finally { setBackupBusy(false) }
        }}>{backupBusy ? '处理中…' : '导出备份'}</button>
        <label className="file-button btn-secondary">恢复备份<input type="file" disabled={backupBusy} accept=".json,.yomi" onChange={async event => {
          const input = event.currentTarget
          const file = event.target.files?.[0]
          if (!file) return
          input.value = ''
          if (file.size > 150_000_000) { notify({ text: '备份文件超过 150 MB，无法恢复', tone: 'error' }); return }
          if (!confirm('恢复会停止当前生成并替换全部聊天、角色和记忆。API Key 需重新配置。继续？')) return
          setBackupBusy(true)
          try {
            profileDirtyRef.current = false
            setProfileDirty(false)
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
          <button className="btn-quiet" disabled={backupBusy} onClick={async () => {
            if (!confirm('切回上一份本地数据？当前数据会保留为回退副本，正在生成的回复会停止。')) return
            setBackupBusy(true)
            try { profileDirtyRef.current = false; setProfileDirty(false); await app.rollbackData(); notify({ text: '已切回上一份本地数据', tone: 'ok' }) }
            catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
            finally { setBackupBusy(false) }
          }}>切回上一份数据</button>
          <button disabled={backupBusy} className="btn-danger" onClick={async () => {
            if (!confirm('删除上一份回退副本？当前使用的数据会保留。')) return
            setBackupBusy(true)
            try { await app.discardRecovery(); notify({ text: '回退副本已删除', tone: 'ok' }) }
            catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
            finally { setBackupBusy(false) }
          }}>删除回退副本</button>
        </div>
      </div>}
      <button className="btn-danger" disabled={backupBusy} onClick={async () => {
        const answer = prompt('此操作会删除聊天、角色、记忆和本机 API Key。请输入“清空”确认：')
        if (answer !== '清空') return
        try { await app.clearAll(); notify({ text: '全部本地数据已清空', tone: 'ok' }) }
        catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
      }}>清空全部数据</button>
    </div>
    </Section>
    </>}
    {view === 'storage' && <>
    <Section>
    <div className="settings-card">
      {storage && <>
        <div className="storage-summary">
          <div><strong>{(storage.bytes / 1048576).toFixed(1)} MB</strong><span>数据库</span></div>
          <div><strong>{(storage.freeBytes / 1048576).toFixed(1)} MB</strong><span>可回收</span></div>
          <div><strong>{storage.messages.toLocaleString()}</strong><span>消息</span></div>
        </div>
        <p className="hint">{storage.agents} 个角色 · {storage.conversations} 个会话 · {storage.memories} 条有效记忆 · {storage.logs} 条运行记录。回退副本单独保留。</p>
      </>}
      <div className="actions">
        <button disabled={backupBusy} className="btn-quiet" onClick={async () => {
          if (!confirm('清理已结束的模型调用与工具记录？聊天和记忆会保留，用量统计也会随记录清理。')) return
          try { await app.clearFinishedLogs(); notify({ text: '已结束的调用与工具记录已清理', tone: 'ok' }) }
          catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
        }}>清理运行记录</button>
        <button disabled={backupBusy} className="btn-quiet" onClick={async () => {
          if (!confirm('压缩本地数据库会停止当前生成，并回收已删除数据的空闲页。继续？')) return
          setBackupBusy(true)
          try { await app.compactStorage(); notify({ text: '数据库已压缩', tone: 'ok' }) }
          catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
          finally { setBackupBusy(false) }
        }}>压缩数据库</button>
        <button disabled={backupBusy} className="btn-quiet" onClick={async () => {
          try { notify({ text: `诊断已写入：${await app.exportDiagnostics()}`, tone: 'ok' }) }
          catch (reason) { notify({ text: errorText(reason), tone: 'error' }) }
        }}>导出诊断</button>
      </div>
      <p className="hint">诊断仅包含版本、数量、模型协议、状态和用量，不包含聊天正文、角色资料、模型地址或 API Key。</p>
    </div>
    </Section>
    </>}
    {view === 'updates' && <>
    <Section><UpdateSettings /></Section>
    </>}
    {view === 'about' && <>
    <Section>
    <div className="settings-card about">
      <div className="about-hero"><img src="/logo.png" alt="" /><div><strong>Yomi</strong><small>本地优先的角色对话空间</small></div></div>
      <div className="about-facts">
        <div><strong>SQLite</strong><span>聊天保存在设备</span></div>
        <div><strong>BYOM</strong><span>使用你配置的模型</span></div>
        <div><strong>Local</strong><span>不自动云同步</span></div>
      </div>
      <p>支持多角色私聊、群聊、世界书、角色卡、文字记忆与本地多媒体。模型回复由你选择的服务生成。</p>
      <p className="hint">Android · 聊天、角色和凭证不会自动上传；具体网络请求以你配置的模型服务为准。</p>
    </div>
    </Section>
    </>}
    {lorebookOpen && <LorebookSheet app={app} close={() => setLorebookOpen(false)} notify={notify} />}
  </section>
}

function SettingsMenuRow({ Icon, title, description, value, onClick }: {
  Icon: typeof ChatIcon; title: string; description: string; value?: string; onClick: () => void
}) {
  return <button className="settings-menu-row" type="button" onClick={onClick}>
    <span className="settings-menu-icon"><Icon /></span>
    <span className="settings-menu-copy"><strong>{title}</strong><small>{description}</small></span>
    {value && <span className="settings-menu-value">{value}</span>}
    <ChevronRightIcon className="settings-menu-chevron" />
  </button>
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
    <button className="btn-primary" disabled={busy || !selected.length} onClick={() => void run(async () => {
      const file = await app.exportBackupZip(password, selected)
      notify({ text: `模块备份已写入：${file}`, tone: 'ok' })
    })}>导出加密 ZIP</button>
    <label className="file-button btn-quiet">读取 ZIP 备份<input type="file" accept=".zip" disabled={busy} onChange={event => {
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
      <button className="btn-primary" disabled={busy || !restoring.length} onClick={() => void run(async () => {
        if (!bytes || !confirm('合并所选模块？将停止当前生成并保留一份可回退的数据。')) return
        await app.restoreBackupZip(bytes, password, restoring, overwrite)
        setPreview(null); setBytes(null); setPassword('')
        notify({ text: '所选模块已合并，可在下方切回上一份数据', tone: 'ok' })
      })}>合并恢复所选模块</button>
    </div>}
    {busy && <p className="hint">正在处理备份…</p>}
  </div></Section>
}

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return <section className="settings-section">
    {title && <h4>{title}</h4>}
    {children}
  </section>
}

function Empty({ text, action, onAction, icon }: { text: string; action?: string; onAction?: () => void; icon?: React.ReactNode }) {
  return <div className="empty">{icon && <span className="empty-icon">{icon}</span>}<p>{text}</p>{action && <button className="btn-secondary" onClick={onAction}>{action}</button>}</div>
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
