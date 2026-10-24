import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { AppApi } from '../app/bootstrap'
import type { Sticker } from '../domain/types'
import { emoticons } from './emoticons'
import { readStickerFile, saveFavoriteSticker } from './stickerPack'
import { BackspaceIcon, ClockIcon, HeartIcon, PlusIcon, SmileIcon } from './icons'
import { StickerRecognitionDialog } from './stickerRecognition'

type Notify = (notice: { text: string; tone: 'ok' | 'error' }) => void
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败'
const pageSize = 21
const recentKey = 'yomi.emoticons-recent.v2'

export function ChatExpressionPicker({ app, version, disabled, hasDraft, close, onEmoji, onBackspace, onSticker, notify }: {
  app: AppApi
  version: number
  disabled: boolean
  hasDraft: boolean
  close: () => void
  onEmoji: (code: string) => void
  onBackspace: () => void
  onSticker: (sticker: Sticker, commandId: string) => Promise<void>
  notify: Notify
}) {
  const [tab, setTab] = useState<'faces' | 'recent' | 'favorites'>('faces')
  const [recent, setRecent] = useState<string[]>([])
  const [stickers, setStickers] = useState<Sticker[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [sending, setSending] = useState('')
  const [importing, setImporting] = useState(false)
  const [managing, setManaging] = useState(false)
  const [page, setPage] = useState(0)
  const [recognitionOpen, setRecognitionOpen] = useState(false)
  const pagesRef = useRef<HTMLDivElement>(null)
  const operationLock = useRef(false)
  const commandIds = useRef(new Map<string, string>())
  const loadRevision = useRef(0)

  const loadStickers = async () => {
    const revision = ++loadRevision.current
    try {
      const items = await app.stickers()
      if (revision !== loadRevision.current) return
      setStickers(items); setLoadError(false)
    } catch (error) {
      if (revision !== loadRevision.current) return
      setLoadError(true); notify({ text: errorText(error), tone: 'error' })
    } finally { if (revision === loadRevision.current) setLoading(false) }
  }
  useEffect(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(recentKey) ?? '[]')
      if (Array.isArray(parsed)) setRecent(parsed.filter((code): code is string =>
        typeof code === 'string' && emoticons.some(item => item.code === code)).slice(0, 21))
    } catch { /* Recent choices are optional when storage is unavailable. */ }
  }, [])
  useEffect(() => {
    void loadStickers()
    return () => { loadRevision.current++ }
  }, [app, version])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [close])

  const selectEmoji = (code: string) => {
    if (disabled) return
    const next = [code, ...recent.filter(item => item !== code)].slice(0, 21)
    setRecent(next)
    try { localStorage.setItem(recentKey, JSON.stringify(next)) } catch { /* Nonessential. */ }
    onEmoji(code)
  }
  const selectSticker = async (sticker: Sticker) => {
    if (disabled || operationLock.current || managing) return
    operationLock.current = true
    setSending(sticker.id)
    // Retain the command id on failure so retry cannot duplicate a committed send.
    if (!commandIds.current.has(sticker.id)) commandIds.current.set(sticker.id, crypto.randomUUID())
    try {
      await onSticker(sticker, commandIds.current.get(sticker.id)!)
      commandIds.current.delete(sticker.id)
    } catch (error) { notify({ text: errorText(error), tone: 'error' }) }
    finally { operationLock.current = false; setSending('') }
  }
  const addStickers = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...event.currentTarget.files ?? []]
    event.currentTarget.value = ''
    if (!files.length || operationLock.current) return
    operationLock.current = true; setImporting(true)
    let added = 0
    try {
      for (const file of files) {
        await saveFavoriteSticker(app, file.name.replace(/\.[^.]+$/, ''), await readStickerFile(file))
        added++
      }
      notify({ text: '已添加到表情', tone: 'ok' })
    } catch (error) { notify({ text: `${added ? `已添加 ${added} 张；` : ''}${errorText(error)}`, tone: 'error' }) }
    finally { await loadStickers(); operationLock.current = false; setImporting(false) }
  }
  const removeSticker = async (sticker: Sticker) => {
    if (operationLock.current || !confirm('从收藏中删除这个表情？已发送的消息不受影响。')) return
    operationLock.current = true; setSending(sticker.id)
    try { await app.deleteSticker(sticker.id); await loadStickers() }
    catch (error) { notify({ text: errorText(error), tone: 'error' }) }
    finally { operationLock.current = false; setSending('') }
  }

  const visible = tab === 'recent' ? recent.map(code => emoticons.find(item => item.code === code)!) : emoticons
  const pages = Array.from({ length: Math.ceil(visible.length / pageSize) }, (_, index) => visible.slice(index * pageSize, (index + 1) * pageSize))
  const switchTab = (next: typeof tab) => { setTab(next); setPage(0); setManaging(false); pagesRef.current?.scrollTo({ left: 0 }) }
  return <div className="chat-expression-panel" role="region" aria-label="聊天表情" onPointerDown={event => {
    // A tap on an expression must not move the draft cursor or reopen the keyboard.
    if ((event.target as HTMLElement).closest('button')) event.preventDefault()
  }}>
    {tab === 'favorites' ? <>
      <div className="favorites-heading"><span>收藏的表情</span><div><button type="button" onClick={() => setRecognitionOpen(true)}>自动识图</button><button type="button" disabled={!!sending || importing} onClick={() => setManaging(value => !value)}>{managing ? '完成' : '管理'}</button></div></div>
      <div className="favorite-sticker-grid" aria-label="收藏的表情">
        {!managing && <label className="favorite-sticker-add" aria-label="添加表情" aria-disabled={importing || !!sending}>
          <PlusIcon/><input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" disabled={importing || !!sending} onChange={event => void addStickers(event)}/>
        </label>}
        {stickers.map(sticker => <div className="favorite-sticker-entry" key={sticker.id}><button type="button" className={'favorite-sticker' + (managing ? ' managing' : '')}
          title={sticker.name} aria-label={managing ? `删除表情 ${sticker.name}` : `发送表情 ${sticker.name}`}
          disabled={!!sending || importing || (!managing && disabled)} onClick={() => void (managing ? removeSticker(sticker) : selectSticker(sticker))}>
          <img src={sticker.dataUrl} alt={sticker.name} loading="lazy" draggable={false}/>
          {managing && <span className="sticker-remove">×</span>}
          {sending === sticker.id && <span className="sticker-progress">{managing ? '删除中' : '发送中'}</span>}
        </button>
          {managing && <div className="sticker-analysis-state" title={sticker.analysisError}>
            <span>{sticker.analysisStatus === 'ready' ? '已理解' : sticker.analysisStatus === 'analyzing' ? '识别中…' : sticker.analysisStatus === 'failed' ? '未成功' : '待识别'}</span>
            {(sticker.analysisStatus === 'failed' || sticker.analysisStatus === 'pending') && <button type="button" aria-label={`重试识图 ${sticker.name}`} onClick={() => void app.retryStickerRecognition(sticker.id).catch(error => notify({ text: errorText(error), tone: 'error' }))}>重试识图</button>}
          </div>}
        </div>)}
        {loading && <p className="expression-empty">正在读取…</p>}
        {!loading && !stickers.length && <p className="expression-empty">点 + 添加图片或 GIF，点表情直接发送</p>}
        {loadError && <button className="btn-quiet" type="button" onClick={() => void loadStickers()}>重新加载</button>}
      </div>
    </> : <>
      <div className="emoticon-pages" ref={pagesRef} key={tab} onScroll={event => {
        const element = event.currentTarget
        setPage(Math.round(element.scrollLeft / element.clientWidth))
      }}>
        {pages.map((items, index) => <div className="emoticon-page" key={index} aria-label={`第 ${index + 1} 页表情`}>
          {items.map(item => <button type="button" key={item.code} title={item.name} aria-label={item.name} disabled={disabled} onClick={() => selectEmoji(item.code)}>
            <img src={item.src} alt="" draggable={false}/>
          </button>)}
        </div>)}
        {!pages.length && <p className="expression-empty">用过的小表情会出现在这里</p>}
      </div>
      <div className="emoticon-page-controls">
        <div className="emoticon-page-dots" aria-label="表情分页">{pages.length > 1 && pages.map((_, index) => <button type="button" key={index}
          aria-label={`转到第 ${index + 1} 页表情`} aria-current={page === index ? 'page' : undefined} onClick={() => {
            pagesRef.current?.scrollTo({ left: index * pagesRef.current.clientWidth, behavior: 'smooth' })
          }}><i/></button>)}</div>
        <button className="emoticon-backspace" type="button" aria-label="删除上一个表情或文字" disabled={disabled || !hasDraft} onClick={onBackspace}><BackspaceIcon/></button>
      </div>
    </>}
    <div className="expression-pack-tabs" role="tablist" aria-label="表情包">
      <button type="button" role="tab" aria-label="小表情" aria-selected={tab === 'faces'} onClick={() => switchTab('faces')}><SmileIcon/></button>
      <button type="button" role="tab" aria-label="最近使用" aria-selected={tab === 'recent'} onClick={() => switchTab('recent')}><ClockIcon/></button>
      <button type="button" role="tab" aria-label="收藏表情" aria-selected={tab === 'favorites'} onClick={() => switchTab('favorites')}><HeartIcon/></button>
    </div>
    {recognitionOpen && <StickerRecognitionDialog app={app} version={version} notify={notify} close={() => setRecognitionOpen(false)}/>}
  </div>
}
