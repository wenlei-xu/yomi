import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { encryptBackup, decryptBackup } from './backupCrypto'

export const backupModules = {
  roles: { label: '角色资料', keys: ['actors', 'characterCards'], requires: [] },
  chats: { label: '会话与聊天', keys: ['conversations', 'conversationMembers', 'userReads', 'messages', 'messageMentions', 'reactions', 'composerDrafts'], requires: ['roles', 'media'] },
  memories: { label: '记忆、摘要与会话关联', keys: ['memories', 'memorySources', 'summaries', 'conversationNotes', 'conversationMemoryLinks'], requires: ['chats'] },
  settings: { label: '模型与主动发言设置', keys: ['providers', 'modelBindings', 'agentModelBindings', 'appSettings', 'proactiveRules'], requires: ['chats'] },
  worldbooks: { label: '世界书', keys: ['lorebooks', 'lorebookEntries', 'lorebookLinks', 'lorebookActorLinks'], requires: ['chats'] },
  media: { label: '图片、语音与表情', keys: ['mediaAssets', 'mediaBlobs', 'stickers'], requires: ['chats'] }
} as const
export type BackupModule = keyof typeof backupModules
export const moduleIds = Object.keys(backupModules) as BackupModule[]
type DataRow = Record<string, unknown>
export type Snapshot = Record<string, unknown>
export interface BackupPreview { modules: BackupModule[]; counts: Partial<Record<BackupModule, number>>; exportedAt: number }
const maxArchiveBytes = 150_000_000
const compositeKeys: Record<string, string[]> = {
  conversationMemoryLinks: ['agent_id', 'source_conversation_id', 'target_conversation_id'],
  characterCards: ['actor_id'], lorebookActorLinks: ['actor_id', 'lorebook_id'],
  conversationMembers: ['conversation_id', 'actor_id'], userReads: ['conversation_id'],
  messageMentions: ['message_id', 'target_actor_id'], reactions: ['message_id', 'actor_id', 'emoji'],
  memorySources: ['memory_id', 'message_id'], composerDrafts: ['conversation_id'],
  lorebookLinks: ['conversation_id', 'lorebook_id'], appSettings: ['key'],
  modelBindings: ['purpose'], agentModelBindings: ['agent_id', 'purpose']
}

const references: Record<string, Record<string, string>> = {
  conversationMemoryLinks: { agent_id: 'actors', source_conversation_id: 'conversations', target_conversation_id: 'conversations' },
  characterCards: { actor_id: 'actors' },
  conversations: { origin_conversation_id: 'conversations' },
  conversationMembers: { conversation_id: 'conversations', actor_id: 'actors' },
  messages: { conversation_id: 'conversations', media_id: 'mediaAssets' },
  messageMentions: { message_id: 'messages', target_actor_id: 'actors' },
  reactions: { message_id: 'messages' }, userReads: { conversation_id: 'conversations' },
  composerDrafts: { conversation_id: 'conversations' },
  memories: { agent_id: 'actors', conversation_id: 'conversations' },
  memorySources: { memory_id: 'memories', message_id: 'messages' },
  summaries: { agent_id: 'actors', conversation_id: 'conversations' },
  conversationNotes: { conversation_id: 'conversations', author_id: 'actors', target_actor_id: 'actors' },
  modelBindings: { provider_id: 'providers' }, agentModelBindings: { agent_id: 'actors', provider_id: 'providers' },
  proactiveRules: { conversation_id: 'conversations', actor_id: 'actors' },
  lorebooks: { conversation_id: 'conversations' }, lorebookEntries: { lorebook_id: 'lorebooks' },
  lorebookLinks: { conversation_id: 'conversations', lorebook_id: 'lorebooks' },
  lorebookActorLinks: { actor_id: 'actors', lorebook_id: 'lorebooks' },
  mediaAssets: { owner_actor_id: 'actors', conversation_id: 'conversations', message_id: 'messages' },
  mediaBlobs: { id: 'mediaAssets' }
}

/** Follow foreign keys instead of importing all unrelated chats as dependencies. */
function dependencySubset(snapshot: Snapshot, selected: BackupModule[]): Snapshot {
  const required = new Map<string, Set<unknown>>()
  const chosen = new Set<string>(selected.flatMap(id => [...backupModules[id].keys]))
  const kept: Snapshot = {}
  const included = new Set<object>()
  const add = (key: string, row: DataRow) => {
    if (included.has(row)) return false
    included.add(row)
    const records = (kept[key] ?? []) as DataRow[]
    records.push(row); kept[key] = records
    for (const [field, target] of Object.entries(references[key] ?? {})) {
      if (row[field] === null || row[field] === undefined) continue
      const ids = required.get(target) ?? new Set()
      ids.add(row[field]); required.set(target, ids)
    }
    return true
  }
  for (const key of chosen) for (const row of (snapshot[key] ?? []) as DataRow[]) add(key, row)
  let changed = true
  while (changed) {
    changed = false
    for (const id of moduleIds) for (const key of backupModules[id].keys) {
      for (const row of (snapshot[key] ?? []) as DataRow[]) {
        const needed = required.get(key)?.has(row.id)
          || (key === 'actors' && row.id === 'local-user')
          || (key === 'conversationMembers' && required.get('conversations')?.has(row.conversation_id))
          || (key === 'mediaBlobs' && required.get('mediaAssets')?.has(row.id))
          || (key === 'characterCards' && required.get('actors')?.has(row.actor_id))
        if (needed && add(key, row)) changed = true
      }
    }
  }
  return kept
}

export function withDependencies(selected: readonly BackupModule[]): BackupModule[] {
  if (!selected.length || selected.some(id => !moduleIds.includes(id))) throw new Error('请选择有效的备份模块')
  const result = new Set<BackupModule>()
  const add = (id: BackupModule) => {
    if (result.has(id)) return
    result.add(id)
    for (const dependency of backupModules[id].requires) add(dependency)
  }
  selected.forEach(add)
  return moduleIds.filter(id => result.has(id))
}

export async function createBackupZip(snapshot: Snapshot, password: string, selected: BackupModule[]): Promise<Uint8Array> {
  const modules = withDependencies(selected)
  const files: Record<string, Uint8Array> = {}
  const subset = dependencySubset(snapshot, selected)
  for (const id of modules) {
    const data = Object.fromEntries(backupModules[id].keys.map(key => [key, selected.includes(id) ? snapshot[key] ?? [] : subset[key] ?? []]))
    files[`data/${id}.yomi`] = strToU8(await encryptBackup({ format: 'yomi-module', version: 1, module: id, data }, password))
  }
  files['manifest.json'] = strToU8(JSON.stringify({ format: 'yomi-modular-backup', version: 1,
    exportedAt: Date.now(), modules }))
  if (Object.values(files).reduce((total, bytes) => total + bytes.length, 0) > maxArchiveBytes) throw new Error('备份展开后超过 150 MB，请减少所选模块')
  const zipped = zipSync(files, { level: 1 })
  if (zipped.length > maxArchiveBytes) throw new Error('备份超过 150 MB，请减少所选模块')
  return zipped
}

export async function readBackupZip(bytes: Uint8Array, password: string): Promise<{ preview: BackupPreview; snapshot: Snapshot }> {
  if (bytes.length > maxArchiveBytes) throw new Error('备份文件超过 150 MB')
  let total = 0
  const names = new Set<string>()
  const files = unzipSync(bytes, { filter: entry => {
    if (names.has(entry.name) || !/^(manifest\.json|data\/(roles|chats|memories|settings|worldbooks|media)\.yomi)$/.test(entry.name)) {
      throw new Error('备份 ZIP 包含重复或未知文件')
    }
    names.add(entry.name)
    total += entry.originalSize
    if (total > maxArchiveBytes) throw new Error('解压后备份超过 150 MB')
    return true
  } })
  if (!files['manifest.json']) throw new Error('备份缺少清单')
  const manifest = JSON.parse(strFromU8(files['manifest.json']))
  if (manifest.format !== 'yomi-modular-backup' || manifest.version !== 1 ||
      !Array.isArray(manifest.modules) || !manifest.modules.length ||
      manifest.modules.some((id: unknown) => !moduleIds.includes(id as BackupModule)) ||
      new Set(manifest.modules).size !== manifest.modules.length) throw new Error('不支持的模块备份格式')
  const modules = manifest.modules as BackupModule[]
  if (withDependencies(modules).some(id => !modules.includes(id))) throw new Error('备份缺少依赖模块')
  const snapshot: Snapshot = { format: 'yomi-backup', version: 3 }
  const counts: BackupPreview['counts'] = {}
  for (const id of modules) {
    const file = files[`data/${id}.yomi`]
    if (!file) throw new Error(`备份缺少${backupModules[id].label}`)
    const payload = await decryptBackup(strFromU8(file), password) as Snapshot
    if (payload.format !== 'yomi-module' || payload.version !== 1 || payload.module !== id ||
        !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) throw new Error('模块内容无效')
    const data = payload.data as Snapshot
    counts[id] = 0
    for (const key of backupModules[id].keys) {
      if (key === 'conversationMemoryLinks' && data[key] === undefined) data[key] = []
      if (!Array.isArray(data[key]) || !(data[key] as unknown[]).every(row => row && typeof row === 'object' && !Array.isArray(row))) {
        throw new Error(`备份字段 ${key} 无效`)
      }
      snapshot[key] = data[key]
      counts[id]! += (data[key] as unknown[]).length
    }
  }
  return { preview: { modules, counts, exportedAt: Number(manifest.exportedAt) || 0 }, snapshot }
}

/** Dependencies only fill missing records. Existing unselected content always wins. */
export function mergeBackupModules(base: Snapshot, incoming: Snapshot, selected: BackupModule[], overwrite = false): Snapshot {
  const dependencies = withDependencies(selected)
  const chosen = new Set(selected.flatMap(id => [...backupModules[id].keys]))
  const subset = dependencySubset(incoming, selected)
  const result: Snapshot = { ...base, format: 'yomi-backup', version: 3 }
  for (const id of dependencies) for (const key of backupModules[id].keys) {
    if (!Array.isArray(incoming[key]) && !(key === 'conversationMemoryLinks' && incoming[key] === undefined)) throw new Error(`备份缺少依赖数据 ${key}`)
    const fields = compositeKeys[key] ?? ['id']
    const identity = (row: DataRow) => {
      if (fields.some(field => row[field] === undefined || row[field] === null)) throw new Error(`备份字段 ${key} 缺少标识`)
      return JSON.stringify(fields.map(field => row[field]))
    }
    const records = new Map(((base[key] ?? []) as DataRow[]).map(row => [identity(row), row]))
    for (const raw of (subset[key] ?? []) as DataRow[]) {
      const row = { ...raw }
      const rowId = identity(row)
      if (key === 'actors' && row.id === 'local-user') continue
      if (!records.has(rowId) || (overwrite && chosen.has(key))) {
        if (key === 'proactiveRules') row.enabled = 0
        records.set(rowId, row)
      }
    }
    result[key] = [...records.values()]
  }
  // Imported historical snapshots must not rewind the local message sequence.
  const maxima = new Map<string, number>()
  for (const message of (result.messages ?? []) as DataRow[]) maxima.set(String(message.conversation_id),
    Math.max(maxima.get(String(message.conversation_id)) ?? 0, Number(message.sequence)))
  result.conversations = ((result.conversations ?? []) as DataRow[]).map(room => ({ ...room,
    next_sequence: Math.max(Number(room.next_sequence), (maxima.get(String(room.id)) ?? 0) + 1),
    content_revision: Number(room.content_revision ?? 1) + 1 }))
  // Keep browsable history; merged message/config revisions need fresh active summaries.
  result.summaries = ((result.summaries ?? []) as DataRow[]).map(row => ({ ...row, valid: 0 }))
  return result
}
