import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppApi } from '../app/bootstrap'
import type { Actor, Conversation } from '../domain/types'
import { Avatar } from './avatar'
import { BackIcon, ChevronRightIcon, CloseIcon, PlusIcon } from './icons'

type Page = 'home' | 'name' | 'announcement' | 'topic' | 'add' | 'remove' | 'advanced' | 'history'
type Notify = (notice: { text: string; tone: 'ok' | 'error' }) => void
const headings: Record<Page, string> = { home: '群聊信息', name: '群聊名称', announcement: '群公告', topic: '聊天话题', add: '添加群成员', remove: '移出群成员', advanced: '角色互动设置', history: '聊天记录' }
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败'

export function GroupInfo({ app, version, conversation, initialPage = 'home', close, deleted, search, editAgent, renderAdvanced, notify }: {
  app: AppApi; version: number; conversation: Conversation; initialPage?: 'home' | 'announcement'
  close: () => void; deleted: () => void; search: () => void; editAgent: (actor: Actor) => void
  renderAdvanced: (room: Conversation, members: Actor[]) => ReactNode; notify: Notify
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const nameEditor = useRef<HTMLInputElement>(null)
  const textEditor = useRef<HTMLTextAreaElement>(null)
  const lock = useRef(false)
  const [room, setRoom] = useState(conversation)
  const [actors, setActors] = useState<Actor[]>([])
  const [page, setPage] = useState<Page>(initialPage)
  const [value, setValue] = useState(initialPage === 'announcement' ? conversation.announcement ?? '' : '')
  const [baseline, setBaseline] = useState(value)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => { setRoom(conversation) }, [conversation])
  useEffect(() => {
    let active = true
    void app.actors().then(items => { if (active) { setActors(items); setLoading(false) } }, reason => {
      if (active) { setError(errorText(reason)); setLoading(false) }
    })
    return () => { active = false }
  }, [app, version])
  useEffect(() => {
    if (!['name', 'announcement', 'topic'].includes(page)) return
    const timer = requestAnimationFrame(() => (page === 'name' ? nameEditor.current : textEditor.current)?.focus())
    return () => cancelAnimationFrame(timer)
  }, [page])

  const members = room.members.map(id => actors.find(actor => actor.id === id)).filter((actor): actor is Actor => Boolean(actor))
  const agents = members.filter(actor => actor.kind === 'agent')
  const candidates = page === 'remove' ? agents : actors.filter(actor => actor.kind === 'agent' && actor.enabled && !actor.archived && !room.members.includes(actor.id))
  const capacity = Math.max(0, 9 - room.members.length)
  const editing = page === 'name' || page === 'announcement' || page === 'topic'
  const limit = page === 'name' ? 50 : page === 'announcement' ? 2000 : 4000

  const navigate = (next: Page) => {
    if (lock.current) return
    setError(''); setSelected([])
    const text = next === 'name' ? room.title : next === 'announcement' ? room.announcement ?? '' : next === 'topic' ? room.topic : ''
    setValue(text); setBaseline(text); setPage(next)
  }
  const back = () => {
    if (lock.current || (editing && value !== baseline && !confirm('放弃尚未保存的修改？'))) return
    if (page === 'home') close()
    else navigate('home')
  }
  const mutate = async (work: () => Promise<unknown>, success: string, next: Page = page) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      await work()
      const [fresh, people] = await Promise.all([app.conversation(room.id), app.actors()])
      setRoom(fresh); setActors(people); setPage(next); setSelected([])
      if (success) notify({ text: success, tone: 'ok' })
    } catch (reason) { setError(errorText(reason)); notify({ text: errorText(reason), tone: 'error' }) }
    finally { lock.current = false; setBusy(false) }
  }
  const saveText = () => {
    if (!editing || busy) return
    if (page === 'name' && !value.trim()) { setError('群聊名称不能为空'); return }
    const field = page === 'name' ? 'title' : page
    void mutate(() => app.updateConversation(room.id, { [field]: value.trim() }), page === 'announcement' ? '群公告已发布' : '已保存', 'home')
  }
  const row = (label: string, detail: string, next: Page) => <button type="button" className="group-setting-row" disabled={busy} onClick={() => navigate(next)}>
    <span>{label}</span><span className="group-setting-value">{detail}</span><ChevronRightIcon/>
  </button>
  const toggle = (label: string, field: 'pinned' | 'muted' | 'autonomyPaused' | 'hidden') => <button type="button" role="switch" className="group-setting-row" aria-label={label} aria-checked={room[field]} disabled={busy}
    onClick={() => void mutate(() => app.updateConversation(room.id, { [field]: !room[field] }), '')}>
    <span>{label}</span><span className="group-switch" aria-hidden="true"><i/></span>
  </button>

  return <dialog ref={dialog} className="group-info-dialog" aria-label={headings[page]} onCancel={event => { event.preventDefault(); back() }} onClick={event => {
    if (event.target === event.currentTarget && page === 'home') back()
  }}>
    <div className="group-info-page">
      <header className="group-info-header"><button type="button" className="icon-button" aria-label={page === 'home' ? '关闭群聊信息' : '返回群聊信息'} disabled={busy} onClick={back}><BackIcon/></button>
        <h2>{headings[page]}{page === 'home' ? `（${room.members.length}）` : ''}</h2>
        {editing ? <button type="button" className="group-save" disabled={busy || (page === 'name' && !value.trim()) || value.trim() === baseline.trim()} onClick={saveText}>{busy ? '保存中…' : page === 'announcement' ? '发布' : '保存'}</button>
          : page !== 'home' ? <button type="button" className="icon-button" aria-label="关闭群聊信息" disabled={busy} onClick={close}><CloseIcon/></button> : <span className="group-header-spacer"/>}
      </header>
      <div className="group-info-body" key={page}>
        {error && <p className="group-info-error" role="alert">{error}</p>}
        {page === 'home' && <>
          <section className="group-members-grid" aria-label="群成员">
            {members.map(actor => actor.kind === 'agent' ? <button type="button" className="group-member" key={actor.id} disabled={busy} aria-label={`查看成员 ${actor.name}`} onClick={() => editAgent(actor)}>
              <Avatar actor={actor} size={46} showStatus={false}/><span>{actor.name}</span>{(!actor.enabled || actor.archived) && <small>{actor.archived ? '已归档' : '已停用'}</small>}
            </button> : <div className="group-member" key={actor.id}><Avatar actor={actor} size={46} showStatus={false}/><span>{actor.name || '我'}</span><small>我</small></div>)}
            <button type="button" className="group-member group-member-action" aria-label="添加群成员" disabled={busy || loading || !capacity} onClick={() => navigate('add')}><span className="group-member-icon"><PlusIcon/></span><span>添加</span></button>
            <button type="button" className="group-member group-member-action" aria-label="移出群成员" disabled={busy || loading || !agents.length} onClick={() => navigate('remove')}><span className="group-member-icon">−</span><span>移出</span></button>
          </section>
          <section className="group-settings-section">
            {row('群聊名称', room.title, 'name')}
            {row('群公告', room.announcement || '未设置', 'announcement')}
          </section>
          <section className="group-settings-section">
            <button type="button" className="group-setting-row" disabled={busy} onClick={search}><span>查找聊天记录</span><ChevronRightIcon/></button>
            {row('聊天记录', '导出记录', 'history')}
          </section>
          <section className="group-settings-section">{toggle('消息免打扰', 'muted')}{toggle('置顶聊天', 'pinned')}</section>
          <section className="group-settings-section">{row('角色互动设置', '话题、记忆与主动发言', 'advanced')}</section>
          <section className="group-settings-section"><button type="button" className="group-setting-row group-danger" disabled={busy} onClick={() => {
            if (lock.current || !confirm('清空本群聊天记录及本会话来源记忆？群名、群公告、成员和角色资料会保留。此操作不可撤销。')) return
            void mutate(() => app.clearConversation(room.id), '聊天记录已清空')
          }}><span>清空聊天记录</span></button></section>
          <section className="group-settings-section"><button type="button" className="group-setting-row group-danger" disabled={busy} onClick={async () => {
            if (lock.current || !confirm('删除这个群聊及全部本地聊天记录？角色资料和其他群聊不受影响。此操作不可撤销。')) return
            lock.current = true; setBusy(true)
            try { await app.deleteConversation(room.id); notify({ text: '群聊已删除，角色资料仍保留', tone: 'ok' }); deleted() }
            catch (reason) { setError(errorText(reason)); notify({ text: errorText(reason), tone: 'error' }) }
            finally { lock.current = false; setBusy(false) }
          }}><span>删除群聊</span></button></section>
          <p className="group-info-footnote">这是本机的角色群聊。移出成员不会删除角色，删除群聊会删除本地聊天记录。</p>
        </>}
        {editing && <section className="group-text-editor">
          {page === 'name' ? <input ref={nameEditor} aria-label="群聊名称" maxLength={limit} disabled={busy} value={value} onChange={event => setValue(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); saveText() }
          }}/>
            : <textarea ref={textEditor} aria-label={headings[page]} rows={page === 'announcement' ? 10 : 6} maxLength={limit} value={value} disabled={busy} onChange={event => setValue(event.target.value)}/>}
          <div className="group-editor-meta"><span>{page === 'announcement' ? '发布后群内角色都能在后续对话中参考。' : page === 'name' ? '修改后，消息列表和聊天标题会一起更新。' : '用于角色聊天的背景设定，不会替换群公告。'}</span><span>{value.length}/{limit}</span></div>
          {page === 'announcement' && Boolean(room.announcementUpdatedAt) && <p className="group-info-footnote">最近发布：{new Date(room.announcementUpdatedAt!).toLocaleString('zh-CN')}</p>}
        </section>}
        {(page === 'add' || page === 'remove') && <>
          <p className="group-info-footnote">{page === 'add' ? `还可添加 ${capacity} 位角色；新成员只能读取加入后的消息。` : '只移出本群，不会删除角色或其历史发言。'}</p>
          <fieldset className="group-member-picks" disabled={busy}>{candidates.map(actor => <label key={actor.id}>
            <Avatar actor={actor} size={42} showStatus={false}/><span><strong>{actor.name}</strong><small>{actor.archived ? '已归档' : !actor.enabled ? '已停用' : actor.bio}</small></span>
            <input type="checkbox" aria-label={`选择 ${actor.name}`} checked={selected.includes(actor.id)} disabled={page === 'add' && selected.length >= capacity && !selected.includes(actor.id)} onChange={event => setSelected(current => event.target.checked ? [...current, actor.id] : current.filter(id => id !== actor.id))}/>
          </label>)}</fieldset>
          {!candidates.length && <p className="group-info-footnote">{page === 'add' ? '没有可添加的已启用角色。' : '没有可移出的角色。'}</p>}
          <div className="group-confirm-members"><button type="button" className={page === 'remove' ? 'group-remove-confirm' : 'wide-primary'} disabled={busy || !selected.length} onClick={() => {
            if (lock.current || (page === 'remove' && !confirm(`将 ${selected.map(id => actors.find(actor => actor.id === id)?.name).join('、')} 移出本群？角色和历史发言会保留。`))) return
            void mutate(() => app.updateMembers(room.id, page === 'add' ? selected : [], page === 'remove' ? selected : []), page === 'add' ? '已添加到群聊' : '已移出群聊', 'home')
          }}>{busy ? '处理中…' : `${page === 'add' ? '添加' : '移出'}${selected.length ? `（${selected.length}）` : ''}`}</button></div>
        </>}
        {page === 'advanced' && <>
          <section className="group-settings-section">{row('聊天话题', room.topic || '未设置', 'topic')}{toggle('暂停角色自主互动', 'autonomyPaused')}{toggle('从消息列表隐藏', 'hidden')}</section>
          <div className="group-advanced-content">{renderAdvanced(room, agents)}</div>
        </>}
        {page === 'history' && <section className="group-settings-section">{(['markdown', 'json'] as const).map(format => <button type="button" className="group-setting-row" disabled={busy} key={format}
          onClick={() => void mutate(async () => { const file = await app.exportConversation(room.id, format); notify({ text: `已导出：${file}`, tone: 'ok' }) }, '')}><span>导出 {format === 'json' ? 'JSON' : 'Markdown'}</span><ChevronRightIcon/></button>)}</section>}
      </div>
    </div>
  </dialog>
}
