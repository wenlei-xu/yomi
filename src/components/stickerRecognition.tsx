import { useEffect, useRef, useState } from 'react'
import type { AppApi } from '../app/bootstrap'
import type { Provider, Sticker, StickerRecognitionSettings } from '../domain/types'
import { defaultStickerRecognitionSettings } from '../domain/types'
import { CloseIcon } from './icons'

type Notify = (notice: { text: string; tone: 'ok' | 'error' }) => void
const errorText = (error: unknown) => error instanceof Error ? error.message : '读取失败'
const choiceValue = (providerId: string, modelId: string) => providerId && modelId ? JSON.stringify([providerId, modelId]) : ''

export function StickerRecognitionSettings({ app, version, notify, heading = true }: { app: AppApi; version: number; notify: Notify; heading?: boolean }) {
  const [stored, setStored] = useState(defaultStickerRecognitionSettings)
  const [draft, setDraft] = useState(defaultStickerRecognitionSettings)
  const [providers, setProviders] = useState<Provider[]>([])
  const [choices, setChoices] = useState<{ providerId: string; modelId: string; name: string; enabled: boolean }[]>([])
  const [stickers, setStickers] = useState<Sticker[]>([])
  const [consent, setConsent] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)
  const dirty = useRef(false)
  const lock = useRef(false)
  useEffect(() => {
    let active = true
    void Promise.all([app.stickerRecognitionSettings(), app.providers(), app.providerModelSelections(), app.providerChannelKinds(), app.stickers()])
      .then(([settings, connections, selected, kinds, images]) => {
        if (!active) return
        setStored(settings)
        if (!dirty.current) setDraft(settings)
        setProviders(connections)
        setChoices(connections.filter(provider => !kinds[provider.id] || kinds[provider.id] === 'text').flatMap(provider =>
          (selected[provider.id] ?? []).map(modelId => ({ providerId: provider.id, modelId, name: `${provider.name} · ${modelId}`, enabled: provider.enabled }))))
        setStickers(images); setLoading(false); setLoadError('')
      }, error => { if (active) { setLoadError(errorText(error)); setLoading(false) } })
    return () => { active = false }
  }, [app, version, reload])
  const provider = providers.find(item => item.id === draft.providerId)
  const origin = provider ? new URL(provider.baseUrl).origin : ''
  const needsConsent = draft.enabled && Boolean(origin) && stored.consentedOrigin !== origin
  useEffect(() => { setConsent(false) }, [origin])
  const update = (patch: Partial<StickerRecognitionSettings>) => { dirty.current = true; setDraft(current => ({ ...current, ...patch })) }
  const current = choiceValue(draft.providerId, draft.modelId)
  if (loading) return <p className="hint">正在读取识图设置…</p>
  if (loadError) return <div className="model-inline-error" role="alert">{loadError}<button className="text-button" type="button" onClick={() => setReload(value => value + 1)}>重新读取</button></div>
  return <section className="sticker-recognition-settings" aria-label="表情包自动识图设置">
    {heading && <h3>表情包自动识图</h3>}
    <p className="hint">自动理解表情的含义，让角色按聊天内容选图。每张识别一次，结果保存在本机。</p>
    <label className="sticker-recognition-toggle"><span>收藏后自动识图</span><input type="checkbox" checked={draft.enabled} disabled={saving} onChange={event => update({ enabled: event.target.checked })}/></label>
    <label>识图模型<select aria-label="识图模型" value={current} disabled={saving} onChange={event => {
      const [providerId, modelId] = event.target.value ? JSON.parse(event.target.value) as [string, string] : ['', '']
      update({ providerId, modelId })
    }}>
      <option value="">选择支持看图的文字模型</option>
      {current && !choices.some(item => choiceValue(item.providerId, item.modelId) === current) && <option value={current}>当前：{provider?.name ?? '原渠道'} · {draft.modelId}</option>}
      {choices.map(item => <option key={choiceValue(item.providerId, item.modelId)} value={choiceValue(item.providerId, item.modelId)} disabled={!item.enabled}>{item.name}{item.enabled ? '' : ' · 已停用'}</option>)}
    </select></label>
    <p className="hint">选择支持看图的文字模型。没有可选项时，先到“我 → 提供商 → 文字”拉取并勾选模型。</p>
    {provider && <p className="hint">图片接收方：{origin}。只发送表情缩略图；动图会抽取最多 3 帧，不发送聊天记录。</p>}
    {draft.enabled && provider?.credentialState !== 'stored' && <p className="model-inline-error">请先为所选渠道保存 Key，未配置凭证时不会上传图片。</p>}
    {needsConsent && <label className="sticker-recognition-consent"><input type="checkbox" checked={consent} disabled={saving} onChange={event => setConsent(event.target.checked)}/>
      <span>我同意将现有和新收藏的表情图片自动发送至 {origin} 进行识别，并按该服务的定价支付调用费用。</span></label>}
    <button type="button" className="btn-primary" disabled={saving || (draft.enabled && (!provider?.enabled || !draft.modelId || (needsConsent && !consent)))} onClick={async () => {
      if (lock.current) return
      lock.current = true; setSaving(true)
      try {
        const settings = await app.saveStickerRecognitionSettings(draft, needsConsent && consent)
        dirty.current = false; setStored(settings); setDraft(settings); setConsent(false)
        notify({ text: settings.enabled ? '已开启，收藏的表情会在前台自动识别' : '已关闭自动识图', tone: 'ok' })
      } catch (error) { notify({ text: errorText(error), tone: 'error' }) }
      finally { lock.current = false; setSaving(false) }
    }}>{saving ? '保存中…' : '保存'}</button>
    {stickers.length > 0 && <p className="hint" aria-live="polite">已识别 {stickers.filter(item => item.analysisStatus === 'ready').length} · 待识别 {stickers.filter(item => !item.analysisStatus || item.analysisStatus === 'pending' || item.analysisStatus === 'analyzing').length} · 未成功 {stickers.filter(item => item.analysisStatus === 'failed').length}</p>}
    <p className="hint">关闭后停止后续上传，已有结果仍可使用。失败不会反复扣费重试，可在表情管理中手动重试；识图结果可能不懂梗。</p>
  </section>
}

export function StickerRecognitionDialog({ app, version, notify, close }: { app: AppApi; version: number; notify: Notify; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="model-connection-dialog" aria-label="表情包自动识图" onCancel={close} onClick={event => {
    if (event.target === event.currentTarget) close()
  }}><div className="model-dialog-content"><div className="model-dialog-heading"><h2>表情包自动识图</h2><button type="button" className="sheet-close" aria-label="关闭识图设置" onClick={close}><CloseIcon/></button></div>
    <StickerRecognitionSettings app={app} version={version} notify={notify} heading={false}/>
  </div></dialog>
}
