import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppApi } from '../app/bootstrap'
import type { ModelTestResult, Provider, ProviderModel } from '../domain/types'
import { CloseIcon, RefreshIcon, SearchIcon } from './icons'

const catalogs = new Map<string, ProviderModel[]>()
const errorText = (error: unknown) => error instanceof Error ? error.message : '请求失败，请重试'
const providerKey = (provider?: Provider) => provider ? `${provider.id}:${provider.configVersion}:${provider.baseUrl}:${provider.updatedAt}` : ''

export function ModelPicker({ app, provider, value, change, required = true }: {
  app: AppApi; provider?: Provider; value: string; change: (value: string) => void; required?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<ProviderModel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [loaded, setLoaded] = useState(false)
  const request = useRef<AbortController | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const key = providerKey(provider)
  useEffect(() => {
    request.current?.abort(); request.current = null
    const cached = catalogs.get(key)
    setItems(cached ?? []); setLoaded(Boolean(cached)); setError(''); setOpen(false); setLoading(false)
    return () => { request.current?.abort() }
  }, [key])
  useEffect(() => {
    if (open) dialog.current?.showModal()
    return () => { dialog.current?.close() }
  }, [open])

  const load = async () => {
    if (!provider || request.current) return
    const controller = new AbortController(); request.current = controller
    setLoading(true); setError('')
    try {
      const models = await app.listProviderModels(provider.id, controller.signal)
      if (controller.signal.aborted) return
      setItems(models); setLoaded(true)
      if (catalogs.size >= 32) catalogs.delete(catalogs.keys().next().value!)
      catalogs.set(key, models)
    } catch (reason) { if (!controller.signal.aborted) setError(errorText(reason)) }
    finally { if (request.current === controller) { request.current = null; setLoading(false) } }
  }
  const close = () => { request.current?.abort(); request.current = null; setLoading(false); setOpen(false) }
  const filtered = items.filter(item => `${item.id} ${item.name} ${item.owner}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <div className="model-picker">
    <label>模型 ID<input ref={input} required={required} value={value} onChange={event => change(event.target.value)}
      placeholder="从列表选择，也可手动填写模型名称" autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
    <div className="model-picker-toolbar"><button className="btn-secondary" type="button" disabled={!provider?.enabled || provider.credentialState !== 'stored'} onClick={() => {
      setOpen(true); setQuery('')
      if (!loaded) void load()
    }}><RefreshIcon />{loaded ? `选择模型（${items.length}）` : '拉取模型'}</button>
      <span>{!provider ? '先选择连接' : provider.credentialState !== 'stored' ? '先为连接保存 API Key' : loaded ? '来自当前连接的模型列表' : '从服务商获取可用模型'}</span>
    </div>
    {open && createPortal(<dialog ref={dialog} className="model-connection-dialog model-catalog-dialog" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); close() }} onClick={event => { if (event.currentTarget === event.target) close() }}>
      <div className="model-dialog-content">
        <div className="model-dialog-heading"><h2 id={titleId}>选择模型</h2><button className="sheet-close" type="button" aria-label="关闭模型列表" onClick={close}><CloseIcon /></button></div>
        <div className="model-catalog-heading"><span>{provider?.name}</span><button className="text-button" type="button" disabled={loading} onClick={() => void load()}><RefreshIcon />刷新列表</button></div>
        <label className="model-catalog-search"><SearchIcon /><input type="search" aria-label="搜索模型" value={query}
          onChange={event => setQuery(event.target.value)} placeholder="搜索模型名称或提供方" /></label>
        {loading && <p className="hint" role="status">正在拉取模型列表…<button type="button" className="text-button" onClick={() => { request.current?.abort(); request.current = null; setLoading(false) }}>取消</button></p>}
        {error && <p className="model-inline-error" role="alert">{error}</p>}
        {!loading && loaded && <p className="hint" role="status">找到 {filtered.length} 个模型{filtered.length > 100 ? '，先展示前 100 个，可继续搜索' : ''}</p>}
        <div className="model-catalog-list" aria-label="可选模型">{filtered.slice(0, 100).map(model => <button key={model.id} type="button" aria-pressed={model.id === value}
          onClick={() => { change(model.id); close() }}><span><strong>{model.id}</strong>{model.name !== model.id && <small>{model.name}</small>}{model.owner && <small>{model.owner}</small>}</span><span aria-hidden="true">{model.id === value ? '✓' : '+'}</span></button>)}</div>
        {!loading && !error && loaded && !filtered.length && <p className="hint">没有匹配的模型，可以换个关键词或手动填写模型 ID。</p>}
        <p className="hint">列表由服务商提供。请确认所选模型支持当前用途；拉取成功不代表支持工具调用、生图或语音。</p>
        <button className="btn-quiet" type="button" onClick={() => { close(); requestAnimationFrame(() => input.current?.focus()) }}>手动填写模型 ID</button>
      </div>
    </dialog>, document.body)}
  </div>
}

export function ModelConnectionTest({ app, provider, modelId, kind, voice, disabled }: {
  app: AppApi; provider?: Provider; modelId: string; kind: 'text' | 'image' | 'speech'; voice?: string; disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ message: string; latencyMs: number; media?: ModelTestResult } | null>(null)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  const key = `${providerKey(provider)}:${modelId}:${voice}`
  useEffect(() => {
    request.current?.abort(); request.current = null
    setBusy(false); setResult(null); setError('')
    return () => { request.current?.abort() }
  }, [key])
  const test = async () => {
    if (!provider || request.current || !modelId.trim()) return
    const controller = new AbortController(); request.current = controller
    setBusy(true); setResult(null); setError('')
    const started = Date.now()
    try {
      const media = kind === 'text' ? undefined : await app.testMediaProvider(provider.id, modelId.trim(), kind, voice, controller.signal)
      const message = kind === 'text' ? await app.testProvider(provider.id, modelId.trim(), controller.signal) : media!.message
      if (!controller.signal.aborted) setResult({ message, latencyMs: Date.now() - started, media })
    } catch (reason) { if (!controller.signal.aborted) setError(errorText(reason)) }
    finally { if (request.current === controller) { request.current = null; setBusy(false) } }
  }
  return <div className="model-connection-test">
    <div className="model-test-toolbar"><button className="btn-secondary" type="button" disabled={Boolean(disabled) || (!busy && (!provider?.enabled || provider.credentialState !== 'stored' || !modelId.trim()))}
      onClick={() => {
        if (busy) { request.current?.abort(); request.current = null; setBusy(false); setError('已取消测试') }
        else void test()
      }}>{busy ? '取消测试' : `测试${kind === 'text' ? '文字模型' : kind === 'image' ? '图片生成' : '语音合成'}`}</button>
      <span>{busy ? '正在请求模型服务…' : kind === 'text' ? '验证认证、工具调用与结果续传' : '实际生成一份预览，可能产生服务费用'}</span>
    </div>
    {error && <p className="model-inline-error" role="alert">{error}</p>}
    {result && <div className="model-test-result" role="status"><p>{result.message} · {(result.latencyMs / 1000).toFixed(1)} 秒</p>
      {result.media?.kind === 'image' && <img src={result.media.dataUrl} alt="图片连接测试预览" />}
      {result.media?.kind === 'speech' && <audio controls src={result.media.dataUrl} />}
    </div>}
  </div>
}
