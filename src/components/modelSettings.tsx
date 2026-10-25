import { Capacitor } from '@capacitor/core'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { AppApi } from '../app/bootstrap'
import type { MediaSettings, ModelBinding, Provider, ProviderChannelKind, ProviderModel, ProviderProtocol } from '../domain/types'
import { defaultMediaSettings } from '../domain/types'
import { BackIcon, ChevronRightIcon, PlusIcon, SearchIcon } from './icons'
import { StickerRecognitionSettings } from './stickerRecognition'
import { normalizeProviderAddress } from '../model/providerConfig'
import { fetchProviderModels, testProviderConnection } from '../model/catalog'
import { credentialStatus, modelOrigin, removeCredential, storeCredential } from '../platform/secureTransport'

type Notify = (notice: { text: string; tone: 'ok' | 'error' }) => void
type ModelTab = 'text' | 'image' | 'speech'
type BindingDraft = Pick<ModelBinding, 'modelId' | 'contextTokens' | 'outputTokens'> & { providerId: string }
type ConnectionDraft = {
  id: string; name: string; baseUrl: string; protocol: ProviderProtocol
  kind: ProviderChannelKind; enabled: boolean
}
type ProviderDetail = { draft: ConnectionDraft; tab: 'config' | 'models' }

const tabs: { id: ModelTab; label: string; description: string }[] = [
  { id: 'text', label: '文字', description: '角色聊天与对话记忆' },
  { id: 'image', label: '图片', description: '根据描述生成图片' },
  { id: 'speech', label: '语音', description: '生成语音并发送' }
]
const contextPresets = [
  { name: '轻量', contextTokens: 16384, outputTokens: 1024, detail: '16K 上下文' },
  { name: '均衡', contextTokens: 32768, outputTokens: 2048, detail: '32K 上下文' },
  { name: '长对话', contextTokens: 65536, outputTokens: 4096, detail: '64K 上下文' }
]
const connectionPresets: { id: string; name: string; baseUrl: string; protocol: ProviderProtocol; docs?: string }[] = [
  { id: 'custom', name: '自定义 / 中转', baseUrl: '', protocol: 'chat-completions' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', protocol: 'chat-completions', docs: 'https://api-docs.deepseek.com/' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'responses', docs: 'https://developers.openai.com/api/reference/overview' },
  { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'chat-completions', docs: 'https://ai.google.dev/gemini-api/docs/openai' }
]
const purposeNames = { main: '默认文字模型', triage: '辅助判断', summary: '对话摘要' }
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败'
const bindingDraft = (binding?: ModelBinding): BindingDraft => ({
  providerId: binding?.providerId ?? '', modelId: binding?.modelId ?? '',
  contextTokens: binding?.contextTokens ?? 32768, outputTokens: binding?.outputTokens ?? 2048
})

export function ModelSettings({ app, version, notify, page: settingsPage, openProviders }: {
  app: AppApi; version: number; notify: Notify; page: 'providers' | 'defaults'; openProviders: () => void
}) {
  const [tab, setTab] = useState<ModelTab>('text')
  const [providers, setProviders] = useState<Provider[]>([])
  const [bindings, setBindings] = useState<ModelBinding[]>([])
  const [media, setMedia] = useState<MediaSettings>(defaultMediaSettings)
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [retry, setRetry] = useState(0)
  const [vaultReady, setVaultReady] = useState(false)
  const [detail, setDetail] = useState<ProviderDetail | null>(null)
  const [modelSelections, setModelSelections] = useState<Record<string, string[]>>({})
  const [providerKinds, setProviderKinds] = useState<Record<string, ProviderChannelKind>>({})
  const [mediaBusy, setMediaBusy] = useState(false)
  const mediaSaving = useRef(false)

  useEffect(() => {
    let active = true
    void Promise.all([app.providers(), app.bindings(), app.mediaSettings(), app.secureVaultStatus(), app.providerModelSelections(), app.providerChannelKinds()])
      .then(([connections, items, settings, secure, selectedModels, channelKinds]) => {
        if (!active) return
        setProviders(connections)
        setBindings(items.filter(item => !item.agentId))
        setMedia(settings)
        setVaultReady(secure)
        setModelSelections(selectedModels)
        const resolvedKinds = { ...channelKinds }
        for (const provider of connections) {
          if (resolvedKinds[provider.id]) continue
          resolvedKinds[provider.id] = items.some(item => item.purpose === 'main' && item.providerId === provider.id) ? 'text'
            : settings.imageProviderId === provider.id ? 'image'
              : settings.speechProviderId === provider.id ? 'speech' : 'text'
        }
        setProviderKinds(resolvedKinds)
        setReady(true)
        setLoadError('')
      }, error => { if (active) setLoadError(errorText(error)) })
    return () => { active = false }
  }, [app, version, retry])

  const addConnection = (kind: ProviderChannelKind) => setDetail({
    draft: { id: '', name: '', baseUrl: '', protocol: 'chat-completions', kind, enabled: true },
    tab: 'config'
  })
  const editConnection = (id: string, tab: ProviderDetail['tab'] = 'config') => {
    const provider = providers.find(item => item.id === id)
    if (provider) setDetail({ draft: { id: provider.id, name: provider.name, baseUrl: provider.baseUrl,
      protocol: provider.protocol, kind: providerKinds[id] ?? 'text', enabled: provider.enabled }, tab })
  }
  const channelsFor = (kind: ProviderChannelKind) => providers.filter(provider => (providerKinds[provider.id] ?? 'text') === kind)
  const modelsFor = (kind: ProviderChannelKind) => channelsFor(kind).flatMap(provider =>
    (modelSelections[provider.id] ?? []).map(modelId => ({ providerId: provider.id, providerName: provider.name, enabled: provider.enabled, modelId })))
  const saveModelSelection = async (providerId: string, modelIds: string[]) => {
    await app.saveProviderModelSelection(providerId, modelIds)
    setModelSelections(current => ({ ...current, [providerId]: [...modelIds] }))
  }
  const saveMedia = async (kind: 'image' | 'speech', providerId: string, modelId: string, voice: string) => {
    if (mediaSaving.current) return false
    if (Boolean(providerId) !== Boolean(modelId.trim())) throw new Error('请选择提供商和模型；同时留空可停用此功能')
    if (providerId && !channelsFor(kind).some(item => item.id === providerId && item.enabled)) throw new Error(`请选择可用的${kind === 'image' ? '图片' : '语音'}提供商`)
    mediaSaving.current = true
    setMediaBusy(true)
    try {
      const latest = await app.mediaSettings()
      const next = { ...latest, [`${kind}ProviderId`]: providerId, [`${kind}Model`]: modelId.trim(),
        ...(kind === 'speech' ? { voice: voice.trim() || 'alloy' } : {}) }
      await app.saveMediaSettings(next)
      setMedia(next)
      notify({ text: `${kind === 'image' ? '图片' : '语音'}配置已保存`, tone: 'ok' })
      return true
    } finally { mediaSaving.current = false; setMediaBusy(false) }
  }

  const main = bindings.find(item => item.purpose === 'main')
  const summary = bindings.find(item => item.purpose === 'summary')
  const textProviders = channelsFor('text')
  const saveDefaultText = async (value: string) => {
    const [providerId, modelId] = JSON.parse(value) as [string, string]
    if (!modelsFor('text').some(item => item.providerId === providerId && item.modelId === modelId && item.enabled)) {
      throw new Error('请选择已启用提供商中勾选的模型')
    }
    const next: ModelBinding = { ...bindingDraft(main), id: main?.id ?? crypto.randomUUID(), purpose: 'main',
      providerId, modelId, revision: main?.revision ?? 1 }
    await app.saveBinding(next)
    setBindings(current => [...current.filter(item => item.purpose !== 'main'), next])
    notify({ text: '默认文字模型已更新', tone: 'ok' })
  }
  if (!ready) return <div className="model-loading" role="status">{loadError
    ? <><p>{loadError}</p><button className="text-button" onClick={() => setRetry(value => value + 1)}>重新读取</button></>
    : '正在读取模型配置…'}</div>
  if (detail) return <ProviderEditor app={app} draft={detail.draft} initialTab={detail.tab}
    provider={providers.find(item => item.id === detail.draft.id)}
    selectedModels={modelSelections[detail.draft.id] ?? []} vaultReady={vaultReady} notify={notify}
    close={() => setDetail(null)} saveModels={saveModelSelection} saved={(provider, kind) => {
      setProviders(current => [provider, ...current.filter(item => item.id !== provider.id)])
      setProviderKinds(current => ({ ...current, [provider.id]: kind }))
      setDetail(null)
    }} deleted={providerId => {
      setProviders(current => current.filter(item => item.id !== providerId))
      setModelSelections(current => { const next = { ...current }; delete next[providerId]; return next })
      setProviderKinds(current => { const next = { ...current }; delete next[providerId]; return next })
      setDetail(null)
    }} />

  if (settingsPage === 'defaults') return <div className="model-settings default-model-settings">
    <p className="default-model-intro">为不同功能选择模型，选择后自动保存。</p>
    <section className="default-model-group" aria-label="默认模型选择">
      <DefaultModelChoice label="文字模型" description="角色未单独指定模型时使用" models={modelsFor('text')}
        value={main?.providerId ? modelValue(main.providerId, main.modelId) : ''} change={saveDefaultText} notify={notify} />
      {(['image', 'speech'] as const).map(kind => <DefaultModelChoice key={kind} disabled={mediaBusy} label={kind === 'image' ? '图片模型' : '语音模型'}
        description={kind === 'image' ? '根据聊天内容生成图片' : '生成语音并发送'} models={modelsFor(kind)} optional
        value={media[`${kind}ProviderId`] ? modelValue(media[`${kind}ProviderId`], media[`${kind}Model`]) : ''}
        change={async value => {
          const [providerId, modelId] = value ? JSON.parse(value) as [string, string] : ['', '']
          await saveMedia(kind, providerId, modelId, media.voice)
        }} notify={notify} />)}
    </section>
    <button type="button" className="default-providers-link text-button" onClick={openProviders}>
      管理提供商与可选模型<ChevronRightIcon /></button>
    <details className="model-auxiliary default-parameters">
      <summary><span><strong>文字模型参数</strong><small>上下文长度与单次输出上限</small></span><span className="settings-disclosure" aria-hidden="true">⌄</span></summary>
      <TextBindingEditor app={app} purpose="main" binding={main} providers={textProviders}
        selectableModels={modelsFor('text')} notify={notify} parametersOnly />
    </details>
    <details className="model-auxiliary default-voice-settings">
      <summary><span><strong>语音音色</strong><small>{media.voice || 'alloy'}</small></span><span className="settings-disclosure" aria-hidden="true">⌄</span></summary>
      <VoiceSettings voice={media.voice} busy={mediaBusy} save={voice => saveMedia('speech', media.speechProviderId, media.speechModel, voice)} notify={notify} />
    </details>
    <details className="model-auxiliary sticker-recognition-details"><summary><span><strong>表情包自动识图</strong><small>用看图模型理解收藏表情</small></span><span className="settings-disclosure" aria-hidden="true">⌄</span></summary>
      <StickerRecognitionSettings app={app} version={version} notify={notify} heading={false}/>
    </details>
    <details className="model-auxiliary model-auxiliary-bottom">
      <summary><span><strong>辅助判断与对话摘要</strong><small>可单独选择模型；未设置时沿用文字模型</small></span><span className="settings-disclosure" aria-hidden="true">⌄</span></summary>
      <TextBindingEditor app={app} purpose="triage" binding={bindings.find(item => item.purpose === 'triage')}
        fallback={summary ?? main} providers={textProviders} selectableModels={modelsFor('text')} notify={notify} />
      <TextBindingEditor app={app} purpose="summary" binding={summary} fallback={main} providers={textProviders} selectableModels={modelsFor('text')} notify={notify} />
    </details>
  </div>

  return <div className="model-settings provider-settings">
    <div className="model-tabs" role="tablist" aria-label="模型类型" onKeyDown={event => {
      const index = tabs.findIndex(item => item.id === tab)
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
      if (next < 0) return
      event.preventDefault()
      setTab(tabs[next].id)
      document.getElementById(`model-tab-${tabs[next].id}`)?.focus()
    }}>
      {tabs.map(item => <button className="model-tab" key={item.id} id={`model-tab-${item.id}`} type="button" role="tab"
        aria-selected={tab === item.id} aria-controls={`model-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1}
        onClick={() => setTab(item.id)}><strong>{item.label}</strong><small>{item.description}</small></button>)}
    </div>
    {loadError && <p className="model-inline-error" role="alert">配置刷新失败：{loadError}</p>}
    {tabs.map(({ id: kind, label }) => <div key={kind} className="model-panel" id={`model-panel-${kind}`}
      role="tabpanel" aria-labelledby={`model-tab-${kind}`} hidden={tab !== kind}>
      <section className="model-provider-section">
        <div className="model-provider-heading"><div><h2>{label}提供商</h2>
          <p>管理连接信息与可用模型。</p></div>
          {channelsFor(kind).length > 0 && <button className="btn-secondary" type="button" onClick={() => addConnection(kind)}><PlusIcon />添加提供商</button>}</div>
        <ProviderSection kind={kind} providers={channelsFor(kind)} modelSelections={modelSelections}
          open={editConnection} add={addConnection} />
      </section>
    </div>)}
  </div>
}

type SelectableModel = { providerId: string; providerName: string; enabled: boolean; modelId: string }
const modelValue = (providerId: string, modelId: string) => JSON.stringify([providerId, modelId])

function ProviderSection({ kind, providers, modelSelections, open, add }: {
  kind: ProviderChannelKind; providers: Provider[]; modelSelections: Record<string, string[]>
  open: (id: string, tab?: ProviderDetail['tab']) => void; add: (kind: ProviderChannelKind) => void
}) {
  const [query, setQuery] = useState('')
  const label = kind === 'text' ? '文字' : kind === 'image' ? '图片' : '语音'
  const normalized = query.trim().toLowerCase()
  const visible = providers.filter(provider => `${provider.name} ${provider.baseUrl}`.toLowerCase().includes(normalized))
  return <div className="model-provider-list-wrap" aria-label={`${label}提供商列表`}>
    {providers.length > 1 && <label className="model-provider-search"><SearchIcon />
      <input type="search" value={query} onChange={event => setQuery(event.target.value)}
        placeholder={`搜索${label}提供商`} aria-label={`搜索${label}提供商`} />
    </label>}
    {!!visible.length && <div className="model-provider-list">
      {visible.map(provider => {
        const selectedCount = (modelSelections[provider.id] ?? []).length
        return <button className="model-provider-row" type="button" key={provider.id}
          aria-label={`管理 ${provider.name} 提供商`} onClick={() => open(provider.id)}>
          <span className="model-provider-avatar" data-tone={provider.name.charCodeAt(0) % 5} aria-hidden="true">
            {provider.name.trim().charAt(0).toUpperCase() || '?'}
          </span>
          <span className="model-provider-copy"><strong>{provider.name}</strong>
            <small>{provider.baseUrl.replace(/^https?:\/\//, '')}</small>
            <span>{selectedCount} 个模型<i>{provider.credentialState === 'stored' ? 'Key 已保存' : '待设置 Key'}</i></span></span>
          <span className={'model-provider-status' + (provider.enabled ? '' : ' off')}>
            {provider.enabled ? '已启用' : '已停用'}
          </span>
          <ChevronRightIcon className="model-provider-chevron" />
        </button>
      })}
    </div>}
    {!visible.length && <div className="model-provider-empty">
      <strong>{providers.length ? '没有匹配的提供商' : `还没有${label}提供商`}</strong>
      <p>{providers.length ? '换个关键词，或清除搜索后重试。' : '添加 Base URL 与 API Key，即可拉取并选择模型。'}</p>
      {!providers.length && <button className="btn-primary model-provider-add" type="button" onClick={() => add(kind)}>
        <PlusIcon /><span>添加{label}提供商</span></button>}
    </div>}
  </div>
}

function TextBindingEditor({ app, purpose, binding, fallback, providers, selectableModels, notify, parametersOnly = false }: {
  app: AppApi; purpose: ModelBinding['purpose']; binding?: ModelBinding; fallback?: ModelBinding;
  providers: Provider[]; selectableModels: SelectableModel[]; notify: Notify; parametersOnly?: boolean
}) {
  const [draft, setDraft] = useState<BindingDraft>(() => bindingDraft(binding ?? fallback))
  const [busy, setBusy] = useState(false)
  const dirty = useRef(false)
  const change = (patch: Partial<BindingDraft>) => { dirty.current = true; setDraft(current => ({ ...current, ...patch })) }
  useEffect(() => {
    const next = bindingDraft(binding ?? fallback)
    if (!dirty.current) setDraft(next)
    else if (parametersOnly) setDraft(current => ({ ...current, providerId: next.providerId, modelId: next.modelId }))
  }, [binding, fallback, parametersOnly])
  const provider = providers.find(item => item.id === draft.providerId)
  const currentValue = draft.providerId && draft.modelId ? modelValue(draft.providerId, draft.modelId) : ''
  const providerInScope = !draft.providerId || Boolean(provider)
  const currentInList = selectableModels.some(item => modelValue(item.providerId, item.modelId) === currentValue)
  const preset = contextPresets.find(item => item.contextTokens === draft.contextTokens && item.outputTokens === draft.outputTokens)
  return <form className="model-form" onSubmit={event => {
    event.preventDefault()
    if (busy) return
    void (async () => {
      setBusy(true)
      try {
        if (!provider?.enabled) throw new Error('请先选择一个可用连接')
        await app.saveBinding({ ...draft, id: binding?.id ?? crypto.randomUUID(), modelId: draft.modelId.trim(), purpose, revision: binding?.revision ?? 1 })
        dirty.current = false
        notify({ text: `${purposeNames[purpose]}配置已保存${provider.credentialState === 'missing' ? '，请为连接设置 API Key' : ''}`, tone: 'ok' })
      } catch (error) { notify({ text: errorText(error), tone: 'error' }) }
      finally { setBusy(false) }
    })()
  }}>
    {purpose !== 'main' && <div className="model-form-heading"><h3>{purposeNames[purpose]}</h3><span>{binding?.providerId ? '已配置' : fallback?.providerId ? `沿用${purposeNames[fallback.purpose]}` : '待配置'}</span></div>}
    {purpose !== 'main' && <p className="hint">{purpose === 'triage' ? '判断角色何时回应；未单独配置时沿用摘要模型，再回退到主模型。' : '压缩较早的聊天记录；未单独配置时沿用主模型。'}</p>}
    <fieldset disabled={Boolean(busy)}>
      {!parametersOnly && <label>{purpose === 'main' ? '选择模型' : purposeNames[purpose]}
        <select required value={providerInScope ? currentValue : ''} onChange={event => {
          if (!event.target.value) { change({ providerId: '', modelId: '' }); return }
          const [providerId, modelId] = JSON.parse(event.target.value) as [string, string]
          change({ providerId, modelId })
        }}>
          <option value="">请选择已勾选的模型</option>
          {providerInScope && draft.providerId && draft.modelId && !currentInList && <option value={currentValue}>当前模型：{provider?.name ?? '原提供商'} · {draft.modelId}（未加入已选模型）</option>}
          {selectableModels.map(item => <option key={modelValue(item.providerId, item.modelId)} value={modelValue(item.providerId, item.modelId)} disabled={!item.enabled}>
            {item.providerName} · {item.modelId}{item.enabled ? '' : ' · 提供商已停用'}
          </option>)}
        </select>
      </label>}
      {!providerInScope && <p className="hint">当前默认文字模型提供商不属于文字分类，请重新选择文字提供商。</p>}
      {!selectableModels.length && !draft.modelId && <p className="hint">还没有可选模型，请在下方提供商里拉取并勾选。</p>}
      {providerInScope && draft.modelId && !currentInList && <p className="hint">当前默认模型尚未加入提供商的已选模型清单。</p>}
      <details className="model-advanced" open={parametersOnly || undefined}>
        <summary>模型参数<span>{preset ? `${preset.name} · ${preset.detail} · 输出 ${draft.outputTokens.toLocaleString()}` : `自定义 · 输出 ${draft.outputTokens.toLocaleString()}`}</span></summary>
        <label>上下文预设<select value={preset?.name ?? 'custom'} onChange={event => {
          const selected = contextPresets.find(item => item.name === event.target.value)
          if (selected) change({ contextTokens: selected.contextTokens, outputTokens: selected.outputTokens })
        }}>
          {contextPresets.map(item => <option key={item.name} value={item.name}>{item.name} · {item.detail}</option>)}
          <option value="custom">自定义</option>
        </select></label>
        <div className="two-cols">
          <label>上下文长度<input type="number" min={1025} step={1} value={draft.contextTokens} required
            onChange={event => change({ contextTokens: Number(event.target.value) })} /></label>
          <label>单次输出上限<input type="number" min={1} step={1} value={draft.outputTokens} required
            onChange={event => change({ outputTokens: Number(event.target.value) })} /></label>
        </div>
        <p className="hint">请按模型实际支持的范围设置；上下文至少比输出上限多 1,024 tokens。</p>
      </details>
      <div className="model-form-actions"><button className="btn-primary" type="submit" disabled={!provider?.enabled || !providerInScope || !draft.providerId || !draft.modelId.trim()}>{busy ? '正在保存…' : parametersOnly ? '保存参数' : `设为${purpose === 'main' ? '默认文字模型' : purposeNames[purpose]}`}</button></div>
    </fieldset>
  </form>
}

function DefaultModelChoice({ label, description, value, models, optional = false, disabled = false, change, notify }: {
  label: string; description: string; value: string; models: SelectableModel[]; optional?: boolean; disabled?: boolean
  change: (value: string) => Promise<unknown>; notify: Notify
}) {
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const known = models.some(item => modelValue(item.providerId, item.modelId) === value)
  const groups = [...new Map(models.map(model => [model.providerId, model.providerName])).entries()]
  return <label className="default-model-row">
    <span className="default-model-row-copy"><strong>{label}</strong><small>{description}</small></span>
    <select className="default-model-select" aria-label={label} value={value} disabled={busy || disabled} aria-busy={busy} onChange={event => {
      const next = event.target.value
      if (lock.current || next === value) return
      lock.current = true; setBusy(true)
      void change(next).catch(error => notify({ text: errorText(error), tone: 'error' }))
        .finally(() => { lock.current = false; setBusy(false) })
    }}>
      <option value="" disabled={!optional}>{optional ? '不启用' : '选择模型'}</option>
      {value && !known && <option value={value} disabled>当前模型已不可用，请重新选择</option>}
      {groups.map(([providerId, name]) => <optgroup key={providerId} label={name}>
        {models.filter(item => item.providerId === providerId).map(item => <option
          key={item.modelId} value={modelValue(item.providerId, item.modelId)} disabled={!item.enabled}>
          {item.providerName} · {item.modelId}{item.enabled ? '' : ' · 提供商已停用'}
        </option>)}
      </optgroup>)}
    </select>
    {busy && <small className="default-model-saving" role="status">正在保存…</small>}
  </label>
}

function VoiceSettings({ voice, busy, save, notify }: {
  voice: string; busy: boolean; save: (voice: string) => Promise<boolean>; notify: Notify
}) {
  const [draft, setDraft] = useState(voice)
  useEffect(() => { setDraft(voice) }, [voice])
  return <form className="model-form" onSubmit={event => {
    event.preventDefault()
    if (!busy) void save(draft).catch(error => notify({ text: errorText(error), tone: 'error' }))
  }}>
    <label>默认音色<input value={draft} disabled={busy} onChange={event => setDraft(event.target.value)}
      placeholder="alloy，或提供商的音色 ID" /></label>
    <button className="btn-secondary" type="submit" disabled={busy || draft === voice}>{busy ? '正在保存…' : '保存音色'}</button>
  </form>
}

function ProviderEditor({ app, draft: initial, initialTab, provider: initialProvider, selectedModels, vaultReady, notify, close, saved, deleted, saveModels }: {
  app: AppApi; draft: ConnectionDraft; initialTab: ProviderDetail['tab']; provider?: Provider; selectedModels: string[]
  vaultReady: boolean; notify: Notify; close: () => void
  saved: (provider: Provider, kind: ProviderChannelKind) => void; deleted: (id: string) => void
  saveModels: (providerId: string, modelIds: string[]) => Promise<void>
}) {
  const [tab, setTab] = useState(initialTab)
  const [draft, setDraft] = useState(initial)
  const [provider, setProvider] = useState(initialProvider)
  const [presetId, setPresetId] = useState('custom')
  const [secret, setSecret] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [catalog, setCatalog] = useState<ProviderModel[]>(() => selectedModels.map(id => ({ id, name: id, owner: '' })))
  const [selectedIds, setSelectedIds] = useState(selectedModels)
  const [modelQuery, setModelQuery] = useState('')
  const [manualModelId, setManualModelId] = useState('')
  const [modelError, setModelError] = useState('')
  const [modelStatus, setModelStatus] = useState('')
  const [modelBusy, setModelBusy] = useState(false)
  const [keyReady, setKeyReady] = useState(false)
  const [testBusy, setTestBusy] = useState(false)
  const [testStatus, setTestStatus] = useState<{ text: string; ok: boolean } | null>(null)
  const selectedIdsRef = useRef(selectedModels)
  const previewId = useRef(crypto.randomUUID())
  const previewOrigin = useRef('')
  const request = useRef<AbortController | null>(null)
  const page = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const manualInputId = useId()
  const native = Capacitor.isNativePlatform()
  const kindLabel = draft.kind === 'text' ? '文字' : draft.kind === 'image' ? '图片' : '语音'
  const displayName = draft.name.trim() || provider?.name || '新提供商'
  const presets = draft.kind === 'text' ? connectionPresets : connectionPresets.filter(item => item.id === 'custom' || item.id === 'openai')
  const networkBusy = modelBusy || testBusy
  const changed = JSON.stringify(draft) !== JSON.stringify(initial) || Boolean(secret.trim()) || keyReady
    || JSON.stringify([...selectedIds].sort()) !== JSON.stringify([...selectedModels].sort())

  useLayoutEffect(() => {
    page.current?.closest('.scroll-region')?.scrollTo({ top: 0 })
    page.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  }, [])
  useEffect(() => { setTestStatus(null); setError('') }, [draft.baseUrl, draft.protocol, secret])

  useEffect(() => {
    const credentialId = previewId.current
    return () => {
      request.current?.abort()
      void removeCredential(credentialId).catch(() => undefined)
    }
  }, [])

  const updateSelection = (next: string[]) => {
    if (next.length > 1000) { setModelError('每个提供商最多选择 1,000 个模型'); return }
    selectedIdsRef.current = next
    setSelectedIds(next)
    setModelError('')
  }
  const addManualModel = () => {
    const id = manualModelId.trim()
    if (!id) return
    if (id.length > 500) { setModelError('模型 ID 不能超过 500 个字符'); return }
    if (!selectedIdsRef.current.includes(id) && selectedIdsRef.current.length >= 1000) {
      setModelError('每个提供商最多选择 1,000 个模型'); return
    }
    setCatalog(current => current.some(item => item.id === id) ? current : [{ id, name: id, owner: '手动添加' }, ...current])
    updateSelection([...new Set([...selectedIdsRef.current, id])])
    setManualModelId('')
  }

  const prepareConnection = async (forceKey = false) => {
    if (!draft.baseUrl.trim()) throw new Error('请填写服务地址')
    const normalized = normalizeProviderAddress(draft.baseUrl, draft.protocol)
    const origin = modelOrigin(normalized.baseUrl)
    if (native && new URL(origin).protocol !== 'https:') throw new Error('Android 提供商请使用 HTTPS 服务地址')
    const staged = previewOrigin.current === origin && await credentialStatus(previewId.current)
    const existing = provider && modelOrigin(provider.baseUrl) === origin && await credentialStatus(provider.id)
    const promptKey = native && (forceKey || (!staged && !existing))
    if (secret.trim() || promptKey) {
      if (native && !vaultReady) throw new Error('安全凭证模块不可用，暂时无法输入 Key')
      if (native) await removeCredential(previewId.current)
      await storeCredential(previewId.current, native ? '__prompt__' : secret.trim(), origin)
      if (!await credentialStatus(previewId.current)) throw new Error('请先输入 API Key')
      previewOrigin.current = origin
      setKeyReady(true)
      return { ...normalized, id: previewId.current }
    }
    if (staged) return { ...normalized, id: previewId.current }
    if (existing && provider) return { ...normalized, id: provider.id }
    throw new Error('请填写 API Key')
  }

  const pullModels = async () => {
    if (busy || testBusy) return
    if (modelBusy) { request.current?.abort(); return }
    const controller = new AbortController()
    request.current = controller
    setModelBusy(true); setModelError(''); setModelStatus('')
    try {
      const connection = await prepareConnection()
      if (controller.signal.aborted) return
      const models = await fetchProviderModels(connection, controller.signal)
      if (controller.signal.aborted) return
      const known = new Set(models.map(item => item.id))
      const retained = selectedIdsRef.current.filter(id => !known.has(id)).map(id => ({ id, name: id, owner: '手动添加 / 已选' }))
      setCatalog([...retained, ...models])
      setModelQuery('')
      setModelStatus('已拉取 ' + models.length + ' 个模型，勾选要使用的模型。')
    } catch (reason) {
      if (!controller.signal.aborted) setModelError(errorText(reason))
    } finally {
      if (controller.signal.aborted) setModelStatus('已取消拉取，原有选择已保留。')
      if (request.current === controller) { request.current = null; setModelBusy(false) }
    }
  }

  const testConnection = async () => {
    if (busy || modelBusy) return
    if (testBusy) { request.current?.abort(); return }
    const controller = new AbortController()
    request.current = controller
    setTestBusy(true); setTestStatus(null)
    try {
      const connection = await prepareConnection()
      if (controller.signal.aborted) return
      const text = await testProviderConnection(connection, controller.signal)
      if (!controller.signal.aborted) setTestStatus({ text, ok: true })
    } catch (reason) {
      if (!controller.signal.aborted) setTestStatus({ text: errorText(reason), ok: false })
    } finally {
      if (controller.signal.aborted) setTestStatus({ text: '已取消测试', ok: false })
      if (request.current === controller) { request.current = null; setTestBusy(false) }
    }
  }

  const saveConnection = async () => {
    if (busy || networkBusy) return
    setBusy(true); setError('')
    try {
      // Renaming or disabling an existing supplier must also work after a browser session loses its Key.
      const normalized = normalizeProviderAddress(draft.baseUrl, draft.protocol)
      const connection = provider && modelOrigin(provider.baseUrl) === modelOrigin(normalized.baseUrl)
        && !secret.trim() && !keyReady ? { ...normalized, id: provider.id } : await prepareConnection()
      const providerId = provider?.id || crypto.randomUUID()
      const savedProvider = await app.saveProvider({
        id: providerId, name: draft.name.trim() || new URL(connection.baseUrl).hostname,
        baseUrl: connection.baseUrl, protocol: connection.protocol, credentialRef: '',
        credentialState: provider?.credentialState ?? 'missing', enabled: draft.enabled,
        configVersion: provider?.configVersion ?? 1, createdAt: provider?.createdAt ?? 0, updatedAt: provider?.updatedAt ?? 0
      }, undefined, connection.id === providerId ? undefined : connection.id)
      setProvider(savedProvider)
      setDraft(current => ({ ...current, id: savedProvider.id }))
      await app.saveProviderChannelKind(savedProvider.id, draft.kind)
      await saveModels(savedProvider.id, selectedIdsRef.current)
      notify({ text: kindLabel + '提供商已保存', tone: 'ok' })
      saved(savedProvider, draft.kind)
    } catch (reason) { setError(errorText(reason)); setTab('config') }
    finally { setBusy(false) }
  }

  const visibleModels = catalog.filter(item => (item.id + ' ' + item.name + ' ' + item.owner).toLowerCase().includes(modelQuery.trim().toLowerCase()))
  const canPull = Boolean(draft.baseUrl.trim()) && (Boolean(secret.trim()) || keyReady || provider?.credentialState === 'stored' || native)
  const closePage = () => {
    if (busy) return
    if (changed && !confirm('修改还未保存，确定放弃修改并返回？')) return
    request.current?.abort()
    close()
  }
  const switchTab = (next: ProviderDetail['tab']) => {
    setTab(next)
    page.current?.closest('.scroll-region')?.scrollTo({ top: 0 })
  }

  return <div ref={page} className="provider-page" aria-labelledby={titleId}>
    <div className="provider-page-topbar">
      <button type="button" className="provider-back" aria-label="返回提供商列表" disabled={busy} onClick={closePage}><BackIcon /></button>
      <span className="provider-page-avatar" data-tone={displayName.charCodeAt(0) % 5} aria-hidden="true">
        {displayName.charAt(0).toUpperCase() || '?'}
      </span>
      <div className="provider-page-title"><h2 id={titleId} tabIndex={-1}>{displayName}</h2>
        <small>{kindLabel}提供商 · {draft.enabled ? '已启用' : '已停用'}{!provider && ' · 未保存'}</small></div>
    </div>
    <div className="provider-detail-tabs" role="tablist" aria-label="提供商设置" onKeyDown={event => {
      const next = event.key === 'Home' ? 'config' : event.key === 'End' ? 'models'
        : ['ArrowLeft', 'ArrowRight'].includes(event.key) ? tab === 'config' ? 'models' : 'config' : null
      if (!next) return
      event.preventDefault(); switchTab(next)
      document.getElementById(`provider-${next}-tab`)?.focus()
    }}>
      <button className="provider-detail-tab" type="button" role="tab" id="provider-config-tab" aria-selected={tab === 'config'} tabIndex={tab === 'config' ? 0 : -1}
        aria-controls="provider-config-panel" onClick={() => switchTab('config')}>配置</button>
      <button className="provider-detail-tab" type="button" role="tab" id="provider-models-tab" aria-selected={tab === 'models'} tabIndex={tab === 'models' ? 0 : -1}
        aria-controls="provider-models-panel" onClick={() => switchTab('models')}>模型 <span>{selectedIds.length}</span></button>
    </div>
    <form className="provider-editor-form" noValidate onSubmit={event => { event.preventDefault(); void saveConnection() }}>
      <fieldset disabled={busy}>
        <div className="provider-detail-panel" id="provider-config-panel" role="tabpanel" aria-labelledby="provider-config-tab" hidden={tab !== 'config'}>
          <section className="provider-form-card">
            <div className="provider-form-card-heading"><div><h3>基本配置</h3><p>连接信息和凭证只保存在本机。</p></div>
              <label className="provider-enable-switch"><span>{draft.enabled ? '已启用' : '已停用'}</span>
                <input type="checkbox" aria-label="启用提供商" checked={draft.enabled} disabled={networkBusy}
                  onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /></label>
            </div>
            {!initialProvider && <label>服务预设<select disabled={networkBusy} value={presetId} onChange={event => {
              const item = presets.find(value => value.id === event.target.value)!
              setPresetId(item.id)
              setDraft(current => ({ ...current, name: item.id === 'custom' ? '' : item.name, baseUrl: item.baseUrl, protocol: item.protocol }))
            }}>{presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
            <label>名称<input disabled={networkBusy} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="选填，默认使用服务域名" /></label>
            <label>API Base URL<input aria-label="API Base URL" required type="url" disabled={networkBusy} value={draft.baseUrl} onChange={event => setDraft({ ...draft, baseUrl: event.target.value })}
              placeholder="https://api.example.com/v1" autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
            {native ? <div className="secure-key-note"><strong>API Key</strong>
              <span>{keyReady ? '已输入 API Key' : provider?.credentialState === 'stored' ? '已配置 API Key' : '通过安全输入窗口填写。'}</span>
              <button className="btn-quiet" type="button" disabled={networkBusy} onClick={() => {
                setBusy(true); setError('')
                void prepareConnection(true).catch(reason => setError(errorText(reason))).finally(() => setBusy(false))
              }}>{provider || keyReady ? '更换 API Key' : '填写 API Key'}</button>
            </div> : <div className="provider-key-field"><label htmlFor={`${titleId}-key`}>API Key</label>
              <div className="provider-key-input"><input id={`${titleId}-key`} type={showKey ? 'text' : 'password'} aria-label="API Key" disabled={networkBusy} value={secret} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={event => setSecret(event.target.value)}
                placeholder={provider ? '留空保留当前 Key' : '输入 API Key'} />
                <button className="btn-quiet" type="button" aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} aria-pressed={showKey}
                  onClick={() => setShowKey(value => !value)}>{showKey ? '隐藏' : '显示'}</button></div>
              <small>浏览器预览中的 Key 仅在当前会话暂存。</small></div>}
            {draft.kind === 'text' && <details className="model-advanced">
              <summary>接口协议<span>{draft.protocol === 'responses' ? 'OpenAI Responses' : 'OpenAI 兼容'}</span></summary>
              <label>文字接口协议<select disabled={networkBusy} value={draft.protocol} onChange={event => setDraft({ ...draft, protocol: event.target.value as ProviderProtocol })}>
                <option value="chat-completions">OpenAI 兼容 · Chat Completions</option><option value="responses">OpenAI · Responses</option>
              </select></label>
            </details>}
          </section>
          <section className="provider-form-card provider-test-card">
            <div className="provider-form-card-heading"><div><h3>连接诊断</h3><p>验证地址和 API Key 是否可以访问模型接口。</p></div></div>
            <button className="btn-secondary" type="button" disabled={modelBusy || (!testBusy && !canPull)} onClick={() => void testConnection()}>
              {testBusy ? '取消测试' : '测试连接'}</button>
            {testStatus && <p className={'provider-connection-result' + (testStatus.ok ? ' success' : ' failure')} role="status">{testStatus.text}</p>}
          </section>
          {initialProvider && <section className="provider-danger-zone">
            <div><h3>删除提供商</h3><p>同时移除本机保存的 API Key；引用它的模型配置将无法连接。</p></div>
            <button className="btn-danger" type="button" disabled={networkBusy} onClick={() => {
              if (!confirm('删除这个提供商及本机保存的 API Key？使用它的模型配置将无法连接。')) return
              setBusy(true); setError('')
              void app.deleteProvider(initialProvider.id).then(() => {
                deleted(initialProvider.id); notify({ text: '提供商已删除', tone: 'ok' })
              }, reason => setError(errorText(reason))).finally(() => setBusy(false))
            }}>删除提供商</button>
          </section>}
        </div>
        <div className="provider-detail-panel" id="provider-models-panel" role="tabpanel" aria-labelledby="provider-models-tab" hidden={tab !== 'models'}>
          <section className="provider-models-summary">
            <div><span className="model-eyebrow">可用模型</span><strong>{selectedIds.length ? `已选择 ${selectedIds.length} 个模型` : '尚未选择模型'}</strong>
              <p>拉取提供商返回的列表，再勾选角色可使用的模型。</p></div>
            <button className="btn-secondary" type="button" disabled={testBusy || (!modelBusy && !canPull)} onClick={() => void pullModels()}>
              {modelBusy ? '取消拉取' : '拉取模型'}</button>
          </section>
          {modelError && <p className="model-inline-error" role="alert">{modelError}</p>}
          {modelStatus && <p className="provider-model-status" role="status">{modelStatus}</p>}
          {modelBusy && <p className="provider-model-status" role="status">正在拉取模型列表…</p>}
          {!!catalog.length && <label className="model-catalog-search"><SearchIcon /><input type="search" value={modelQuery}
            onChange={event => setModelQuery(event.target.value)} placeholder="搜索模型" aria-label="搜索模型"
            onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} /></label>}
          <div className="channel-model-list provider-model-list" aria-label="可选模型" aria-busy={modelBusy}>
            {visibleModels.slice(0, 150).map(model => <label key={model.id} className="channel-model-option">
              <input type="checkbox" disabled={modelBusy} aria-label={model.id} checked={selectedIds.includes(model.id)} onChange={event => updateSelection(event.target.checked
                ? [...new Set([...selectedIdsRef.current, model.id])] : selectedIdsRef.current.filter(value => value !== model.id))} />
              <span>{model.id}{model.name !== model.id && <small>{model.name}</small>}</span>
            </label>)}
            {!visibleModels.length && <div className="provider-model-empty">
              <strong>{modelQuery ? '没有匹配的模型' : '模型列表为空'}</strong>
              <p>{modelQuery ? '换个关键词，或清除搜索后重试。' : '填写地址和 Key 后点击“拉取模型”，也可以在下方手动添加。'}</p>
            </div>}
          </div>
          {visibleModels.length > 150 && <p className="hint">共匹配 {visibleModels.length} 个，当前显示前 150 个；可搜索模型名称。</p>}
          <section className="provider-manual-model">
            <div><h3>手动添加</h3><p>提供商不提供模型列表时，可以直接填写模型 ID。</p></div>
            <div className="channel-model-manual">
              <input id={manualInputId} value={manualModelId} disabled={modelBusy} onChange={event => setManualModelId(event.target.value)} placeholder="填写模型 ID" aria-label="手动模型 ID"
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addManualModel() } }} />
              <button className="btn-quiet" type="button" disabled={modelBusy || !manualModelId.trim()} onClick={addManualModel}>添加</button>
            </div>
          </section>
        </div>
      </fieldset>
      {error && <p className="model-inline-error provider-save-error" role="alert">{error}</p>}
      <div className="provider-save-bar">
        <button type="submit" className="btn-primary" disabled={busy || networkBusy}>{busy ? '正在保存…' : '保存'}</button>
      </div>
    </form>
  </div>
}
