import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { androidUpdates, installedVersion, latestRelease, Updater, type InstalledVersion } from './bridge'
import { isNewer, parseRelease, type Release } from './manifest'

interface UpdateState {
  installed: InstalledVersion | null; release: Release | null; checking: boolean
  phase: 'idle' | 'downloading' | 'ready' | 'installing'; progress: number; error: string; notice: string
  auto: boolean; setAuto: (enabled: boolean) => void; check: (manual?: boolean) => Promise<void>
  show: () => void
}
const Context = createContext<UpdateState | null>(null)
const autoKey = 'yomi-update-auto'
const attemptKey = 'yomi-update-last-attempt'
function readSetting(key: string): string | null { try { return localStorage.getItem(key) } catch { return null } }
function saveSetting(key: string, value: string): void { try { localStorage.setItem(key, value) } catch { /* Updating does not depend on preferences storage. */ } }

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const [installed, setInstalled] = useState<InstalledVersion | null>(null)
  const [release, setRelease] = useState<Release | null>(null)
  const [checking, setChecking] = useState(false)
  const [phase, setPhase] = useState<UpdateState['phase']>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [visible, setVisible] = useState(false)
  const [auto, setAutoState] = useState(() => readSetting(autoKey) !== 'off')
  const checkingRef = useRef(false)
  const busyRef = useRef(false)
  const transferId = useRef<string | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    void installedVersion().then(value => { if (alive.current) setInstalled(value) }, () => {})
    if (androidUpdates()) void Updater.ready().then(result => {
      if (!alive.current || !result.release) return
      try { setRelease(parseRelease(result.release)); setPhase('ready') } catch { /* Ignore stale cache metadata. */ }
    }, () => {})
    return () => { alive.current = false; if (transferId.current) void Updater.cancel({ requestId: transferId.current }) }
  }, [])

  const check = async (manual = true) => {
    if (checkingRef.current || busyRef.current) return
    checkingRef.current = true; setChecking(true)
    if (manual) { setError(''); setNotice('') }
    try {
      const current = await installedVersion()
      const next = await latestRelease()
      if (!alive.current) return
      setInstalled(current)
      if (isNewer(next, current)) {
        setRelease(next)
        if (androidUpdates()) {
          const cached = await Updater.ready()
          if (!alive.current) return
          setPhase(cached.release?.sha256 === next.sha256 ? 'ready' : 'idle')
        }
        setVisible(true); setError(''); setNotice('')
      } else if (manual) {
        setNotice(next.versionCode > current.versionCode ? '新版需要更高的 Android 系统版本，当前仍可正常使用。' : '当前已是最新版本。')
      }
    } catch (reason) {
      if (manual && alive.current) setError(reason instanceof Error ? reason.message : '检查更新失败，请稍后重试')
    } finally {
      checkingRef.current = false
      if (alive.current) setChecking(false)
    }
  }

  useEffect(() => {
    if (!auto || !androidUpdates()) return
    const last = Number(readSetting(attemptKey) ?? 0)
    if (Date.now() - last < 24 * 60 * 60 * 1000) return
    const timer = setTimeout(() => {
      saveSetting(attemptKey, String(Date.now()))
      void check(false)
    }, 4000)
    return () => clearTimeout(timer)
  }, [auto])

  useEffect(() => {
    if (!auto || !androidUpdates()) return
    const last = Number(readSetting('yomi-web-last-attempt') ?? 0)
    if (Date.now() - last < 24 * 60 * 60 * 1000) return
    const timer = setTimeout(() => {
      void Updater.syncWeb().then(status => {
        if (!status.skippedNetwork) saveSetting('yomi-web-last-attempt', String(Date.now()))
        window.dispatchEvent(new Event('yomi-web-status'))
      }, () => {})
    }, 8000)
    return () => clearTimeout(timer)
  }, [auto])

  const download = async () => {
    if (!release || busyRef.current || checkingRef.current || !androidUpdates()) return
    busyRef.current = true
    const requestId = crypto.randomUUID()
    transferId.current = requestId
    setPhase('downloading'); setProgress(0); setError(''); setNotice('')
    let listener: Awaited<ReturnType<typeof Updater.addListener>> | null = null
    try {
      listener = await Updater.addListener('progress', event => {
        if (alive.current && event.requestId === requestId) setProgress(Math.max(0, Math.min(100, event.bytes / event.total * 100)))
      })
      await Updater.download({ release, requestId })
      if (alive.current) { setPhase('ready'); setProgress(100) }
    } catch (reason) {
      if (alive.current) {
        setPhase('idle')
        setError(reason instanceof Error ? reason.message : '下载失败，请重试')
      }
    } finally { await listener?.remove(); transferId.current = null; busyRef.current = false }
  }

  const install = async () => {
    if (busyRef.current || checkingRef.current) return
    busyRef.current = true; setPhase('installing'); setError('')
    try {
      const result = await Updater.install()
      if (alive.current) setNotice(result.permissionRequired
        ? '请在系统设置中允许 Yomi 安装应用，返回后再点“安装更新”。'
        : '已打开系统安装界面，请确认安装。若取消，可再次点击安装。')
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '无法打开安装界面') }
    finally { busyRef.current = false; if (alive.current) setPhase('ready') }
  }

  const value: UpdateState = { installed, release, checking, phase, progress, error, notice, auto,
    setAuto: enabled => { saveSetting(autoKey, enabled ? 'on' : 'off'); setAutoState(enabled) },
    check, show: () => setVisible(true) }

  return <Context.Provider value={value}>{children}
    {visible && release && <div className="dialog-backdrop" onClick={() => setVisible(false)}>
      <div className="dialog update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title" onClick={event => event.stopPropagation()}>
        <h3 id="update-title">Yomi {release.versionName} 可更新</h3>
        <p className="hint">{(release.size / 1024 / 1024).toFixed(1)} MB · {new Date(release.publishedAt).toLocaleDateString()}</p>
        <div className="update-notes">{release.notes}</div>
        {installed?.debug && <p className="hint">当前为开发测试包。正式签名版无法覆盖测试包，迁移前请先导出聊天备份。</p>}
        {!androidUpdates() && <p>请在 Android 版 Yomi 中下载并安装更新。</p>}
        {phase === 'downloading' && <div role="status"><progress max={100} value={progress}/><p>正在下载 {Math.floor(progress)}%</p></div>}
        {error && <p className="update-error" role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <div className="dialog-actions">
          {androidUpdates() && phase === 'idle' && <button className="btn-primary" disabled={checking} onClick={() => void download()}>下载更新</button>}
          {phase === 'downloading' && <button className="btn-quiet" onClick={() => { if (transferId.current) void Updater.cancel({requestId:transferId.current}) }}>取消下载</button>}
          {phase === 'ready' && <button className="btn-primary" disabled={checking} onClick={() => void install()}>安装更新</button>}
          {phase === 'ready' && <button className="btn-quiet" disabled={checking} onClick={() => void download()}>重新下载</button>}
          {phase === 'installing' && <button className="btn-primary" disabled>正在校验安装包…</button>}
          <button className="btn-quiet" onClick={() => setVisible(false)}>{phase === 'downloading' ? '收起' : '稍后再说'}</button>
        </div>
      </div>
    </div>}
  </Context.Provider>
}

export function UpdateSettings() {
  const state = useContext(Context)
  if (!state) return null
  return <div className="settings-card">
    <div className="update-version-row"><div><span>当前版本</span><strong>{state.installed?.versionName ?? '读取中'}{state.installed?.debug ? ' · 测试版' : ''}</strong></div><span className={state.phase === 'ready' ? 'update-ready' : ''}>{state.phase === 'ready' ? '有更新待安装' : state.phase === 'downloading' ? `下载 ${Math.floor(state.progress)}%` : '已检查'}</span></div>
    <label className="switch-row"><span>自动检查更新<small>每天最多一次，不打断聊天</small></span><input type="checkbox" checked={state.auto} onChange={event => state.setAuto(event.target.checked)}/></label>
    <div className="actions"><button className="btn-primary" disabled={state.checking || state.phase === 'downloading' || state.phase === 'installing'} onClick={() => void state.check()}>{state.checking ? '正在检查…' : '检查更新'}</button>
      {state.release && <button className="btn-secondary" onClick={state.show}>{state.phase === 'downloading' ? `下载中 ${Math.floor(state.progress)}%` : state.phase === 'ready' ? '安装已下载的更新' : '查看新版'}</button>}</div>
    {state.error && <p role="alert" className="update-error">{state.error}</p>}
    {state.notice && <p role="status">{state.notice}</p>}
    <WebUpdateSettings/>
    <p className="hint">页面资源可无感更新并在下次启动生效；完整 APK 更新始终由你确认安装。不会上传聊天内容。</p>
  </div>
}

function WebUpdateSettings() {
  const [status,setStatus] = useState<{activeVersion:number;pendingVersion:number;rolledBack:boolean}|null>(null)
  const [busy,setBusy] = useState(false)
  const [message,setMessage] = useState('')
  useEffect(() => {
    if (!androidUpdates()) return
    let active = true
    const refresh = () => { void Updater.webStatus().then(value => {if(active)setStatus(value)},()=>{}) }
    refresh();window.addEventListener('yomi-web-status',refresh)
    return()=>{active=false;window.removeEventListener('yomi-web-status',refresh)}
  },[])
  if (!androidUpdates()) return null
  return <div className="web-update-settings">
    <div className="web-update-heading"><strong>页面资源</strong><span>版本 {status?.activeVersion ?? '…'}{status?.pendingVersion ? ` → ${status.pendingVersion} 待生效` : ''}</span></div>
    <p className="hint">自动检查开启时，在非计费 Wi-Fi 下静默下载页面更新；不会打断当前聊天。原生功能或数据库结构变更仍通过 APK 更新。</p>
    {status?.rolledBack && <p role="status">已退回之前的页面版本。</p>}
    <div className="actions"><button className="btn-secondary" disabled={busy} onClick={async()=>{
      setBusy(true);setMessage('')
      try {const value=await Updater.syncWeb();setStatus(value);setMessage(value.skippedNetwork?'请连接非计费 Wi-Fi 后重试。':value.pendingVersion?'已准备好页面更新，下次启动生效。':'当前没有可用的页面更新。')}
      catch {setMessage('页面更新暂不可用，当前版本可继续使用。')}
      finally{setBusy(false)}
    }}>{busy?'正在同步页面更新…':'同步页面更新'}</button>
    <button className="btn-quiet" disabled={busy} onClick={async()=>{
      if(!confirm('下次启动恢复上一个页面版本？聊天数据保留。'))return
      setBusy(true)
      try{await Updater.rollbackWeb();setStatus(await Updater.webStatus());setMessage('已设置回退，下次完全关闭并重新打开 App 时生效。')}
      catch{setMessage('设置回退失败，请重试。')}finally{setBusy(false)}
    }}>回退页面版本</button></div>
    {message&&<p role="status">{message}</p>}
  </div>
}
