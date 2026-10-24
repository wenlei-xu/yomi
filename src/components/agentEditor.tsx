import { useEffect, useRef, useState } from 'react'
import type { AppApi } from '../app/bootstrap'
import type { Actor, AgentSettingsUpdate, AgentStatus, ModelBinding, Provider } from '../domain/types'
import { Avatar } from './avatar'
import { readImageThumbnail } from './avatarImage'
import { BackIcon } from './icons'
import { ActorWorldBookBindings } from './lorebooks'
import { OriginalCard } from './cardImport'

type Notify = (notice: { text: string; tone: 'ok' | 'error' }) => void
type ModelDraft = { providerId: string; modelId: string; contextTokens: number; outputTokens: number }
type ModelDrafts = Record<ModelBinding['purpose'], ModelDraft>
const purposes = ['main', 'triage', 'summary'] as const
const modelLabels = { main: '对话模型', triage: '辅助判断', summary: '对话摘要' }
const modelKey = (providerId: string, modelId: string) => JSON.stringify([providerId, modelId])
const defaults = (): ModelDrafts => ({
  main: { providerId: '', modelId: '', contextTokens: 32768, outputTokens: 2048 },
  triage: { providerId: '', modelId: '', contextTokens: 32768, outputTokens: 512 },
  summary: { providerId: '', modelId: '', contextTokens: 32768, outputTokens: 1800 }
})
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试'

export function AgentEditor({ app, initial, close, notify }: {
  app: AppApi; initial: Partial<Actor> | null; close: () => void; notify: Notify
}) {
  const initialForm = useRef({ name: initial?.name ?? '', bio: initial?.bio ?? '', persona: initial?.persona ?? '',
    speakingStyle: initial?.speakingStyle ?? '', greeting: initial?.greeting ?? '', color: initial?.color ?? '#46a6d9', avatarData: initial?.avatarData ?? '',
    allowPrivate: initial?.allowPrivate ?? true, allowGroup: initial?.allowGroup ?? true })
  const [form, setForm] = useState(initialForm.current)
  const [status, setStatus] = useState({ enabled: initial?.enabled ?? true, archived: initial?.archived ?? false })
  const [busy, setBusy] = useState(false)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [memo, setMemo] = useState('')
  const [memoDirty, setMemoDirty] = useState(false)
  const [models, setModels] = useState(defaults)
  const [modelsDirty, setModelsDirty] = useState(false)
  const [providers, setProviders] = useState<Provider[]>([])
  const [modelOptions, setModelOptions] = useState<{ key: string; providerId: string; modelId: string; label: string }[]>([])
  const [extrasReady, setExtrasReady] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [activeSection, setActiveSection] = useState<'profile' | 'behavior' | 'models' | 'knowledge' | 'status'>('profile')
  const lock = useRef(false)
  const avatarInput = useRef<HTMLInputElement>(null)
  const screen = useRef<HTMLElement>(null)
  const dirty = JSON.stringify(form) !== JSON.stringify(initialForm.current) || memoDirty || modelsDirty
  const preview: Actor = { ...form, ...status, id: initial?.id ?? 'preview', kind: 'agent',
    profileVersion: initial?.profileVersion ?? 1, createdAt: initial?.createdAt ?? 0, updatedAt: 0 }

  useEffect(() => {
    const previous = document.activeElement
    screen.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])

  useEffect(() => {
    let active = true
    setLoadError('')
    void Promise.all([app.providers(), app.bindings(), app.providerChannelKinds(), app.providerModelSelections(),
      initial?.id ? app.memories(initial.id) : Promise.resolve([])]).then(([allProviders, bindings, kinds, selections, memories]) => {
      if (!active) return
      const textProviders = allProviders.filter(provider => provider.enabled && (kinds[provider.id] ?? 'text') === 'text')
      setProviders(textProviders)
      setModelOptions(textProviders.flatMap(provider => (selections[provider.id] ?? []).map(modelId => ({
        key: modelKey(provider.id, modelId), providerId: provider.id, modelId, label: `${provider.name} · ${modelId}`
      }))))
      setModels(current => Object.fromEntries(purposes.map(purpose => {
        const binding = bindings.find(item => item.agentId === initial?.id && Boolean(initial?.id) && item.purpose === purpose)
        return [purpose, binding ? { providerId: binding.providerId ?? '', modelId: binding.modelId,
          contextTokens: binding.contextTokens, outputTokens: binding.outputTokens } : current[purpose]]
      })) as ModelDrafts)
      setMemo(memories.find(item => item.kind === 'private-note' && !item.conversationId && item.origin === 'human')?.body ?? '')
      setExtrasReady(true)
    }, error => { if (active) setLoadError(errorText(error)) })
    return () => { active = false }
  }, [app, initial?.id, reload])

  const requestClose = () => {
    if (busy || avatarBusy) return
    if (dirty && !confirm('还有未保存的角色修改，确定放弃？')) return
    close()
  }
  const changeStatus = async (next: AgentStatus) => {
    if (!initial?.id || lock.current) return
    lock.current = true; setBusy(true)
    try {
      const saved = await app.setAgentStatus(initial.id, next)
      setStatus({ enabled: saved.enabled, archived: saved.archived })
      notify({ text: next === 'active' ? '角色已启用，从新消息继续聊天' : next === 'archived' ? '角色已归档，聊天和记忆保留' : '角色已停用，聊天和记忆保留', tone: 'ok' })
    } catch (error) { notify({ text: errorText(error), tone: 'error' }) }
    finally { lock.current = false; setBusy(false) }
  }
  const save = async () => {
    if (lock.current || avatarBusy || !form.name.trim()) return
    lock.current = true; setBusy(true)
    try {
      const settings: AgentSettingsUpdate = {}
      if (memoDirty) settings.privateMemo = memo
      if (modelsDirty) settings.modelBindings = purposes.filter(purpose => models[purpose].providerId).map(purpose => ({
        ...models[purpose], id: crypto.randomUUID(), purpose, revision: 1
      }))
      const saved = await app.saveAgent({ id: initial?.id, ...form }, settings)
      notify({ text: `已保存角色：${saved.name}`, tone: 'ok' })
      close()
    } catch (error) { notify({ text: errorText(error), tone: 'error' }) }
    finally { lock.current = false; setBusy(false) }
  }

  return <section ref={screen} tabIndex={-1} className="agent-editor-screen" aria-labelledby="agent-editor-title"
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); requestClose() } }}>
      <header className="agent-editor-page-header">
        <button type="button" className="icon-button" aria-label="返回" disabled={busy || avatarBusy} onClick={requestClose}><BackIcon /></button>
        <h2 id="agent-editor-title">{initial?.id ? '编辑角色' : '新建角色'}</h2>
        <span aria-hidden="true" />
      </header>
      {initial?.id && <nav className="agent-editor-tabs" aria-label="角色设置分类">
        {([['profile','资料'],['behavior','互动'],['models','模型'],['knowledge','世界书'],['status','状态']] as const).map(([id,label]) =>
          <button type="button" key={id} aria-pressed={activeSection===id} onClick={() => setActiveSection(id)}>{label}</button>)}
      </nav>}
      <div className="agent-editor-content">
      {(activeSection === 'profile' || !initial?.id) && <>
      <fieldset className="agent-editor-fields" disabled={busy}>
        <div className="agent-profile-top">
          <button type="button" className="agent-avatar-button" disabled={avatarBusy} aria-label="更换角色头像" onClick={() => avatarInput.current?.click()}>
            <Avatar actor={preview} size={86} showStatus={false} /><span>{avatarBusy ? '处理中…' : '更换头像'}</span></button>
          <div className="agent-avatar-copy"><strong>{form.name.trim() || '给角色起个名字'}</strong>
            <span>PNG、JPG、WebP，2 MB 以内</span><span>图片会居中裁剪并保存在本机</span>
            {form.avatarData && <button type="button" className="text-button" disabled={avatarBusy} onClick={() => setForm(current => ({ ...current, avatarData: '' }))}>恢复默认头像</button>}
          </div>
          <input ref={avatarInput} type="file" className="agent-avatar-input" aria-label="选择角色头像图片" accept="image/png,image/jpeg,image/webp" disabled={avatarBusy}
            onChange={async event => {
              const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''
              if (!file) return
              setAvatarBusy(true)
              try { const avatarData = await readImageThumbnail(file); setForm(current => ({ ...current, avatarData })) }
              catch (error) { notify({ text: errorText(error), tone: 'error' }) }
              finally { setAvatarBusy(false) }
            }} />
        </div>
        <label>角色名称<input value={form.name} maxLength={100} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} placeholder="怎么称呼这位角色" /></label>
        <label>简介<input value={form.bio} onChange={event => setForm(current => ({ ...current, bio: event.target.value }))} placeholder="一句话介绍这个角色" /></label>
        <label>人设<textarea rows={5} value={form.persona} onChange={event => setForm(current => ({ ...current, persona: event.target.value }))} placeholder="身份、性格、经历，以及与你的关系" /></label>
        <label>说话风格<textarea rows={2} value={form.speakingStyle} onChange={event => setForm(current => ({ ...current, speakingStyle: event.target.value }))} placeholder="例如：短句、自然，偶尔开玩笑" /></label>
        <label>开场白<textarea rows={3} maxLength={8000} value={form.greeting} onChange={event => setForm(current => ({ ...current, greeting: event.target.value }))} placeholder="角色第一次与你聊天时说的话（可留空）" />
          <small className="hint">会显示在空白私聊中，点击后作为角色的第一条消息发送。导入角色卡的开场白仍保留为其他选项。</small></label>
      </fieldset>
      </>}
      {activeSection === 'behavior' && initial?.id && <fieldset className="agent-editor-fields agent-editor-section" disabled={busy}>
          <label>私有备忘<textarea rows={4} disabled={!extrasReady} value={memo} onChange={event => { setMemo(event.target.value); setMemoDirty(true) }} placeholder="只供这个角色参考，跨会话保留" /></label>
          <div className="settings-toggle-group">
            <label className="switch-row"><span>允许主动与其他角色私聊</span><input type="checkbox" checked={form.allowPrivate} onChange={event => setForm(current => ({ ...current, allowPrivate: event.target.checked }))} /></label>
            <label className="switch-row"><span>允许建立角色小组</span><input type="checkbox" checked={form.allowGroup} onChange={event => setForm(current => ({ ...current, allowGroup: event.target.checked }))} /></label>
          </div>
          <label className="agent-color-field">默认头像颜色<input type="color" value={form.color} onChange={event => setForm(current => ({ ...current, color: event.target.value }))} /></label>
      </fieldset>}
      {activeSection === 'models' && initial?.id && <fieldset className="agent-editor-fields agent-editor-section" disabled={busy}>
          {loadError ? <p className="hint">{loadError}<button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>重新加载</button></p>
            : !extrasReady ? <p className="hint">正在读取模型配置…</p> : <>
              {purposes.map(purpose => {
                const model = models[purpose]
                const key = model.providerId ? modelKey(model.providerId, model.modelId) : ''
                return <div className="agent-model-field" key={purpose}>
                  <label>{modelLabels[purpose]}<select value={key} onChange={event => {
                    const option = modelOptions.find(item => item.key === event.target.value)
                    setModels(current => ({ ...current, [purpose]: { ...current[purpose], providerId: option?.providerId ?? '', modelId: option?.modelId ?? '' } })); setModelsDirty(true)
                  }}><option value="">沿用应用默认</option>
                    {key && !modelOptions.some(option => option.key === key) && <option value={key}>{providers.find(provider => provider.id === model.providerId)?.name ?? '原渠道'} · {model.modelId}（当前配置）</option>}
                    {modelOptions.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
                  </select></label>
                  {model.providerId && <details><summary>上下文与输出上限</summary><div className="two-cols">
                    <label>上下文长度<input type="number" min={1025} value={model.contextTokens} onChange={event => { setModels(current => ({ ...current, [purpose]: { ...current[purpose], contextTokens: Number(event.target.value) } })); setModelsDirty(true) }} /></label>
                    <label>单次输出上限<input type="number" min={1} value={model.outputTokens} onChange={event => { setModels(current => ({ ...current, [purpose]: { ...current[purpose], outputTokens: Number(event.target.value) } })); setModelsDirty(true) }} /></label>
                  </div></details>}
                </div>
              })}
              {!modelOptions.length && <p className="hint">先到“我 → 提供商 → 文字”添加提供商并勾选模型。</p>}
            </>}
      </fieldset>}
      {loadError && (activeSection === 'behavior' || activeSection === 'models') && <p className="hint">私有备忘与独立模型未能加载，仍可保存基本资料。<button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>重试</button></p>}
      {activeSection === 'knowledge' && initial?.id && <div className="agent-editor-section">
        <ActorWorldBookBindings app={app} actorId={initial.id} notify={notify} /><OriginalCard app={app} actorId={initial.id} notify={notify} />
      </div>}
      {activeSection === 'status' && initial?.id && <div className="agent-lifecycle">
        <div><strong>{status.archived ? '角色已归档' : status.enabled ? '角色已启用' : '角色已停用'}</strong>
          <p>{status.archived ? '恢复后会直接启用；聊天与记忆始终保留。' : '停用会立即停止回复，聊天与记忆继续保留。'}</p></div>
        <div className="actions">
          <button className={status.enabled ? 'btn-quiet' : 'btn-primary'} type="button" disabled={busy} onClick={() => void changeStatus(status.archived ? 'active' : status.enabled ? 'disabled' : 'active')}>
            {status.archived ? '恢复并启用' : status.enabled ? '停用角色' : '启用角色'}</button>
          {!status.archived && <button className="btn-quiet" type="button" disabled={busy} onClick={() => void changeStatus('archived')}>归档角色</button>}
          <button className="btn-danger" type="button" disabled={busy} onClick={async () => {
            if (!confirm(`彻底删除“${initial.name}”？角色资料和记忆将删除，历史聊天仍保留。`)) return
            if (lock.current) return
            lock.current = true; setBusy(true)
            try { await app.deleteAgent(initial.id!); notify({ text: '角色已删除，历史聊天保留', tone: 'ok' }); close() }
            catch (error) { notify({ text: errorText(error), tone: 'error' }) }
            finally { lock.current = false; setBusy(false) }
          }}>删除角色</button>
        </div>
      </div>}
      </div>
      {activeSection !== 'status' && <div className="agent-editor-footer"><p>保存后，人设变化会从下一条消息开始生效。</p>
        <button type="button" className="wide-primary" disabled={busy || avatarBusy || !form.name.trim() || (!dirty && !!initial?.id)} onClick={() => void save()}>
          {busy ? '正在保存…' : initial?.id ? dirty ? '保存修改' : '已保存' : '创建角色'}</button></div>}
  </section>
}
