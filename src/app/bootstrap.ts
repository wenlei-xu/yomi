import { Capacitor } from '@capacitor/core'
import { App as CapacitorApp } from '@capacitor/app'
import { Proactive, backgroundSupported } from '../platform/proactive'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { AgentRuntime } from '../agent/runtime'
import { DataStore, type RecoveryInfo } from '../data/store'
export type { RecoveryInfo } from '../data/store'
import { Repository, localUserId } from '../data/repository'
import { encryptBackup, decryptBackup } from '../data/backupCrypto'
import { createBackupZip, readBackupZip, type BackupModule, type BackupPreview } from '../data/modularBackup'
import { CommandGate } from './maintenance'
import { resolveBinding } from '../agent/policy'
import { parseCharacterCard, parseWorldBook } from '../data/characterCard'
import { generateImage, generateSpeech, MediaProtocolError } from '../media/generate'
import { StickerRecognizer } from '../media/stickerRecognizer'
import { prepareStickerImages } from '../media/stickerImages'
import type {
  Actor,
  AgentSettingsUpdate,
  AgentStatus,
  Conversation,
  Lorebook,
  LorebookEntry,
  MediaAsset,
  MediaSettings,
  Sticker,
  StickerRecognitionSettings,
  Memory,
  Message,
  ModelBinding,
  ModelCallRecord,
  Provider,
  ProviderChannelKind,
  ProviderModel,
  ModelTestResult,
  ConversationNote,
  ProactiveRule,
  RuntimeIssue,
  SearchHit,
  SummaryEntry,
  ConversationMemorySource,
  UsageSummary,
  StorageStats
} from '../domain/types'
import { fetchProviderModels, testProviderConnection as probeProviderConnection } from '../model/catalog'
import { normalizeProviderAddress } from '../model/providerConfig'
import { testTextConnection, testMediaConnection } from '../model/connectionTest'
import {
  credentialStatus,
  copyCredential,
  modelOrigin,
  removeCredential,
  storeCredential,
  verifySecureVault
} from '../platform/secureTransport'

export interface AppApi {
  runtime: AgentRuntime
  backgroundSupported(): boolean
  setBackgroundEnabled(enabled: boolean): Promise<void>
  localUser(): Promise<Actor>
  actors(): Promise<Actor[]>
  providers(): Promise<Provider[]>
  secureVaultStatus(): Promise<boolean>
  bindings(): Promise<ModelBinding[]>
  conversations(includeHidden?: boolean): Promise<Conversation[]>
  whispers(): Promise<Conversation[]>
  conversation(conversationId: string): Promise<Conversation>
  messages(conversationId: string, before?: number): Promise<Message[]>
  message(messageId: string): Promise<Message | null>
  messagesAround(conversationId: string, messageId: string): Promise<{
    messages: Message[]
    hasOlder: boolean
    hasNewer: boolean
  }>
  sendUser(conversationId: string, body: string, quotedId?: string | null, mentionIds?: string[], commandId?: string): Promise<Message>
  saveDraft(conversationId: string, body: string, quotedId?: string | null): Promise<void>
  draft(conversationId: string): Promise<{ body: string; quotedId: string | null }>
  markRead(conversationId: string, through: number): Promise<void>
  react(messageId: string, emoji: string): Promise<void>
  deleteMessage(messageId: string): Promise<void>
  editMessage(messageId: string, body: string): Promise<void>
  recallMessage(messageId: string): Promise<void>
  regenerateMessage(messageId: string): Promise<string>
  saveUserProfile(name: string, bio: string, avatarData?: string): Promise<void>
  saveProvider(provider: Provider, secret?: string, credentialSourceId?: string): Promise<Provider>
  deleteProvider(providerId: string): Promise<void>
  saveBinding(binding: ModelBinding): Promise<void>
  clearAgentBinding(agentId: string, purpose: ModelBinding['purpose']): Promise<void>
  listProviderModels(providerId: string, signal?: AbortSignal): Promise<ProviderModel[]>
  testProviderConnection(providerId: string, signal?: AbortSignal): Promise<string>
  providerModelSelections(): Promise<Record<string, string[]>>
  saveProviderModelSelection(providerId: string, modelIds: string[]): Promise<void>
  providerChannelKinds(): Promise<Record<string, ProviderChannelKind>>
  saveProviderChannelKind(providerId: string, kind: ProviderChannelKind): Promise<void>
  testProvider(providerId: string, modelId: string, signal?: AbortSignal): Promise<string>
  testMediaProvider(providerId: string, modelId: string, kind: 'image' | 'speech', voice?: string, signal?: AbortSignal): Promise<ModelTestResult>
  saveAgent(agent: Partial<Actor> & { name: string }, settings?: AgentSettingsUpdate): Promise<Actor>
  setAgentStatus(agentId: string, status: AgentStatus): Promise<Actor>
  copyAgent(agentId: string): Promise<Actor>
  deleteAgent(agentId: string): Promise<void>
  openDirect(agentId: string): Promise<Conversation>
  createGroup(title: string, members: string[], topic?: string): Promise<Conversation>
  updateMembers(conversationId: string, addIds: string[], removeIds: string[]): Promise<void>
  updateConversation(conversationId: string, patch: {
    title?: string
    topic?: string
    announcement?: string
    pinned?: boolean
    muted?: boolean
    hidden?: boolean
    paused?: boolean
    autonomyPaused?: boolean
  }): Promise<void>
  clearConversation(conversationId: string): Promise<void>
  deleteConversation(conversationId: string): Promise<void>
  memories(agentId: string, conversationId?: string): Promise<Memory[]>
  summaryTimeline(conversationId: string, agentId: string, beforeThrough?: number): Promise<SummaryEntry[]>
  conversationMemorySources(conversationId: string, agentId: string): Promise<ConversationMemorySource[]>
  setConversationMemorySources(conversationId: string, agentId: string, sourceIds: string[]): Promise<void>
  lorebooks(): Promise<Lorebook[]>
  saveLorebook(input: {
    id?: string
    title: string
    description?: string
    scope?: Lorebook['scope']
    conversationId?: string | null
    enabled?: boolean
  }): Promise<Lorebook>
  deleteLorebook(lorebookId: string): Promise<void>
  lorebookEntries(lorebookId: string): Promise<LorebookEntry[]>
  saveLorebookEntry(input: {
    id?: string
    lorebookId: string
    title?: string
    content: string
    keywords?: string[]
    enabled?: boolean
    constant?: boolean
    secondaryKeywords?: string[]
    selective?: boolean
    caseSensitive?: boolean
    ordinal?: number
  }): Promise<LorebookEntry>
  deleteLorebookEntry(entryId: string): Promise<void>
  conversationLorebooks(conversationId: string): Promise<Lorebook[]>
  setConversationLorebooks(conversationId: string, lorebookIds: string[]): Promise<void>
  actorLorebooks(actorId: string): Promise<Lorebook[]>
  setActorLorebooks(actorId: string, lorebookIds: string[]): Promise<void>
  mediaAssets(filter?: {
    kind?: MediaAsset['kind']
    messageId?: string
    ownerActorId?: string | null
    conversationId?: string | null
    limit?: number
  }): Promise<MediaAsset[]>
  mediaData(assetId: string): Promise<string | null>
  deleteMediaAsset(assetId: string): Promise<void>
  generateAgentImage(agentId: string, prompt: string, conversationId?: string): Promise<MediaAsset>
  generateAgentVoice(agentId: string, text: string, voice: string, conversationId?: string, messageId?: string): Promise<MediaAsset>
  stickers(): Promise<Sticker[]>
  saveSticker(name: string, dataUrl: string): Promise<Sticker>
  deleteSticker(stickerId: string): Promise<void>
  stickerRecognitionSettings(): Promise<StickerRecognitionSettings>
  saveStickerRecognitionSettings(settings: Pick<StickerRecognitionSettings, 'enabled' | 'providerId' | 'modelId'>, consentGranted?: boolean): Promise<StickerRecognitionSettings>
  retryStickerRecognition(stickerId: string): Promise<void>
  importCharacterCard(fileName: string, content: string, png?: string): Promise<{ actor: Actor; unsupported: string[] }>
  importWorldBook(content: string): Promise<Lorebook>
  exportWorldBook(bookId: string): Promise<string>
  characterSource(actorId: string): Promise<{ json: string; png: string; warnings: string[] } | null>
  exportOriginalCard(actorId: string): Promise<string>
  greetings(actorId: string): Promise<string[]>
  startGreeting(conversationId: string, body: string): Promise<void>
  mediaSettings(): Promise<MediaSettings>
  saveMediaSettings(settings: MediaSettings): Promise<void>
  sendMedia(conversationId: string, assetId: string, commandId: string): Promise<void>
  sendSticker(conversationId: string, stickerId: string, commandId: string): Promise<void>
  cancelMedia(conversationId?: string): void
  saveMemory(memory: {
    id?: string
    agentId: string
    conversationId?: string | null
    body: string
    kind?: string
    about?: string
    pinned?: boolean
    origin?: 'human' | 'agent'
  }): Promise<Memory>
  deleteMemory(memoryId: string): Promise<void>
  moveMemoryScope(memoryId: string, conversationId: string | null): Promise<void>
  conversationNotes(conversationId: string): Promise<ConversationNote[]>
  saveConversationNote(input: {
    id?: string
    conversationId: string
    scope: 'shared' | 'private'
    targetActorId?: string | null
    body: string
  }): Promise<ConversationNote>
  deleteConversationNote(noteId: string): Promise<void>
  proactiveRules(conversationId?: string): Promise<ProactiveRule[]>
  saveProactiveRule(input: {
    id?: string
    conversationId: string
    actorId?: string | null
    mode: 'interval' | 'daily'
    intervalMinutes?: number
    dailyAt?: number
    prompt?: string
    enabled?: boolean
  }): Promise<ProactiveRule>
  deleteProactiveRule(ruleId: string): Promise<void>
  searchMessages(query: string, options?: { offset?: number; conversationId?: string; authorId?: string; beforeCreatedAt?: number; beforeId?: string }): Promise<SearchHit[]>
  exportBackupZip(password: string, modules: BackupModule[]): Promise<string>
  previewBackupZip(bytes: Uint8Array, password: string): Promise<BackupPreview>
  restoreBackupZip(bytes: Uint8Array, password: string, modules: BackupModule[], overwrite: boolean): Promise<void>
  exportBackup(password: string): Promise<string>
  importBackup(fileName: string, content?: string, password?: string): Promise<void>
  dataRecovery(): Promise<RecoveryInfo>
  rollbackData(): Promise<void>
  discardRecovery(): Promise<void>
  exportConversation(conversationId: string, format: 'json' | 'markdown'): Promise<string>
  exportAgent(agentId: string): Promise<string>
  importAgent(fileName: string, content?: string): Promise<Actor>
  usage(): Promise<ModelCallRecord[]>
  usageSummary(): Promise<UsageSummary>
  storageStats(): Promise<StorageStats>
  clearFinishedLogs(): Promise<void>
  compactStorage(): Promise<void>
  exportDiagnostics(): Promise<string>
  runtimeIssues(): Promise<RuntimeIssue[]>
  stop(conversationId: string): void
  stopAll(): void
  resume(conversationId: string): void
  retry(conversationId: string): void
  ignoreRecovery(conversationId: string): void
  clearAll(): Promise<void>
  refresh(): Promise<void>
}

function mediaReason(error: unknown): string {
  if (error instanceof MediaProtocolError) return error.message
  return error instanceof Error ? error.message.slice(0, 240) : '媒体生成失败'
}

let applicationPromise: Promise<AppApi> | null = null

export function createApp(onChange: () => void): Promise<AppApi> {
  applicationPromise ??= initializeApp(onChange).catch(error => {
    applicationPromise = null
    throw error
  })
  return applicationPromise
}

async function initializeApp(onChange: () => void): Promise<AppApi> {
  const store = new DataStore()
  await store.open()
  const database = store.database
  const repository = new Repository(database)
  await repository.interruptMedia()
  await repository.ensureLocalUser()
  const runtime = new AgentRuntime(
    repository,
    () => repository.listProviders(),
    () => repository.listBindings()
  )
  runtime.onChange(onChange)
  await runtime.start()
  if (backgroundSupported()) {
    await Proactive.addListener('tick', () => { void runtime.proactiveTick().catch(() => onChange()) })
    await Proactive.addListener('stopped', () => runtime.setBackgroundEnabled(false))
    runtime.onBackgroundMessage = title => { void Proactive.notifyMessage({ title }).catch(() => undefined) }
    runtime.setBackgroundEnabled((await Proactive.status()).running)
  }

  const syncCredentialStates = async (): Promise<void> => {
    const providers = await repository.listProviders()
    for (const provider of providers) {
      const stored = await credentialStatus(provider.id)
      const state = stored ? 'stored' : 'missing'
      if (provider.credentialState !== state) {
        await repository.saveProvider({ ...provider, credentialState: state })
      }
    }
  }
  await syncCredentialStates()
  const stickerRecognizer = new StickerRecognizer(repository, prepareStickerImages, onChange)
  if (typeof document !== 'undefined') {
    stickerRecognizer.setForeground(!document.hidden)
    document.addEventListener('visibilitychange', () => stickerRecognizer.setForeground(!document.hidden))
  }
  void CapacitorApp.addListener('appStateChange', ({ isActive }) => stickerRecognizer.setForeground(isActive))
  await stickerRecognizer.start()

  const saveTextFile = async (fileName: string, content: string, mime: string): Promise<string> => {
    if (Capacitor.isNativePlatform()) {
      await Filesystem.writeFile({
        path: fileName,
        data: content,
        directory: Directory.Documents,
        encoding: Encoding.UTF8
      })
      return fileName
    }
    const blob = new Blob([content], { type: mime })
    const link = document.createElement('a')
    const url = URL.createObjectURL(blob)
    link.href = url
    link.download = fileName
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return fileName
  }

  const saveBinaryFile = async (fileName: string, bytes: Uint8Array): Promise<string> => {
    if (Capacitor.isNativePlatform()) {
      let raw = ''
      for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192))
      await Filesystem.writeFile({ path: fileName, data: btoa(raw), directory: Directory.Documents })
    } else {
      const blob = new Blob([Uint8Array.from(bytes).buffer], { type: 'application/zip' })
      const url = URL.createObjectURL(blob), link = document.createElement('a')
      link.href = url; link.download = fileName; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    return fileName
  }

  const mediaControllers = new Map<string, { controller: AbortController; conversationId?: string; agentId: string }>()
  const cancelMedia = (conversationId?: string) => {
    for (const entry of mediaControllers.values()) {
      if (!conversationId || entry.conversationId === conversationId) entry.controller.abort()
    }
  }
  const cancelAgentMedia = (agentId: string) => {
    for (const entry of mediaControllers.values()) if (entry.agentId === agentId) entry.controller.abort()
  }
  const generateMedia = async (agentId: string, kind: 'image'|'audio', value: string,
    voice?: string, conversationId?: string, messageId?: string): Promise<MediaAsset> => {
    const normalized=value.trim()
    if (!normalized || normalized.length > (kind === 'image' ? 4000 : 4096)) throw new Error('生成内容为空或过长')
    const controller=new AbortController(), assetId=crypto.randomUUID()
    mediaControllers.set(assetId,{controller,conversationId,agentId})
    const timeout=setTimeout(() => controller.abort(),120000)
    try {
    const agent = await repository.getActor(agentId)
    if (!agent || agent.kind !== 'agent') throw new Error('角色不存在')
    const settings=await repository.mediaSettings()
    const providerId=kind === 'image' ? settings.imageProviderId : settings.speechProviderId
    const modelId=kind === 'image' ? settings.imageModel : settings.speechModel
    const provider=(await repository.listProviders()).find(p => p.id===providerId && p.enabled)
    if (!provider || !modelId.trim()) throw new Error('请先在“我 → 提供商”添加图片或语音提供商，再到“我 → 默认模型”选择模型')
    if (provider.credentialState !== 'stored') throw new Error('请先为多媒体连接保存 API Key')
    if (messageId) {
      const message=await repository.messageById(messageId)
      if (!message || message.deleted || message.conversationId!==conversationId) throw new Error('原消息已删除')
    }
    const common={id:assetId,kind,ownerActorId:agentId,conversationId,messageId,
      providerId,modelId,prompt:normalized,voice:voice || settings.voice}
    try {
      await repository.saveMediaAsset({...common,status:'pending'})
      const result=kind === 'image'
        ? await generateImage(provider,modelId,normalized,controller.signal)
        : await generateSpeech(provider,modelId,normalized,voice || settings.voice,controller.signal)
      if (controller.signal.aborted) throw new Error('生成已取消')
      if (messageId && (await repository.messageById(messageId))?.deleted) throw new Error('原消息已删除')
      return await repository.saveMediaAsset({...common,...result,status:'ready',data:result.dataUrl,
        bytes:Math.floor((result.dataUrl.split(',')[1]?.length ?? 0)*3/4)})
    } catch (error) {
      return await repository.saveMediaAsset({...common,status:'failed',
        error:controller.signal.aborted ? '生成已取消，可手动重试' : mediaReason(error)})
    }
    } finally {
      clearTimeout(timeout); mediaControllers.delete(assetId); onChange()
    }
  }

  const commandGate = new CommandGate()
  const stickerMaintenance = <T>(work: () => Promise<T>) => stickerRecognizer.withPaused(() => runtime.withMaintenance(work))
  const configuredProvider = async (providerId: string): Promise<Provider> => {
    const provider = (await repository.listProviders()).find(item => item.id === providerId && item.enabled)
    if (!provider) throw new Error('连接不存在或已停用')
    if (!await credentialStatus(provider.id)) throw new Error('请先为此连接保存 API Key')
    return provider
  }
  const api: AppApi = {
    runtime,
    backgroundSupported,
    setBackgroundEnabled: async enabled => {
      if (enabled && !backgroundSupported()) throw new Error('当前平台暂不支持后台互动')
      if (backgroundSupported()) {
        if (enabled) await Proactive.start()
        else await Proactive.stop()
      }
      runtime.setBackgroundEnabled(enabled)
      onChange()
    },
    localUser: async () => {
      const actor = await repository.getActor(localUserId)
      if (!actor) throw new Error('本地用户不存在')
      return actor
    },
    actors: () => repository.listActors(),
    providers: () => repository.listProviders(),
    secureVaultStatus: verifySecureVault,
    bindings: () => repository.listBindings(),
    conversations: includeHidden => repository.listConversations(includeHidden),
    whispers: () => repository.listWhispers(),
    conversation: async conversationId => {
      const conversation = await repository.getConversation(conversationId)
      if (!conversation) throw new Error('会话不存在')
      return conversation
    },
    messages: (conversationId, before) => repository.listMessages(conversationId, before),
    message: messageId => repository.messageById(messageId),
    messagesAround: (conversationId, messageId) =>
      repository.messagesAround(conversationId, messageId),
    sendUser: async (conversationId, body, quotedId, mentionIds, commandId = crypto.randomUUID()) => {
      const message = await repository.sendUserMessage(
        conversationId, body, commandId, quotedId, mentionIds)
      await repository.markRead(conversationId, message.sequence)
      if (!message.commandReplayed) runtime.cancelRetryWait(conversationId)
      runtime.wakeConversation(conversationId)
      onChange()
      return message
    },
    saveDraft: (conversationId, body, quotedId) => repository.saveDraft(conversationId, body, quotedId),
    draft: conversationId => repository.getDraft(conversationId),
    markRead: (conversationId, through) => repository.markRead(conversationId, through),
    react: async (messageId, emoji) => {
      const added = await repository.toggleReaction(messageId, localUserId, emoji)
      const message = await repository.messageById(messageId)
      if (message && added) {
        runtime.cancelRetryWait(message.conversationId)
        runtime.wakeConversation(message.conversationId)
      }
      onChange()
    },
    deleteMessage: async messageId => {
      const message = await repository.messageById(messageId)
      if (!message) return
      await runtime.mutateConversation(message.conversationId, () => repository.deleteMessage(messageId))
      onChange()
    },
    editMessage: async (messageId, body) => {
      const message = await repository.messageById(messageId)
      if (!message) throw new Error('消息不存在')
      await runtime.mutateConversation(message.conversationId, () => repository.editMessage(messageId, body))
      onChange()
    },
    recallMessage: async messageId => {
      const message = await repository.messageById(messageId)
      if (!message) throw new Error('消息不存在')
      await runtime.mutateConversation(message.conversationId, () => repository.editMessage(messageId, '', true))
      runtime.wakeConversation(message.conversationId)
      onChange()
    },
    regenerateMessage: async messageId => {
      const id = await repository.regenerateBranch(messageId)
      runtime.wakeConversation(id)
      onChange()
      return id
    },
    saveUserProfile: async (name, bio, avatarData) => {
      await repository.saveUserProfile(name, bio, avatarData)
      onChange()
    },
    saveProvider: async (provider, secret, credentialSourceId) => {
      provider = { ...provider, ...normalizeProviderAddress(provider.baseUrl, provider.protocol) }
      const origin = modelOrigin(provider.baseUrl)
      const previous = (await repository.listProviders()).find(item => item.id === provider.id)
      const originChanged = Boolean(previous && modelOrigin(previous.baseUrl) !== origin)
      if (originChanged && !credentialSourceId) {
        await removeCredential(provider.id)
      }
      if (credentialSourceId) {
        await copyCredential(credentialSourceId, provider.id, origin)
      } else if (secret?.trim()) {
        await storeCredential(provider.id,
          secret.trim() === '__prompt__' ? '' : secret.trim(), origin)
      }
      const stored = await credentialStatus(provider.id)
      const saved = await repository.saveProvider({ ...provider, credentialState: stored ? 'stored' : 'missing' })
      onChange()
      return saved
    },
    deleteProvider: async providerId => {
      await removeCredential(providerId)
      await repository.deleteProvider(providerId)
      onChange()
    },
    saveBinding: async binding => {
      await repository.saveBinding(binding)
      onChange()
    },
    clearAgentBinding: async (agentId, purpose) => {
      await repository.clearAgentBinding(agentId, purpose)
      onChange()
    },
    listProviderModels: async (providerId, signal) => fetchProviderModels(await configuredProvider(providerId), signal),
    testProviderConnection: async (providerId, signal) => probeProviderConnection(await configuredProvider(providerId), signal),
    providerModelSelections: () => repository.providerModelSelections(),
    saveProviderModelSelection: async (providerId, modelIds) => {
      await repository.saveProviderModelSelection(providerId, modelIds)
      onChange()
    },
    providerChannelKinds: () => repository.providerChannelKinds(),
    saveProviderChannelKind: async (providerId, kind) => {
      await repository.saveProviderChannelKind(providerId, kind)
      onChange()
    },
    testProvider: async (providerId, modelId, signal) => testTextConnection(await configuredProvider(providerId), modelId.trim(), signal),
    testMediaProvider: async (providerId, modelId, kind, voice, signal) => testMediaConnection(await configuredProvider(providerId), modelId.trim(), kind, voice, signal),
    saveAgent: async (agent, settings) => {
      const current = agent.id ? await repository.getActor(agent.id) : null
      const affectsRuntime = current && ((['name', 'bio', 'persona', 'speakingStyle', 'enabled', 'archived', 'allowPrivate', 'allowGroup'] as const)
        .some(key => agent[key] !== undefined && agent[key] !== current[key])
        || settings?.privateMemo !== undefined || settings?.modelBindings !== undefined)
      const save = () => repository.saveAgentDetails(agent, settings)
      const saved = affectsRuntime ? await runtime.mutateAgent(current.id, save) : await save()
      if (current && saved.profileVersion !== current.profileVersion) cancelAgentMedia(saved.id)
      onChange()
      return saved
    },
    setAgentStatus: async (agentId, status) => {
      const saved = await runtime.mutateAgent(agentId, () => repository.setAgentStatus(agentId, status))
      if (status !== 'active') cancelAgentMedia(agentId)
      onChange()
      return saved
    },
    copyAgent: async agentId => {
      const copied = await repository.copyAgent(agentId)
      onChange()
      return copied
    },
    deleteAgent: async agentId => {
      await runtime.mutateAgent(agentId, () => repository.deleteAgent(agentId))
      cancelAgentMedia(agentId)
      onChange()
    },
    openDirect: async agentId => {
      const conversation = await repository.openDirect(agentId)
      onChange()
      return conversation
    },
    createGroup: async (title, members, topic) => {
      const conversation = await repository.createGroup(title, members, topic)
      onChange()
      return conversation
    },
    updateMembers: async (conversationId, addIds, removeIds) => {
      const current = await repository.getConversation(conversationId)
      const changed = current && (addIds.some(id => !current.members.includes(id)) || removeIds.some(id => id !== localUserId && current.members.includes(id)))
      if (changed) await runtime.mutateConversation(conversationId, () => repository.updateMembers(conversationId, addIds, removeIds))
      else await repository.updateMembers(conversationId, addIds, removeIds)
      onChange()
    },
    updateConversation: async (conversationId, patch) => {
      const current = await repository.getConversation(conversationId)
      const changed = current && ((patch.title !== undefined && patch.title.trim() !== current.title)
        || (patch.topic !== undefined && patch.topic.trim() !== current.topic)
        || (patch.announcement !== undefined && patch.announcement.trim() !== (current.announcement ?? '')))
      if (changed) await runtime.mutateConversation(conversationId, () => repository.updateConversation(conversationId, patch))
      else await repository.updateConversation(conversationId, patch)
      if (patch.autonomyPaused === false) runtime.wakeConversation(conversationId)
      onChange()
    },
    clearConversation: async conversationId => {
      cancelMedia(conversationId)
      await runtime.mutateConversation(conversationId, () => repository.clearConversation(conversationId))
      runtime.cancelRetryWait(conversationId)
      onChange()
    },
    deleteConversation: async conversationId => {
      cancelMedia(conversationId)
      await runtime.mutateConversation(conversationId, () => repository.deleteConversation(conversationId))
      runtime.cancelRetryWait(conversationId)
      onChange()
    },
    memories: (agentId, conversationId) => repository.listMemories(agentId, conversationId),
    summaryTimeline: (conversationId,agentId,beforeThrough) => repository.summaryTimeline(conversationId,agentId,beforeThrough),
    conversationMemorySources: (conversationId,agentId) => repository.conversationMemorySources(conversationId,agentId),
    setConversationMemorySources: async (conversationId,agentId,sourceIds) => {
      await repository.setConversationMemorySources(conversationId,agentId,sourceIds)
      onChange()
    },
    saveMemory: async memory => {
      const saved = await repository.saveMemory(memory)
      onChange()
      return saved
    },
    deleteMemory: async memoryId => {
      await repository.deleteMemory(memoryId, true)
      onChange()
    },
    moveMemoryScope: async (memoryId, conversationId) => {
      await repository.moveMemoryScope(memoryId, conversationId)
      onChange()
    },
    conversationNotes: conversationId => repository.listConversationNotes(conversationId),
    saveConversationNote: async input => {
      const saved = await repository.saveConversationNote(input)
      onChange()
      return saved
    },
    deleteConversationNote: async noteId => {
      await repository.deleteConversationNote(noteId)
      onChange()
    },
    proactiveRules: conversationId => repository.listProactiveRules(conversationId),
    saveProactiveRule: async input => {
      const saved = await repository.saveProactiveRule(input)
      onChange()
      return saved
    },
    deleteProactiveRule: async ruleId => {
      await repository.deleteProactiveRule(ruleId)
      onChange()
    },
    lorebooks: () => repository.listLorebooks(),
    saveLorebook: async input => {
      const saved = await repository.saveLorebook(input)
      onChange()
      return saved
    },
    deleteLorebook: async lorebookId => {
      await repository.deleteLorebook(lorebookId)
      onChange()
    },
    lorebookEntries: lorebookId => repository.listLorebookEntries(lorebookId),
    saveLorebookEntry: async input => {
      const saved = await repository.saveLorebookEntry(input)
      onChange()
      return saved
    },
    deleteLorebookEntry: async entryId => {
      await repository.deleteLorebookEntry(entryId)
      onChange()
    },
    conversationLorebooks: conversationId => repository.conversationLorebooks(conversationId),
    setConversationLorebooks: async (conversationId, lorebookIds) => {
      await repository.setConversationLorebooks(conversationId, lorebookIds)
      onChange()
    },
    actorLorebooks: actorId => repository.actorLorebooks(actorId),
    setActorLorebooks: async (actorId, lorebookIds) => {
      await repository.setActorLorebooks(actorId, lorebookIds)
      onChange()
    },
    mediaAssets: filter => repository.mediaAssets(filter),
    mediaData: assetId => repository.mediaData(assetId),
    deleteMediaAsset: async assetId => {
      await repository.deleteMediaAsset(assetId)
      onChange()
    },
    generateAgentImage: (agentId,prompt,conversationId) => generateMedia(agentId,'image',prompt,undefined,conversationId),
    generateAgentVoice: (agentId,text,voice,conversationId,messageId) => generateMedia(agentId,'audio',text,voice,conversationId,messageId),
    mediaSettings: () => repository.mediaSettings(),
    saveMediaSettings: async settings => { await repository.saveMediaSettings(settings); onChange() },
    cancelMedia,
    sendMedia: async (conversationId,assetId,commandId) => {
      const asset=await repository.mediaAsset(assetId)
      if (!asset || asset.status!=='ready') throw new Error('媒体尚未生成完成')
      const message=await repository.sendUserMessage(conversationId,
        asset.kind==='image' ? '【图片】'+asset.prompt : '【语音】'+asset.prompt,commandId,null,[],asset.id)
      await repository.markRead(conversationId,message.sequence)
      runtime.wakeConversation(conversationId); onChange()
    },
    sendSticker: async (conversationId,stickerId,commandId) => {
      const message=await repository.sendSticker(conversationId,stickerId,commandId)
      await repository.markRead(conversationId,message.sequence)
      runtime.wakeConversation(conversationId); onChange()
    },
    stickers: () => repository.listStickers(),
    saveSticker: async (name, dataUrl) => {
      const saved = await repository.saveSticker(name, dataUrl)
      onChange()
      stickerRecognizer.kick()
      return saved
    },
    deleteSticker: async stickerId => {
      await repository.deleteSticker(stickerId)
      onChange()
    },
    stickerRecognitionSettings: () => repository.stickerRecognitionSettings(),
    saveStickerRecognitionSettings: async (settings, consentGranted = false) => {
      const saved = await repository.saveStickerRecognitionSettings(settings, consentGranted)
      onChange()
      return saved
    },
    retryStickerRecognition: stickerId => stickerRecognizer.retry(stickerId),
    importCharacterCard: async (_fileName, content, png) => {
      const card=parseCharacterCard(content,png)
      const actor=await repository.importCharacter(card)
      onChange()
      return { actor,unsupported:card.warnings }
    },
    characterSource: actorId => repository.characterSource(actorId),
    exportOriginalCard: async actorId => {
      const source=await repository.characterSource(actorId)
      if (!source) throw new Error('该角色没有原始酒馆卡')
      if (source.png) {
        const name=`character-${actorId}.original.png`
        if (Capacitor.isNativePlatform()) {
          await Filesystem.writeFile({path:name,data:source.png.split(',')[1],directory:Directory.Documents})
        } else {
          const link=document.createElement('a'); link.href=source.png; link.download=name; link.click()
        }
        return name
      }
      return saveTextFile(`character-${actorId}.original.json`,source.json,'application/json')
    },
    greetings: actorId => repository.greetings(actorId),
    startGreeting: async (conversationId,body) => { await repository.startGreeting(conversationId,body); onChange() },
    importWorldBook: async content => {
      if (content.length>16000000) throw new Error('世界书超过 16 MB')
      let parsed: unknown
      try { parsed=JSON.parse(content) } catch { throw new Error('世界书不是有效 JSON') }
      const saved=await repository.importWorldBook(parseWorldBook(parsed))
      onChange(); return saved
    },
    exportWorldBook: async bookId => {
      const book=(await repository.listLorebooks()).find(b => b.id===bookId)
      if (!book) throw new Error('世界书不存在')
      const entries=await repository.listLorebookEntries(bookId)
      return saveTextFile(`worldbook-${book.id}.json`,JSON.stringify({name:book.title,description:book.description,
        entries:entries.map(e => ({...(e.sourceJson ? JSON.parse(e.sourceJson):{}),
          name:e.title,content:e.content,keys:e.keywords,secondary_keys:e.secondaryKeywords,
          constant:e.constant,enabled:e.enabled,selective:e.selective,case_sensitive:e.caseSensitive,insertion_order:e.ordinal}))},null,2),'application/json')
    },
    searchMessages: (query, options) => repository.searchMessages(query, options),
    exportBackupZip: async (password, modules) => {
      const snapshot = await repository.exportBackup()
      return saveBinaryFile(`yomi-modules-${Date.now()}.zip`, await createBackupZip(snapshot, password, modules))
    },
    previewBackupZip: async (bytes, password) => (await readBackupZip(bytes, password)).preview,
    restoreBackupZip: async (bytes, password, modules, overwrite) => {
      const archive = await readBackupZip(bytes, password)
      if (modules.some(id => !archive.preview.modules.includes(id))) throw new Error('所选模块不在此备份中')
      cancelMedia()
      await commandGate.exclusive(() => stickerMaintenance(async () => {
        const before = await repository.listProviders()
        await store.restore(archive.snapshot, modules, overwrite)
        const after = await repository.listProviders()
        for (const old of before) {
          const changed = after.find(item => item.id === old.id)
          if (changed && changed.baseUrl !== old.baseUrl) await removeCredential(old.id)
        }
        await syncCredentialStates()
        onChange()
      }))
    },
    exportBackup: async password => {
      const data = await repository.exportBackup()
      const content = await encryptBackup(data, password)
      const fileName = `yomi-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.yomi`
      return saveTextFile(fileName, content, 'application/json')
    },
    importBackup: async (fileName, content, password) => {
      const raw = content ?? (await Filesystem.readFile({
        path: fileName,
        directory: Directory.Documents,
        encoding: Encoding.UTF8
      })).data
      if (typeof raw !== 'string') throw new Error('无法读取备份文件')
      const parsed = await decryptBackup(raw, password)
      cancelMedia()
      await commandGate.exclusive(() => stickerMaintenance(async () => {
        const oldProviders = await repository.listProviders()
        await store.restore(parsed)
        for (const providerId of new Set([...oldProviders, ...await repository.listProviders()].map(item => item.id))) {
          await removeCredential(providerId)
        }
        onChange()
      }))
    },
    dataRecovery: () => store.info(),
    rollbackData: () => { cancelMedia(); return commandGate.exclusive(() => stickerMaintenance(async () => {
      await store.rollback()
      await repository.interruptStaleRuns()
      await syncCredentialStates()
      onChange()
    })) },
    discardRecovery: () => commandGate.exclusive(async () => {
      await store.discardPrevious()
      onChange()
    }),
    exportConversation: async (conversationId, format) => {
      const conversation = await repository.getConversation(conversationId)
      if (!conversation) throw new Error('会话不存在')
      const messages = await repository.allMessages(conversationId)
      const safeTitle = conversation.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
      if (format === 'markdown') {
        const markdown = `# ${conversation.title}\n\n${messages.map(item =>
          `## ${item.authorName}\n\n${item.deleted ? '*消息已删除*' : item.body}\n`).join('\n')}`
        return saveTextFile(`${safeTitle}.md`, markdown, 'text/markdown')
      }
      return saveTextFile(`${safeTitle}.json`, JSON.stringify({
        format: 'yomi-conversation',
        version: 1,
        conversation,
        messages
      }, null, 2), 'application/json')
    },
    exportAgent: async agentId => {
      const agent = await repository.getActor(agentId)
      if (!agent || agent.kind !== 'agent') throw new Error('角色不存在')
      const safeName = agent.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
      return saveTextFile(`${safeName}.yomi-character.json`, JSON.stringify({
        format: 'yomi-character',
        version: 1,
        originalCard: await repository.characterSource(agentId),
        profile: {
          name: agent.name,
          bio: agent.bio,
          persona: agent.persona,
          speakingStyle: agent.speakingStyle,
          color: agent.color,
          avatarData: agent.avatarData
        }
      }, null, 2), 'application/json')
    },
    importAgent: async (fileName, content) => {
      const raw = content ?? (await Filesystem.readFile({
        path: fileName,
        directory: Directory.Documents,
        encoding: Encoding.UTF8
      })).data
      if (typeof raw !== 'string') throw new Error('无法读取角色文件')
      let parsed: Record<string, unknown>
      try { parsed = JSON.parse(raw) as Record<string, unknown> } catch { throw new Error('角色文件不是有效 JSON') }
      if (parsed.format !== 'yomi-character' || parsed.version !== 1 ||
          !parsed.profile || typeof parsed.profile !== 'object') {
        throw new Error('不支持的角色文件格式')
      }
      const profile = parsed.profile as Record<string, unknown>
      if (typeof profile.name !== 'string' || !profile.name.trim()) throw new Error('角色名称无效')
      const source = parsed.originalCard as {json?:string;png?:string} | undefined
      const actorInput = {
        name: profile.name.slice(0, 100),
        bio: typeof profile.bio === 'string' ? profile.bio.slice(0, 16_384) : '',
        persona: typeof profile.persona === 'string' ? profile.persona : '',
        speakingStyle: typeof profile.speakingStyle === 'string' ? profile.speakingStyle : '',
        color: typeof profile.color === 'string' ? profile.color.slice(0, 32) : '#7c3aed',
        avatarData: typeof profile.avatarData === 'string' ? profile.avatarData.slice(0, 16_000_000) : ''
      }
      const saved = source?.json
        ? await repository.importCharacter({...parseCharacterCard(source.json,source.png),profile:actorInput})
        : await repository.saveAgent(actorInput)
      onChange()
      return saved
    },
    usage: () => repository.listModelCalls(),
    usageSummary: () => repository.usageSummary(),
    storageStats: () => repository.storageStats(),
    clearFinishedLogs: async () => { await repository.clearFinishedLogs(); onChange() },
    compactStorage: () => commandGate.exclusive(() => runtime.withMaintenance(async () => {
      await database.compact()
      onChange()
    })),
    exportDiagnostics: async () => saveTextFile(`yomi-diagnostics-${Date.now()}.json`,
      JSON.stringify(await repository.diagnostics(), null, 2), 'application/json'),
    runtimeIssues: () => repository.listRuntimeIssues(),
    stop: conversationId => { cancelMedia(conversationId); runtime.stopConversation(conversationId) },
    stopAll: () => { cancelMedia(); runtime.stopAll() },
    resume: conversationId => runtime.resumeConversation(conversationId),
    retry: conversationId => runtime.retryConversation(conversationId),
    ignoreRecovery: conversationId => runtime.ignoreRecovery(conversationId),
    clearAll: async () => {
      if (backgroundSupported()) await Proactive.stop()
      runtime.setBackgroundEnabled(false)
      cancelMedia()
      await commandGate.exclusive(() => stickerMaintenance(async () => {
        const providers = await repository.listProviders()
        await store.discardPrevious()
        await repository.clearAll()
        for (const provider of providers) await removeCredential(provider.id)
        onChange()
      }))
    },
    refresh: async () => {
      await repository.ensureLocalUser()
      await syncCredentialStates()
      onChange()
    }
  }
  const commands = new Set<PropertyKey>(['sendUser', 'saveDraft', 'markRead', 'react', 'deleteMessage', 'editMessage', 'recallMessage', 'regenerateMessage',
    'saveUserProfile', 'saveProvider', 'deleteProvider', 'saveProviderModelSelection', 'saveProviderChannelKind', 'saveBinding', 'clearAgentBinding', 'testProvider', 'testMediaProvider',
    'saveAgent', 'setAgentStatus', 'copyAgent', 'deleteAgent', 'openDirect', 'createGroup', 'updateMembers', 'updateConversation',
    'clearConversation', 'deleteConversation', 'saveMemory', 'deleteMemory', 'moveMemoryScope',
    'saveConversationNote', 'deleteConversationNote', 'saveProactiveRule', 'deleteProactiveRule', 'setConversationMemorySources',
    'saveLorebook','deleteLorebook','saveLorebookEntry','deleteLorebookEntry','setConversationLorebooks','setActorLorebooks',
    'generateAgentImage','generateAgentVoice','saveMediaSettings','deleteMediaAsset','sendMedia','sendSticker',
    'saveSticker','deleteSticker','saveStickerRecognitionSettings','retryStickerRecognition','importCharacterCard','exportOriginalCard','importWorldBook','exportWorldBook','startGreeting',
    'generateAgentImage', 'generateAgentVoice', 'saveLorebook', 'deleteLorebook', 'saveLorebookEntry',
    'deleteLorebookEntry', 'setConversationLorebooks', 'saveSticker', 'deleteSticker', 'deleteMediaAsset',
    'saveMediaSettings', 'sendSticker', 'sendImage', 'importWorldBook', 'importCharacterCard', 'startGreeting',
    'exportBackupZip', 'previewBackupZip', 'exportBackup', 'exportConversation', 'exportAgent', 'importAgent', 'refresh', 'clearFinishedLogs', 'exportDiagnostics'])
  const recognitionChanges = new Set<PropertyKey>(['saveStickerRecognitionSettings', 'saveProvider', 'deleteProvider', 'saveProviderChannelKind', 'deleteSticker'])
  return new Proxy(api, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver)
    if (!commands.has(property) || typeof value !== 'function') return value
    return (...args: unknown[]) => commandGate.run(async () => recognitionChanges.has(property)
      ? stickerRecognizer.withPaused(async () => Reflect.apply(value, target, args)) : Reflect.apply(value, target, args))
  } })
}
