import type { SQLiteDBConnection } from '@capacitor-community/sqlite'
import type {
  Actor,
  Conversation,
  ConversationKind,
  Lorebook,
  LorebookEntry,
  MediaAsset,
  Memory,
  Message,
  ModelBinding,
  ModelCallRecord,
  Provider,
  ConversationNote,
  ConversationNoteScope,
  SummarySpan,
  SummaryEntry,
  ConversationMemorySource,
  LinkedContextSource,
  ProactiveRule,
  ProactiveMode,
  RuntimeIssue,
  SearchHit,
  Sticker,
  StorageStats,
  UsageSummary,
  RetryJob,
  RoutingPlan
} from '../domain/types'
import { Database, type Row } from './database'
import { parseCharacterCard, replaceCardMacros, type ImportedCharacter, type ImportedBook } from './characterCard'
import { worldContext } from './worldContext'
import { estimateTokens } from '../agent/limits'
import { defaultMediaSettings, type MediaSettings } from '../domain/types'

const localUserId = 'local-user'
const maxMessageLength = 32 * 1024
const maxMediaBytes = 8 * 1024 * 1024
const maxStickerBytes = 1_500_000
const previousRuns = `WITH RECURSIVE previous(id) AS (
  SELECT parent_run_id FROM run_retries WHERE run_id=?
  UNION SELECT p.parent_run_id FROM run_retries p JOIN previous old ON p.run_id=old.id
)`

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}

function replay<T>(result: T): T {
  if (!result || typeof result !== 'object') return result
  const copied = { ...result } as Record<string, unknown>
  delete copied.posted
  delete copied.sidePosted
  if (typeof copied.content === 'string' && !copied.content.startsWith('先前已完成：')) copied.content = `先前已完成：${copied.content}`
  return copied as T
}

function id(): string { return crypto.randomUUID() }

/** Next local midnight-anchored occurrence of `minutesOfDay`. */
function nextDailyDue(minutesOfDay: number): number {
  const target = Math.min(Math.max(Math.floor(minutesOfDay), 0), 1439)
  const nowDate = new Date()
  const due = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(),
    Math.floor(target / 60), target % 60, 0, 0)
  if (due.getTime() <= nowDate.getTime()) due.setDate(due.getDate() + 1)
  return due.getTime()
}
function text(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback }
function num(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0 }
function nullableNum(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null }
function bool(value: unknown): boolean { return value === 1 || value === true }
function now(): number { return Date.now() }
async function rows(db: SQLiteDBConnection, sql: string, values: unknown[] = []): Promise<Row[]> {
  return ((await db.query(sql, values)).values ?? []) as Row[]
}

export class Repository {
  constructor(private readonly db: Database) {}

  async agentTool<T>(lease: { agentId: string; conversationId: string; epoch: number;
    profileVersion: number; runId: string; linkedSources?: LinkedContextSource[] }, call: { id: string; name: string; arguments: Record<string, unknown> },
    work: (repository: Repository) => Promise<T>): Promise<T> {
    return this.db.write(async db => {
      const authorized = (await rows(db, `SELECT 1 FROM actors a
        JOIN conversation_members m ON m.actor_id=a.id AND m.left_sequence IS NULL
        JOIN conversations c ON c.id=m.conversation_id
        JOIN runs r ON r.id=? AND r.agent_id=a.id AND r.conversation_id=c.id
        JOIN activities act ON act.id=r.activity_id AND act.status='active'
        WHERE a.id=? AND a.enabled=1 AND a.archived=0 AND a.profile_version=?
        AND c.id=? AND c.cancel_epoch=? AND c.paused=0 AND (c.autonomy_paused=0 OR r.human_triggered=1)
        AND r.status='running' AND act.started_at>?`,
      [lease.runId, lease.agentId, lease.profileVersion, lease.conversationId, lease.epoch, now() - 180_000])).length
      if (!authorized) throw new Error('CANCELLED：执行身份或会话已失效')
      for (const source of lease.linkedSources ?? []) {
        const visible = (await rows(db, `SELECT 1 FROM conversation_memory_links l
          JOIN conversations c ON c.id=l.source_conversation_id
          JOIN conversation_members m ON m.conversation_id=c.id AND m.actor_id=l.agent_id
          WHERE l.agent_id=? AND l.target_conversation_id=? AND c.id=?
          AND c.content_revision=? AND c.membership_version=? AND m.joined_sequence=? AND m.left_sequence IS NULL`,
        [lease.agentId,lease.conversationId,source.conversationId,source.contentRevision,source.membershipVersion,source.joinedSequence])).length
        if (!visible) throw new Error('CANCELLED：关联会话的内容或可见范围已变更，请重试')
        for (const memory of source.memoryVersions ?? []) {
          if (!(await rows(db, `SELECT 1 FROM memories WHERE id=? AND agent_id=? AND conversation_id=? AND version=? AND valid=1`,
            [memory.id,lease.agentId,source.conversationId,memory.version])).length) {
            throw new Error('CANCELLED：关联记忆已修改或删除，请重试')
          }
        }
      }
      const actionId = `tool:${lease.runId}:${call.id}`
      const payload = JSON.stringify({ name: call.name, arguments: canonical(call.arguments) })
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
        new TextEncoder().encode(payload)))).map(b => b.toString(16).padStart(2, '0')).join('')
      const previous = (await rows(db, 'SELECT result_json FROM tool_actions WHERE action_id=?', [actionId]))[0]
      if (previous) {
        const saved = JSON.parse(text(previous.result_json)) as { hash: string; result: T }
        if (saved.hash !== hash) throw new Error('同一工具调用 ID 的参数发生冲突')
        return replay(saved.result)
      }
      if (!['conversation_read', 'conversation_search', 'conversation_members', 'sticker_list', 'memory_read', 'turn_finish'].includes(call.name)) {
        const prior = (await rows(db, `${previousRuns} SELECT result_json FROM tool_actions
          WHERE run_id IN (SELECT id FROM previous) AND tool_name=? AND status='completed'
            AND result_json LIKE ? ORDER BY created_at DESC,rowid DESC LIMIT 1`,
        [lease.runId, call.name, `{"hash":"${hash}",%`]))[0]
        if (prior) {
          const saved = (JSON.parse(text(prior.result_json)) as { result: T }).result
          const content = typeof saved === 'object' && saved && 'content' in saved ? String(saved.content) : ''
          if (!/^(错误[:：]|CANCELLED|HELD|BUDGET)/.test(content)) {
            const result = replay(saved)
            await this.recordAction(db, actionId, lease.runId, call.name, 'completed', { hash, result })
            return result
          }
        }
      }
      // All nested repository operations share this transaction, without nesting BEGIN.
      const scoped = new Repository({ read: (fn: (connection: SQLiteDBConnection) => Promise<unknown>) => fn(db),
        write: (fn: (connection: SQLiteDBConnection) => Promise<unknown>) => fn(db) } as Database)
      const result = await work(scoped)
      if (!['conversation_read', 'conversation_search', 'conversation_members', 'sticker_list', 'memory_read'].includes(call.name)
        && !(typeof result === 'object' && result && 'steer' in result)) {
        await this.recordAction(db, actionId, lease.runId, call.name, 'completed', { hash, result })
      }
      return result
    })
  }

  async agentMessages(agentId: string, conversationId: string,
    scope: { through: number; roundMessageId?: string | null }, limit = 36, query = ''): Promise<Message[]> {
    return this.db.read(async db => {
      const membership = (await rows(db, `SELECT joined_sequence FROM conversation_members
        WHERE conversation_id=? AND actor_id=? AND left_sequence IS NULL`, [conversationId, agentId]))[0]
      if (!membership) throw new Error('无权读取该会话')
      const data = await rows(db, `SELECT m.* FROM messages m WHERE m.conversation_id=? AND m.deleted=0
        AND m.sequence>=? AND (m.sequence<=? OR m.origin_run_id IN
          (SELECT id FROM runs WHERE round_message_id=? AND conversation_id=?))
        AND (?='' OR instr(lower(m.body),lower(?))>0) ORDER BY m.sequence DESC LIMIT ?`,
      [conversationId, num(membership.joined_sequence), scope.through, scope.roundMessageId ?? null,
        conversationId, query, query, Math.min(Math.max(limit, 1), 100)])
      return data.map(message).reverse()
    })
  }

  async ensureLocalUser(name = '我'): Promise<void> {
    await this.db.write(async db => {
      await db.run(
        `INSERT OR IGNORE INTO actors(
          id,kind,name,color,bio,persona,speaking_style,avatar_data,enabled,archived,
          profile_version,allow_private,allow_group,created_at,updated_at
        ) VALUES (?,'human',?,'#0f766e','','','','',1,0,1,1,1,?,?)`,
        [localUserId, name, now(), now()]
      )
    })
  }

  async saveUserProfile(name: string, bio = ''): Promise<void> {
    await this.db.write(async db => db.run(
      `UPDATE actors SET name=?,bio=?,profile_version=profile_version+1,updated_at=? WHERE id=?`,
      [name.trim() || '我', bio.trim(), now(), localUserId]
    ))
  }

  async listProviders(): Promise<Provider[]> {
    return this.db.read(async db => (await rows(db, 'SELECT * FROM providers ORDER BY updated_at DESC')).map(provider))
  }

  async saveProvider(input: Provider): Promise<Provider> {
    const timestamp = now()
    const saved: Provider = {
      ...input,
      credentialRef: '',
      configVersion: input.configVersion || 1,
      createdAt: input.createdAt || timestamp,
      updatedAt: timestamp
    }
    await this.db.write(async db => {
      await db.run(
        `INSERT INTO providers(
          id,name,protocol,base_url,credential_ref,credential_state,enabled,config_version,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,protocol=excluded.protocol,
          base_url=excluded.base_url,credential_ref='',credential_state=excluded.credential_state,
          enabled=excluded.enabled,config_version=providers.config_version+1,updated_at=excluded.updated_at`,
        [saved.id, saved.name, saved.protocol, saved.baseUrl, '', saved.credentialState,
          saved.enabled ? 1 : 0, saved.configVersion, saved.createdAt, timestamp]
      )
    })
    return saved
  }

  async deleteProvider(providerId: string): Promise<void> {
    await this.db.write(async db => db.run('DELETE FROM providers WHERE id=?', [providerId]))
  }

  async saveBinding(input: ModelBinding): Promise<void> {
    if (!Number.isSafeInteger(input.contextTokens) || !Number.isSafeInteger(input.outputTokens) ||
      input.outputTokens < 1 || input.contextTokens < input.outputTokens + 1024 || !input.modelId.trim()) {
      throw new Error('模型名称或上下文/输出配置无效')
    }
    if (input.agentId) {
      await this.db.write(async db => {
        await db.run(`INSERT INTO agent_model_bindings(id,agent_id,provider_id,model_id,context_tokens,output_tokens,purpose)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(agent_id,purpose) DO UPDATE SET provider_id=excluded.provider_id,
          model_id=excluded.model_id,context_tokens=excluded.context_tokens,output_tokens=excluded.output_tokens,
          revision=agent_model_bindings.revision+1`,
        [input.id || id(), input.agentId!, input.providerId, input.modelId.trim(), input.contextTokens, input.outputTokens, input.purpose])
        await db.run('UPDATE actors SET profile_version=profile_version+1 WHERE id=?', [input.agentId!])
      })
      return
    }
    await this.db.write(async db => db.run(
      `INSERT INTO model_bindings(id,provider_id,model_id,context_tokens,output_tokens,purpose,revision)
       VALUES (?,?,?,?,?,?,1)
       ON CONFLICT(purpose) DO UPDATE SET provider_id=excluded.provider_id,model_id=excluded.model_id,
        context_tokens=excluded.context_tokens,output_tokens=excluded.output_tokens,
        revision=model_bindings.revision+1`,
      [input.id || id(), input.providerId, input.modelId.trim(), input.contextTokens,
        input.outputTokens, input.purpose]
    ))
  }

  async listBindings(): Promise<ModelBinding[]> {
    return this.db.read(async db => [
      ...(await rows(db, 'SELECT * FROM model_bindings ORDER BY purpose')).map(binding),
      ...(await rows(db, 'SELECT * FROM agent_model_bindings ORDER BY agent_id,purpose')).map(row =>
        ({ ...binding(row), agentId: text(row.agent_id) }))
    ])
  }

  async clearAgentBinding(agentId: string, purpose: ModelBinding['purpose']): Promise<void> {
    await this.db.write(async db => {
      await db.run('DELETE FROM agent_model_bindings WHERE agent_id=? AND purpose=?', [agentId, purpose])
      await db.run('UPDATE actors SET profile_version=profile_version+1 WHERE id=?', [agentId])
    })
  }

  async listActors(): Promise<Actor[]> {
    return this.db.read(async db => (await rows(db, 'SELECT * FROM actors ORDER BY kind,created_at')).map(actor))
  }

  async getActor(actorId: string): Promise<Actor | null> {
    return this.db.read(async db => {
      const row = (await rows(db, 'SELECT * FROM actors WHERE id=?', [actorId]))[0]
      return row ? actor(row) : null
    })
  }

  async saveAgent(input: Partial<Actor> & { name: string }): Promise<Actor> {
    if (!input.name.trim()) throw new Error('角色名称不能为空')
    const timestamp = now()
    const saved: Actor = {
      id: input.id ?? id(),
      kind: 'agent',
      name: input.name.trim(),
      color: input.color ?? '#7c3aed',
      bio: input.bio ?? '',
      persona: input.persona ?? '',
      speakingStyle: input.speakingStyle ?? '',
      avatarData: input.avatarData ?? '',
      enabled: input.enabled ?? true,
      archived: input.archived ?? false,
      profileVersion: input.profileVersion ?? 1,
      allowPrivate: input.allowPrivate ?? true,
      allowGroup: input.allowGroup ?? true,
      createdAt: input.createdAt ?? timestamp,
      updatedAt: timestamp
    }
    await this.db.write(async db => {
      await db.run(
      `INSERT INTO actors(
        id,kind,name,color,bio,persona,speaking_style,avatar_data,enabled,archived,
        profile_version,allow_private,allow_group,created_at,updated_at
      ) VALUES (?,'agent',?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,bio=excluded.bio,
        persona=excluded.persona,speaking_style=excluded.speaking_style,
        avatar_data=excluded.avatar_data,enabled=excluded.enabled,archived=excluded.archived,
        profile_version=actors.profile_version+1,allow_private=excluded.allow_private,
        allow_group=excluded.allow_group,updated_at=excluded.updated_at`,
      [saved.id, saved.name, saved.color, saved.bio, saved.persona, saved.speakingStyle,
        saved.avatarData, saved.enabled ? 1 : 0, saved.archived ? 1 : 0,
        saved.profileVersion, saved.allowPrivate ? 1 : 0, saved.allowGroup ? 1 : 0,
        saved.createdAt, timestamp]
      )
      await db.run('UPDATE summaries SET valid=0 WHERE agent_id=?', [saved.id])
    })
    return (await this.getActor(saved.id))!
  }

  async copyAgent(agentId: string): Promise<Actor> {
    const source = await this.getActor(agentId)
    if (!source || source.kind !== 'agent') throw new Error('角色不存在')
    const copied = await this.saveAgent({
      ...source,
      id: undefined,
      name: `${source.name} 副本`,
      archived: false,
      profileVersion: 1,
      createdAt: undefined
    })
    for (const model of (await this.listBindings()).filter(item => item.agentId === agentId)) {
      await this.saveBinding({ ...model, id: id(), agentId: copied.id, revision: 1 })
    }
    await this.db.write(async db => {
      await db.run(`INSERT INTO character_cards(actor_id,source_json,source_png,warnings_json,created_at)
        SELECT ?,source_json,source_png,warnings_json,? FROM character_cards WHERE actor_id=?`,[copied.id,now(),agentId])
      await db.run(`INSERT INTO lorebook_actor_links(actor_id,lorebook_id)
        SELECT ?,lorebook_id FROM lorebook_actor_links WHERE actor_id=?`,[copied.id,agentId])
    })
    return (await this.getActor(copied.id))!
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.db.write(async db => {
      await db.run('UPDATE media_assets SET owner_actor_id=NULL WHERE owner_actor_id=?', [agentId])
      const timestamp = now()
      await db.run(`UPDATE conversations SET cancel_epoch=cancel_epoch+1 WHERE id IN
        (SELECT conversation_id FROM conversation_members WHERE actor_id=?)`, [agentId])
      await db.run(`UPDATE inbox_events SET status='cancelled',reason='角色已删除',updated_at=?
        WHERE agent_id=? AND status IN ('pending','claimed')`, [timestamp, agentId])
      await db.run(`UPDATE runs SET status='cancelled',phase='cancelled',reason='角色已删除',
        updated_at=?,ended_at=? WHERE agent_id=?
        AND status NOT IN ('completed','cancelled','failed','interrupted','skipped')`,
      [timestamp, timestamp, agentId])
      await db.run('DELETE FROM actors WHERE id=?', [agentId])
    })
  }

  async openDirect(agentId: string): Promise<Conversation> {
    return this.db.write(async db => {
      const key = JSON.stringify(['direct', localUserId, agentId].sort())
      const existing = (await rows(db, 'SELECT id FROM conversations WHERE direct_key=?', [key]))[0]
      if (existing) {
        const conversationId = text(existing.id)
        await db.run('UPDATE conversations SET hidden=0,updated_at=? WHERE id=?', [now(), conversationId])
        return this.getConversationIn(db, conversationId)
      }
      const agentRow = (await rows(db, `SELECT * FROM actors
        WHERE id=? AND kind='agent' AND archived=0`, [agentId]))[0]
      if (!agentRow) throw new Error('角色不存在或已归档')
      const conversationId = id(), timestamp = now()
      await db.run(
        `INSERT INTO conversations(id,kind,title,topic,direct_key,created_at,updated_at)
         VALUES (?,'direct',?,'',?,?,?)`,
        [conversationId, text(agentRow.name), key, timestamp, timestamp]
      )
      await db.run(
        `INSERT INTO conversation_members(conversation_id,actor_id,ordinal) VALUES (?,?,0),(?,?,1)`,
        [conversationId, localUserId, conversationId, agentId]
      )
      await db.run('INSERT INTO user_reads(conversation_id,through_sequence,updated_at) VALUES (?,0,?)',
        [conversationId, timestamp])
      return this.getConversationIn(db, conversationId)
    })
  }

  async createGroup(title: string, memberIds: string[], topic = ''): Promise<Conversation> {
    if (!title.trim()) throw new Error('群名称不能为空')
    const members = [...new Set(memberIds)]
    if (members.length < 1 || members.length > 8) throw new Error('群聊需要 1–8 个角色')
    return this.db.write(async db => {
      const valid = await rows(db,
        `SELECT id FROM actors WHERE kind='agent' AND archived=0
         AND id IN (${members.map(() => '?').join(',')})`, members)
      if (valid.length !== members.length) throw new Error('包含不存在或已归档的角色')
      const conversationId = id(), timestamp = now()
      await db.run(
        `INSERT INTO conversations(id,kind,title,topic,created_at,updated_at)
         VALUES (?,'group',?,?,?,?)`,
        [conversationId, title.trim(), topic.trim(), timestamp, timestamp]
      )
      let ordinal = 0
      for (const actorId of [localUserId, ...members]) {
        await db.run(
          'INSERT INTO conversation_members(conversation_id,actor_id,ordinal) VALUES (?,?,?)',
          [conversationId, actorId, ordinal++]
        )
      }
      await db.run('INSERT INTO user_reads(conversation_id,through_sequence,updated_at) VALUES (?,0,?)',
        [conversationId, timestamp])
      return this.getConversationIn(db, conversationId)
    })
  }

  async createAgentGroup(sourceConversationId: string, creatorId: string, memberIds: string[], requestedTitle?: string): Promise<Conversation> {
    const members = [...new Set(memberIds.filter(memberId => memberId !== creatorId))]
    if (!members.length || members.length > 7) throw new Error('小组需要 1–7 个其他角色')
    return this.db.write(async db => {
      const allowed = await rows(db,
        `SELECT a.id,a.name,a.allow_group FROM actors a
         JOIN conversation_members m ON m.actor_id=a.id
         WHERE m.conversation_id=? AND m.left_sequence IS NULL
         AND a.kind='agent' AND a.enabled=1 AND a.archived=0
         AND a.id IN (${[creatorId, ...members].map(() => '?').join(',')})`,
        [sourceConversationId, creatorId, ...members]
      )
      if (allowed.length !== members.length + 1 || allowed.some(row => !bool(row.allow_group))) {
        throw new Error('只能邀请当前会话中允许建群的角色')
      }
      const creator = allowed.find(row => text(row.id) === creatorId)
      if (!creator) throw new Error('创建者无权建群')
      const conversationId = id(), timestamp = now()
      const title = requestedTitle?.trim().slice(0, 100) || allowed.map(row => text(row.name)).join(' × ')
      await db.run(
        `INSERT INTO conversations(id,kind,title,origin_conversation_id,created_at,updated_at)
         VALUES (?,'agent_group',?,?,?,?)`,
        [conversationId, title, sourceConversationId, timestamp, timestamp]
      )
      let ordinal = 0
      for (const actorId of [creatorId, ...members]) {
        await db.run('INSERT INTO conversation_members(conversation_id,actor_id,ordinal) VALUES (?,?,?)',
          [conversationId, actorId, ordinal++])
      }
      return this.getConversationIn(db, conversationId)
    })
  }

  async openAgentDirect(sourceConversationId: string, creatorId: string, targetId: string): Promise<Conversation> {
    if (creatorId === targetId) throw new Error('不能和自己创建私聊')
    return this.db.write(async db => {
      const allowed = await rows(db,
        `SELECT a.id,a.name,a.allow_private FROM actors a
         JOIN conversation_members m ON m.actor_id=a.id
         WHERE m.conversation_id=? AND m.left_sequence IS NULL
         AND a.kind='agent' AND a.enabled=1 AND a.archived=0 AND a.id IN (?,?)`,
        [sourceConversationId, creatorId, targetId]
      )
      if (allowed.length !== 2 || allowed.some(row => !bool(row.allow_private))) {
        throw new Error('只能与当前会话中允许私聊的角色私聊')
      }
      const key = JSON.stringify(['agent_direct', creatorId, targetId].sort())
      const existing = (await rows(db, 'SELECT id FROM conversations WHERE direct_key=?', [key]))[0]
      if (existing) return this.getConversationIn(db, text(existing.id))
      const conversationId = id(), timestamp = now()
      await db.run(
        `INSERT INTO conversations(id,kind,title,direct_key,origin_conversation_id,created_at,updated_at)
         VALUES (?,'agent_direct',?,?,?,?,?)`,
        [conversationId, allowed.map(row => text(row.name)).join(' × '), key,
          sourceConversationId, timestamp, timestamp]
      )
      await db.run(
        'INSERT INTO conversation_members(conversation_id,actor_id,ordinal) VALUES (?,?,0),(?,?,1)',
        [conversationId, creatorId, conversationId, targetId]
      )
      return this.getConversationIn(db, conversationId)
    })
  }

  async listConversations(includeHidden = false): Promise<Conversation[]> {
    return this.db.read(async db => {
      const data = await rows(db, `
        SELECT c.*,
          COALESCE((SELECT body FROM messages m WHERE m.conversation_id=c.id
            AND m.deleted=0 ORDER BY sequence DESC LIMIT 1),'') last_message,
          (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.deleted=0
            AND m.sequence>COALESCE(u.through_sequence,0) AND m.author_id<>?) unread
        FROM conversations c LEFT JOIN user_reads u ON u.conversation_id=c.id
        WHERE (? OR c.hidden=0) AND c.kind IN ('direct','group')
        ORDER BY c.pinned DESC,c.updated_at DESC
      `, [localUserId, includeHidden ? 1 : 0])
      const result: Conversation[] = []
      for (const row of data) {
        const members = await rows(db, `
          SELECT m.actor_id,a.name FROM conversation_members m
          JOIN actors a ON a.id=m.actor_id
          WHERE m.conversation_id=? AND m.left_sequence IS NULL ORDER BY m.ordinal
        `, [text(row.id)])
        result.push(conversation(
          row,
          text(row.last_message),
          num(row.unread),
          members.map(item => text(item.actor_id)),
          members.map(item => text(item.name))
        ))
      }
      return result
    })
  }

  async listWhispers(): Promise<Conversation[]> {
    return this.db.read(async db => {
      const data = await rows(db, `
        SELECT c.*,COALESCE((SELECT body FROM messages m WHERE m.conversation_id=c.id
          AND m.deleted=0 ORDER BY sequence DESC LIMIT 1),'') last_message
        FROM conversations c WHERE c.kind IN ('agent_direct','agent_group')
        ORDER BY c.updated_at DESC
      `)
      const result: Conversation[] = []
      for (const row of data) {
        const members = await rows(db, `
          SELECT m.actor_id,a.name FROM conversation_members m
          JOIN actors a ON a.id=m.actor_id
          WHERE m.conversation_id=? AND m.left_sequence IS NULL ORDER BY m.ordinal
        `, [text(row.id)])
        result.push(conversation(
          row,
          text(row.last_message),
          0,
          members.map(item => text(item.actor_id)),
          members.map(item => text(item.name))
        ))
      }
      return result
    })
  }

  async getConversation(conversationId: string): Promise<Conversation | null> {
    return this.db.read(async db => {
      const exists = (await rows(db, 'SELECT 1 FROM conversations WHERE id=?', [conversationId])).length
      return exists ? this.getConversationIn(db, conversationId) : null
    })
  }

  private async getConversationIn(db: SQLiteDBConnection, conversationId: string): Promise<Conversation> {
    const row = (await rows(db, 'SELECT * FROM conversations WHERE id=?', [conversationId]))[0]
    if (!row) throw new Error('会话不存在')
    const members = await rows(db, `
      SELECT m.actor_id,a.name FROM conversation_members m
      JOIN actors a ON a.id=m.actor_id
      WHERE m.conversation_id=? AND m.left_sequence IS NULL ORDER BY m.ordinal
    `, [conversationId])
    return conversation(row, '', 0,
      members.map(item => text(item.actor_id)),
      members.map(item => text(item.name)))
  }

  async updateMembers(conversationId: string, addIds: string[], removeIds: string[]): Promise<void> {
    await this.db.write(async db => {
      const conversationRow = (await rows(db, 'SELECT * FROM conversations WHERE id=?', [conversationId]))[0]
      if (!conversationRow || text(conversationRow.kind) !== 'group') throw new Error('只能修改普通群成员')
      const currentRows = await rows(db, `SELECT actor_id FROM conversation_members
        WHERE conversation_id=? AND left_sequence IS NULL`, [conversationId])
      const current = currentRows.map(row => text(row.actor_id))
      const added = [...new Set(addIds.filter(actorId => !current.includes(actorId)))]
      const removed = [...new Set(removeIds.filter(actorId => actorId !== localUserId && current.includes(actorId)))]
      if (current.length + added.length - removed.length > 9) throw new Error('群成员不能超过 9 人')
      let ordinal = current.length
      for (const actorId of added) {
        const valid = (await rows(db, `SELECT 1 FROM actors
          WHERE id=? AND kind='agent' AND archived=0`, [actorId])).length
        if (!valid) throw new Error('只能添加可用角色')
        await db.run(
          `INSERT INTO conversation_members(conversation_id,actor_id,ordinal,joined_sequence)
           VALUES (?,?,?,?)
           ON CONFLICT(conversation_id,actor_id) DO UPDATE SET
            left_sequence=NULL,ordinal=excluded.ordinal,joined_sequence=excluded.joined_sequence`,
          [conversationId, actorId, ordinal++, num(conversationRow.next_sequence)]
        )
      }
      for (const actorId of removed) {
        await db.run(
          'UPDATE conversation_members SET left_sequence=? WHERE conversation_id=? AND actor_id=?',
          [num(conversationRow.next_sequence), conversationId, actorId]
        )
        await db.run(`UPDATE inbox_events SET status='cancelled',reason='成员已离开',updated_at=?
          WHERE conversation_id=? AND agent_id=? AND status IN ('pending','claimed')`,
        [now(), conversationId, actorId])
      }
      if (added.length || removed.length) {
        await db.run(`UPDATE conversations SET membership_version=membership_version+1,
          content_revision=content_revision+1,cancel_epoch=cancel_epoch+1,updated_at=? WHERE id=?`,
        [now(), conversationId])
      }
    })
  }

  async sendUserMessage(
    conversationId: string,
    body: string,
    commandId: string,
    quotedId?: string | null,
    explicitMentions?: string[],
    mediaId?: string
  ): Promise<Message> {
    return this.db.write(async db => {
      const receipt = (await rows(db, 'SELECT result_id FROM command_receipts WHERE command_id=?', [commandId]))[0]
      if (receipt) {
        const existing = (await rows(db, 'SELECT * FROM messages WHERE id=?', [text(receipt.result_id)]))[0]
        if (!existing) throw new Error('发送回执损坏')
        const saved = message(existing)
        saved.reactions = await this.loadReactions(db, saved.id)
        saved.mentions = await this.loadMentions(db, saved.id)
        saved.commandReplayed = true
        return saved
      }
      const conversationRow = (await rows(db, 'SELECT * FROM conversations WHERE id=?', [conversationId]))[0]
      if (!conversationRow) throw new Error('会话不存在')
      if (text(conversationRow.kind).startsWith('agent_')) throw new Error('旁观会话不可发送')
      if (bool(conversationRow.paused)) throw new Error('会话已暂停')
      if (mediaId && !(await rows(db,"SELECT 1 FROM media_assets WHERE id=? AND status='ready'",[mediaId])).length) throw new Error('媒体不存在')
      const normalized = body.trim()
      if (!normalized) throw new Error('消息不能为空')
      if (normalized.length > maxMessageLength) throw new Error('消息过长')
      const membership = (await rows(db, `SELECT 1 FROM conversation_members
        WHERE conversation_id=? AND actor_id=? AND left_sequence IS NULL`,
      [conversationId, localUserId])).length
      if (!membership) throw new Error('你不在当前会话')
      if (quotedId) {
        const valid = (await rows(db, `SELECT 1 FROM messages
          WHERE id=? AND conversation_id=? AND deleted=0`, [quotedId, conversationId])).length
        if (!valid) throw new Error('引用消息不存在')
      }
      const author = (await rows(db, 'SELECT * FROM actors WHERE id=?', [localUserId]))[0]
      if (!author) throw new Error('本地用户不存在')
      const timestamp = now(), sequence = num(conversationRow.next_sequence), messageId = id()
      await db.run(`UPDATE runs SET status='cancelled',phase='cancelled',reason='已被新用户消息替代',updated_at=?
        WHERE id IN (SELECT run_id FROM retry_jobs WHERE conversation_id=? AND status IN ('pending','dispatched','dormant'))
          AND status IN ('failed','interrupted')`, [timestamp, conversationId])
      await db.run("UPDATE retry_jobs SET status='cancelled',updated_at=? WHERE conversation_id=?", [timestamp, conversationId])
      const members = await rows(db, `
        SELECT m.actor_id,a.name FROM conversation_members m JOIN actors a ON a.id=m.actor_id
        WHERE m.conversation_id=? AND m.left_sequence IS NULL
      `, [conversationId])
      const names = new Map(members.map(row => [text(row.actor_id), text(row.name)]))
      const textMentions = [...names.entries()]
        .filter(([, name]) => normalized.includes(`@${name}`))
        .map(([actorId]) => actorId)
      const mentions = [...new Set([...textMentions, ...(explicitMentions ?? [])])]
        .filter(actorId => names.has(actorId) && actorId !== localUserId)
      await db.run(`UPDATE conversations SET next_sequence=?,
        updated_at=? WHERE id=?`, [sequence + 1, timestamp, conversationId])
      await db.run(
        `INSERT INTO messages(id,conversation_id,author_id,author_name,author_kind,body,sequence,
          quoted_id,request_id,created_at,media_id) VALUES (?,?,?,?, 'human',?,?,?,?,?,?)`,
        [messageId, conversationId, localUserId, text(author.name), normalized, sequence,
          quotedId ?? null, id(), timestamp, mediaId ?? null]
      )
      await this.insertMentions(db, messageId, mentions)
      await this.insertInbox(db, conversationId, messageId, sequence, localUserId)
      await db.run(`INSERT INTO command_receipts(command_id,command_kind,result_id,created_at)
        VALUES (?,'send_message',?,?)`, [commandId, messageId, timestamp])
      await db.run('DELETE FROM composer_drafts WHERE conversation_id=?', [conversationId])
      return {
        id: messageId, conversationId, authorId: localUserId, authorName: text(author.name),
        authorKind: 'human', body: normalized, sequence, quotedId: quotedId ?? null,
        mentions, createdAt: timestamp, deleted: false, reactions: [], mediaId: mediaId ?? null
      }
    })
  }

  async sendAgentMessage(input: {
    actionId: string
    runId: string
    conversationId: string
    authorId: string
    body: string
    quotedId?: string | null
    mediaId?: string
    expectedEpoch: number
    seenThrough: number
    freshnessThrough?: number | null
    activityId?: string | null
    roundMessageId?: string | null
  }): Promise<{
    status: 'sent' | 'held' | 'duplicate' | 'cancelled' | 'stale' | 'budget'
    message?: Message
    latestSequence?: number
  }> {
    return this.db.write(async db => {
      const previous = (await rows(db, 'SELECT status,result_json FROM tool_actions WHERE action_id=?',
        [input.actionId]))[0]
      if (previous) {
        const result = JSON.parse(text(previous.result_json, '{}')) as Record<string, unknown>
        if (text(previous.status) === 'sent' && text(result.messageId)) {
          const saved = (await rows(db, 'SELECT * FROM messages WHERE id=?', [text(result.messageId)]))[0]
          return { status: 'sent', message: saved ? message(saved) : undefined }
        }
        return { status: text(previous.status) as 'held' | 'duplicate' | 'cancelled' | 'stale' }
      }
      const conversationRow = (await rows(db, 'SELECT * FROM conversations WHERE id=?', [input.conversationId]))[0]
      if (!conversationRow) return { status: 'cancelled' }
      if (num(conversationRow.cancel_epoch) !== input.expectedEpoch || bool(conversationRow.paused)) {
        await this.recordAction(db, input.actionId, input.runId, 'message_send', 'cancelled', {})
        return { status: 'cancelled' }
      }
      const membership = (await rows(db, `SELECT 1 FROM conversation_members cm
        JOIN actors a ON a.id=cm.actor_id AND a.enabled=1 AND a.archived=0
        WHERE cm.conversation_id=? AND cm.actor_id=? AND cm.left_sequence IS NULL`,
      [input.conversationId, input.authorId])).length
      if (!membership) {
        await this.recordAction(db, input.actionId, input.runId, 'message_send', 'cancelled', {})
        return { status: 'cancelled' }
      }
      if (input.activityId) {
        const activity = (await rows(db, `SELECT status,posts,started_at FROM activities WHERE id=?`,
          [input.activityId]))[0]
        if (!activity || text(activity.status) !== 'active' || num(activity.posts) >= 24 || now() - num(activity.started_at) >= 180_000) {
          await this.recordAction(db, input.actionId, input.runId, 'message_send', 'budget', {})
          return { status: 'budget' }
        }
      }
      const freshnessThrough = input.freshnessThrough ?? null
      const latestRows = await rows(db, `SELECT * FROM messages WHERE conversation_id=?
        AND deleted=0 AND (? IS NULL OR sequence<=? OR origin_run_id IN
          (SELECT id FROM runs WHERE round_message_id=? AND conversation_id=?))
        ORDER BY sequence DESC LIMIT 8`,
      [input.conversationId, freshnessThrough, freshnessThrough, input.roundMessageId ?? null, input.conversationId])
      const latest = latestRows[0]
      if (latest && num(latest.sequence) > input.seenThrough && text(latest.author_id) !== input.authorId) {
        await this.recordAction(db, input.actionId, input.runId, 'message_send', 'held',
          { latestSequence: num(latest.sequence) })
        return { status: 'held', latestSequence: num(latest.sequence) }
      }
      if (input.mediaId && !(await rows(db,"SELECT 1 FROM media_assets WHERE id=? AND status='ready'",[input.mediaId])).length) throw new Error('媒体不存在')
      const normalized = input.body.trim()
      if (!normalized) return { status: 'stale' }
      if (normalized.length > maxMessageLength) throw new Error('消息过长')
      const duplicate = latestRows.find(row => text(row.author_id) !== input.authorId
        && text(row.body).trim() === normalized)
      if (duplicate) {
        await this.recordAction(db, input.actionId, input.runId, 'message_send', 'duplicate', {})
        return { status: 'duplicate' }
      }
      const author = (await rows(db, 'SELECT * FROM actors WHERE id=?', [input.authorId]))[0]
      if (!author) return { status: 'cancelled' }
      if (input.quotedId) {
        const valid = (await rows(db, `SELECT 1 FROM messages
          WHERE id=? AND conversation_id=? AND deleted=0`, [input.quotedId, input.conversationId])).length
        if (!valid) return { status: 'stale' }
      }
      const timestamp = now(), sequence = num(conversationRow.next_sequence), messageId = id()
      const members = await rows(db, `SELECT m.actor_id,a.name FROM conversation_members m
        JOIN actors a ON a.id=m.actor_id
        WHERE m.conversation_id=? AND m.left_sequence IS NULL`, [input.conversationId])
      const names = new Map(members.map(row => [text(row.actor_id), text(row.name)]))
      const mentions = [...names.entries()]
        .filter(([, name]) => normalized.includes(`@${name}`))
        .map(([actorId]) => actorId)
      await db.run(`UPDATE conversations SET next_sequence=?,
        updated_at=? WHERE id=?`, [sequence + 1, timestamp, input.conversationId])
      await db.run(
        `INSERT INTO messages(id,conversation_id,author_id,author_name,author_kind,body,sequence,
          quoted_id,request_id,activity_id,origin_run_id,created_at,media_id)
         VALUES (?,?,?,?, 'agent',?,?,?,?,?,?,?,?)`,
        [messageId, input.conversationId, input.authorId, text(author.name), normalized, sequence,
          input.quotedId ?? null, id(), input.activityId ?? null, input.runId, timestamp, input.mediaId ?? null]
      )
      await this.insertMentions(db, messageId, mentions)
      await this.insertInbox(db, input.conversationId, messageId, sequence, input.authorId)
      if (input.activityId) {
        await db.run('UPDATE activities SET posts=posts+1,updated_at=? WHERE id=?',
          [timestamp, input.activityId])
      }
      await this.recordAction(db, input.actionId, input.runId, 'message_send', 'sent', { messageId })
      return {
        status: 'sent',
        message: {
          id: messageId, conversationId: input.conversationId, authorId: input.authorId,
          authorName: text(author.name), authorKind: 'agent', body: normalized, sequence,
          quotedId: input.quotedId ?? null, mentions, createdAt: timestamp,
          deleted: false, reactions: []
        }
      }
    })
  }

  async listMessages(conversationId: string, before?: number, limit = 50): Promise<Message[]> {
    return this.db.read(async db => {
      return this.listMessagesIn(db, conversationId, before, limit)
    })
  }

  async listMessagesThrough(conversationId: string, through: number, limit = 50): Promise<Message[]> {
    return this.db.read(async db => {
      const safeLimit = Math.min(Math.max(limit, 1), 100)
      const data = await rows(db, `SELECT * FROM messages WHERE conversation_id=? AND sequence<=?
        ORDER BY sequence DESC LIMIT ?`, [conversationId, through, safeLimit])
      const result = data.map(message)
      for (const item of result) {
        item.reactions = await this.loadReactions(db, item.id)
        item.mentions = await this.loadMentions(db, item.id)
      }
      return result.reverse()
    })
  }

  async allMessages(conversationId: string): Promise<Message[]> {
    return this.db.read(async db => {
      const data = await rows(db, `SELECT * FROM messages WHERE conversation_id=?
        ORDER BY sequence ASC`, [conversationId])
      const result = data.map(message)
      for (const item of result) {
        item.reactions = await this.loadReactions(db, item.id)
        item.mentions = await this.loadMentions(db, item.id)
      }
      return result
    })
  }

  async latestSequence(conversationId: string): Promise<number> {
    return this.db.read(async db => {
      const row = (await rows(db,
        'SELECT COALESCE(MAX(sequence),0) sequence FROM messages WHERE conversation_id=?',
        [conversationId]))[0]
      return num(row?.sequence)
    })
  }

  async messageById(messageId: string): Promise<Message | null> {
    return this.db.read(async db => {
      const row = (await rows(db, 'SELECT * FROM messages WHERE id=?', [messageId]))[0]
      if (!row) return null
      const saved = message(row)
      saved.reactions = await this.loadReactions(db, saved.id)
      saved.mentions = await this.loadMentions(db, saved.id)
      return saved
    })
  }

  async messagesAround(conversationId: string, messageId: string, radius = 20): Promise<{
    messages: Message[]
    hasOlder: boolean
    hasNewer: boolean
  }> {
    return this.db.read(async db => {
      const target = (await rows(db, `SELECT sequence FROM messages
        WHERE id=? AND conversation_id=?`, [messageId, conversationId]))[0]
      if (!target) {
        return {
          messages: await this.listMessagesIn(db, conversationId, undefined, 50),
          hasOlder: (await this.messageCountIn(db, conversationId)) > 50,
          hasNewer: false
        }
      }
      const sequence = num(target.sequence)
      const safeRadius = Math.min(Math.max(radius, 5), 50)
      const data = await rows(db, `SELECT * FROM messages WHERE conversation_id=?
        AND sequence BETWEEN ? AND ? ORDER BY sequence ASC`,
      [conversationId, Math.max(1, sequence - safeRadius), sequence + safeRadius])
      const result = data.map(message)
      for (const item of result) {
        item.reactions = await this.loadReactions(db, item.id)
        item.mentions = await this.loadMentions(db, item.id)
      }
      return {
        messages: result,
        hasOlder: (await rows(db, `SELECT 1 FROM messages WHERE conversation_id=?
          AND sequence<? LIMIT 1`, [conversationId, result[0]?.sequence ?? sequence])).length > 0,
        hasNewer: (await rows(db, `SELECT 1 FROM messages WHERE conversation_id=?
          AND sequence>? LIMIT 1`,
        [conversationId, result.at(-1)?.sequence ?? sequence])).length > 0
      }
    })
  }

  private async listMessagesIn(
    db: SQLiteDBConnection,
    conversationId: string,
    before?: number,
    limit = 50
  ): Promise<Message[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100)
    const data = before
      ? await rows(db, `SELECT * FROM messages WHERE conversation_id=? AND sequence<?
        ORDER BY sequence DESC LIMIT ?`, [conversationId, before, safeLimit])
      : await rows(db, `SELECT * FROM messages WHERE conversation_id=?
        ORDER BY sequence DESC LIMIT ?`, [conversationId, safeLimit])
    const result = data.map(message)
    for (const item of result) {
      item.reactions = await this.loadReactions(db, item.id)
      item.mentions = await this.loadMentions(db, item.id)
    }
    return result.reverse()
  }

  async saveDraft(conversationId: string, body: string, quotedId?: string | null): Promise<void> {
    await this.db.write(async db => {
      if (!body) {
        await db.run('DELETE FROM composer_drafts WHERE conversation_id=?', [conversationId])
        return
      }
      await db.run(
        `INSERT INTO composer_drafts(conversation_id,body,quoted_id,updated_at) VALUES (?,?,?,?)
         ON CONFLICT(conversation_id) DO UPDATE SET body=excluded.body,
          quoted_id=excluded.quoted_id,updated_at=excluded.updated_at`,
        [conversationId, body, quotedId ?? null, now()]
      )
    })
  }

  async getDraft(conversationId: string): Promise<{ body: string; quotedId: string | null }> {
    return this.db.read(async db => {
      const row = (await rows(db, 'SELECT * FROM composer_drafts WHERE conversation_id=?', [conversationId]))[0]
      return row
        ? { body: text(row.body), quotedId: row.quoted_id ? text(row.quoted_id) : null }
        : { body: '', quotedId: null }
    })
  }

  async toggleReaction(messageId: string, actorId: string, emoji: string): Promise<boolean> {
    if (!emoji.trim() || emoji.length > 16) throw new Error('表情无效')
    return this.db.write(async db => {
      const existing = (await rows(db,
        'SELECT 1 FROM reactions WHERE message_id=? AND actor_id=? AND emoji=?',
        [messageId, actorId, emoji])).length
      if (existing) {
        await db.run('DELETE FROM reactions WHERE message_id=? AND actor_id=? AND emoji=?',
          [messageId, actorId, emoji])
        return false
      }
      const messageRow = (await rows(db, `SELECT m.conversation_id,m.author_id,m.sequence
        FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id
        WHERE m.id=? AND m.deleted=0 AND cm.actor_id=? AND cm.left_sequence IS NULL`,
      [messageId, actorId]))[0]
      if (!messageRow) throw new Error('无权操作该消息')
      await db.run('INSERT INTO reactions(message_id,actor_id,emoji,created_at) VALUES (?,?,?,?)',
        [messageId, actorId, emoji, now()])
      if (actorId === localUserId && text(messageRow.author_id) !== localUserId) {
        await db.run("UPDATE retry_jobs SET status='cancelled',updated_at=? WHERE conversation_id=?", [now(), messageRow.conversation_id])
        await this.insertInbox(db, text(messageRow.conversation_id), messageId,
          num(messageRow.sequence), localUserId, '用户表情互动')
      }
      return true
    })
  }

  async markRead(conversationId: string, through: number): Promise<void> {
    await this.db.write(async db => db.run(
      `INSERT INTO user_reads(conversation_id,through_sequence,updated_at) VALUES (?,?,?)
       ON CONFLICT(conversation_id) DO UPDATE SET
        through_sequence=MAX(through_sequence,excluded.through_sequence),updated_at=excluded.updated_at`,
      [conversationId, through, now()]
    ))
  }

  async searchMessages(query: string, options: { offset?: number; conversationId?: string; authorId?: string; beforeCreatedAt?: number; beforeId?: string } = {}): Promise<SearchHit[]> {
    const normalized = query.trim()
    if (!normalized) return []
    const offset = Math.max(0, Math.floor(options.offset ?? 0))
    return this.db.read(async db => (await rows(db, `
      SELECT m.*,c.title conversation_title FROM messages m
      JOIN conversations c ON c.id=m.conversation_id
      WHERE m.deleted=0 AND m.recalled=0 AND instr(lower(m.body),lower(?))>0
        AND (? IS NULL OR m.conversation_id=?) AND (? IS NULL OR m.author_id=?)
        AND (? IS NULL OR m.created_at<? OR (m.created_at=? AND m.id<?))
      ORDER BY m.created_at DESC,m.id DESC LIMIT 50 OFFSET ?
    `, [normalized, options.conversationId ?? null, options.conversationId ?? null,
      options.authorId ?? null, options.authorId ?? null, options.beforeCreatedAt ?? null,
      options.beforeCreatedAt ?? null, options.beforeCreatedAt ?? null, options.beforeId ?? '', offset])).map(row => ({ ...message(row), conversationTitle: text(row.conversation_title) })))
  }

  async searchMessagesForAgent(agentId: string, conversationId: string, query: string): Promise<Message[]> {
    return this.db.read(async db => {
      const member = (await rows(db, `SELECT 1 FROM conversation_members
        WHERE conversation_id=? AND actor_id=? AND left_sequence IS NULL`,
      [conversationId, agentId])).length
      if (!member) throw new Error('无权读取该会话')
      return (await rows(db, `SELECT * FROM messages WHERE conversation_id=? AND deleted=0
        AND instr(lower(body),lower(?))>0 ORDER BY sequence DESC LIMIT 30`,
      [conversationId, query.trim()])).map(message)
    })
  }

  async inboxMentions(agentId: string, conversationId: string, through: number): Promise<boolean> {
    return this.db.read(async db => (await rows(db, `SELECT 1 FROM inbox_events i
      JOIN message_mentions m ON m.message_id=i.message_id
      WHERE i.agent_id=? AND i.conversation_id=? AND i.sequence<=?
      AND m.target_actor_id=? LIMIT 1`,
    [agentId, conversationId, through, agentId])).length > 0)
  }

  async hasHumanInbox(agentId: string, conversationId: string, through: number): Promise<boolean> {
    return this.db.read(async db => (await rows(db, `SELECT 1 FROM inbox_events i
      JOIN messages m ON m.id=i.message_id
      WHERE i.agent_id=? AND i.conversation_id=? AND i.sequence<=?
      AND m.author_id=? LIMIT 1`,
    [agentId, conversationId, through, localUserId])).length > 0)
  }

  async conversationMembersForAgent(agentId: string, conversationId: string): Promise<Actor[]> {
    return this.db.read(async db => {
      const member = (await rows(db, `SELECT 1 FROM conversation_members
        WHERE conversation_id=? AND actor_id=? AND left_sequence IS NULL`,
      [conversationId, agentId])).length
      if (!member) throw new Error('无权读取该会话')
      return (await rows(db, `SELECT a.* FROM actors a JOIN conversation_members m ON m.actor_id=a.id
        WHERE m.conversation_id=? AND m.left_sequence IS NULL ORDER BY m.ordinal`,
      [conversationId])).map(actor)
    })
  }

  async listMemories(agentId: string, conversationId?: string): Promise<Memory[]> {
    return this.db.read(async db => {
      const data = conversationId
        ? await rows(db, `SELECT * FROM memories WHERE agent_id=? AND valid=1
          AND (conversation_id=? OR (conversation_id IS NULL AND (origin='human' OR NOT EXISTS
            (SELECT 1 FROM conversations WHERE id=? AND branch_sequence>0))))
          ORDER BY pinned DESC,updated_at DESC LIMIT 100`, [agentId, conversationId, conversationId])
        : await rows(db, `SELECT * FROM memories WHERE agent_id=? AND valid=1
          ORDER BY pinned DESC,updated_at DESC LIMIT 100`, [agentId])
      return data.map(memory)
    })
  }

  /** Newest retained summary at or before `through`, used as the history cutoff. */
  async summaryFor(agentId: string, conversationId: string, contentRevision: number, through = Number.MAX_SAFE_INTEGER): Promise<{
    throughSequence: number
    startSequence: number
    body: string
  } | null> {
    return this.db.read(async db => {
      const row = (await rows(db, `SELECT start_sequence,through_sequence,body FROM summaries
        WHERE agent_id=? AND conversation_id=? AND content_revision=? AND valid=1 AND through_sequence<=?
        ORDER BY through_sequence DESC LIMIT 1`,
      [agentId, conversationId, contentRevision, through]))[0]
      return row ? { startSequence: Math.max(1, num(row.start_sequence)), throughSequence: num(row.through_sequence), body: text(row.body) } : null
    })
  }

  /** Every valid span for the conversation, oldest first, so prompts can cite coverage. */
  async summarySpans(agentId: string, conversationId: string, contentRevision: number,
    through = Number.MAX_SAFE_INTEGER, limit = 8): Promise<SummarySpan[]> {
    return this.db.read(async db => (await rows(db, `SELECT id,start_sequence,through_sequence,body FROM summaries
      WHERE agent_id=? AND conversation_id=? AND content_revision=? AND valid=1 AND through_sequence<=?
      ORDER BY through_sequence DESC LIMIT ?`,
      [agentId, conversationId, contentRevision, through, Math.min(Math.max(limit, 1), 20)]))
      .reverse().map(row => ({
        id: text(row.id), startSequence: Math.max(1, num(row.start_sequence)),
        throughSequence: num(row.through_sequence), body: text(row.body)
      })))
  }

  async summaryTimeline(conversationId: string, agentId: string, beforeThrough = Number.MAX_SAFE_INTEGER): Promise<SummaryEntry[]> {
    return this.db.read(async db => (await rows(db, `SELECT s.*,c.content_revision current_revision,
      m.joined_sequence,m.left_sequence FROM summaries s JOIN conversations c ON c.id=s.conversation_id
      LEFT JOIN conversation_members m ON m.conversation_id=c.id AND m.actor_id=s.agent_id
      WHERE s.conversation_id=? AND s.agent_id=? AND s.through_sequence<?
      ORDER BY s.through_sequence DESC LIMIT 20`, [conversationId,agentId,beforeThrough])).map(row => {
      const segmented = Boolean(text(row.segment_body).trim()) && num(row.segment_start_sequence)>=num(row.start_sequence)
        && num(row.segment_start_sequence)<=num(row.through_sequence)
      return { id:text(row.id),kind:segmented ? 'segment' : 'cumulative',
        startSequence:segmented ? num(row.segment_start_sequence) : num(row.start_sequence),
        throughSequence:num(row.through_sequence),body:segmented ? text(row.segment_body) : text(row.body),
        cumulativeBody:text(row.body),cumulativeStartSequence:num(row.start_sequence),createdAt:num(row.created_at),
        valid:bool(row.valid) && num(row.content_revision)===num(row.current_revision)
          && row.joined_sequence!==null && num(row.start_sequence)>=num(row.joined_sequence) && row.left_sequence===null }
    }))
  }

  async saveSummary(input: {
    agentId: string
    conversationId: string
    throughSequence: number
    contentRevision: number
    body: string
    expectedEpoch?: number
    profileVersion?: number
    startSequence?: number
    segmentStartSequence?: number
    segmentBody?: string
  }): Promise<void> {
    const normalized = input.body.trim()
    if (!normalized) return
    await this.db.write(async db => {
      const state = (await rows(db, `SELECT c.content_revision,c.cancel_epoch,c.paused,a.profile_version,a.enabled,a.archived
        FROM conversations c JOIN actors a ON a.id=? WHERE c.id=?`, [input.agentId, input.conversationId]))[0]
      if (!state || num(state.content_revision) !== input.contentRevision || bool(state.paused) ||
        !bool(state.enabled) || bool(state.archived) ||
        (input.expectedEpoch !== undefined && num(state.cancel_epoch) !== input.expectedEpoch) ||
        (input.profileVersion !== undefined && num(state.profile_version) !== input.profileVersion)) return
      const start = Math.max(1, input.startSequence ?? 1)
      if (!Number.isSafeInteger(input.throughSequence) || input.throughSequence<start) throw new Error('摘要区间无效')
      const segmentStart = input.segmentStartSequence ?? 0
      const segmentBody = input.segmentBody?.trim() ?? ''
      if (segmentBody && (!Number.isSafeInteger(segmentStart) || segmentStart<start || segmentStart>input.throughSequence)) {
        throw new Error('分段摘要区间无效')
      }
      await db.run(`INSERT INTO summaries(
        id,agent_id,conversation_id,through_sequence,content_revision,body,valid,created_at,start_sequence,segment_start_sequence,segment_body
      ) VALUES (?,?,?,?,?,?,1,?,?,?,?)
       ON CONFLICT(agent_id,conversation_id,through_sequence) DO UPDATE SET
        content_revision=excluded.content_revision,body=excluded.body,valid=1,created_at=excluded.created_at,
        start_sequence=excluded.start_sequence,segment_start_sequence=excluded.segment_start_sequence,segment_body=excluded.segment_body`,
      [id(), input.agentId, input.conversationId, input.throughSequence,
        input.contentRevision, normalized, now(), start,segmentBody ? segmentStart : 0,segmentBody])
    })
  }

  async conversationMemorySources(targetId: string, agentId: string): Promise<ConversationMemorySource[]> {
    return this.db.read(async db => {
      if (!(await rows(db, `SELECT 1 FROM conversation_members WHERE conversation_id=? AND actor_id=? AND left_sequence IS NULL`,
        [targetId,agentId])).length) throw new Error('角色已不在当前会话')
      return (await rows(db, `SELECT c.id,c.title,c.kind,
        CASE WHEN m.actor_id IS NOT NULL AND m.left_sequence IS NULL THEN 1 ELSE 0 END available,
        EXISTS(SELECT 1 FROM conversation_memory_links l WHERE l.agent_id=? AND l.target_conversation_id=?
          AND l.source_conversation_id=c.id) linked
        FROM conversations c LEFT JOIN conversation_members m ON m.conversation_id=c.id AND m.actor_id=?
        WHERE c.id<>? AND ((m.actor_id IS NOT NULL AND m.left_sequence IS NULL) OR EXISTS(
          SELECT 1 FROM conversation_memory_links l WHERE l.agent_id=? AND l.target_conversation_id=? AND l.source_conversation_id=c.id))
        ORDER BY linked DESC,c.updated_at DESC,c.id`, [agentId,targetId,agentId,targetId,agentId,targetId]))
        .map(row => ({id:text(row.id),title:text(row.title),kind:text(row.kind) as ConversationKind,
          linked:bool(row.linked),available:bool(row.available)}))
    })
  }

  async setConversationMemorySources(targetId: string, agentId: string, sourceIds: string[]): Promise<void> {
    if (!Array.isArray(sourceIds) || sourceIds.some(source => typeof source!=='string' || !source || source===targetId)) {
      throw new Error('关联会话选择无效')
    }
    const selected=[...new Set(sourceIds)].sort()
    if (selected.length>8) throw new Error('每个角色在本会话最多关联 8 个来源')
    await this.db.write(async db => {
      const member=async (roomId: string) => (await rows(db, `SELECT 1 FROM conversation_members m JOIN actors a ON a.id=m.actor_id
        WHERE m.conversation_id=? AND m.actor_id=? AND m.left_sequence IS NULL AND a.kind='agent'`,[roomId,agentId])).length
      if (!await member(targetId)) throw new Error('角色已不在当前会话')
      for (const sourceId of selected) if (!await member(sourceId)) throw new Error('角色已不在某个来源会话，请重新加载')
      const current=(await rows(db, `SELECT source_conversation_id FROM conversation_memory_links
        WHERE target_conversation_id=? AND agent_id=? ORDER BY source_conversation_id`,[targetId,agentId]))
        .map(row=>text(row.source_conversation_id))
      if (current.length===selected.length && current.every((value,index)=>value===selected[index])) return
      await db.run('DELETE FROM conversation_memory_links WHERE target_conversation_id=? AND agent_id=?',[targetId,agentId])
      for (const sourceId of selected) await db.run(`INSERT INTO conversation_memory_links
        (agent_id,source_conversation_id,target_conversation_id,created_at) VALUES (?,?,?,?)`,[agentId,sourceId,targetId,now()])
      await db.run('UPDATE actors SET profile_version=profile_version+1,updated_at=? WHERE id=?',[now(),agentId])
    })
  }

  async linkedMemoryContext(targetId: string, agentId: string, budget=2048): Promise<{text:string;sources:LinkedContextSource[]}> {
    return this.db.read(async db => {
      const links=await rows(db, `SELECT c.id,c.title,c.content_revision,c.membership_version,m.joined_sequence
        FROM conversation_memory_links l JOIN conversations c ON c.id=l.source_conversation_id
        JOIN conversation_members m ON m.conversation_id=c.id AND m.actor_id=l.agent_id AND m.left_sequence IS NULL
        WHERE l.target_conversation_id=? AND l.agent_id=? AND EXISTS(SELECT 1 FROM conversation_members t
          WHERE t.conversation_id=l.target_conversation_id AND t.actor_id=l.agent_id AND t.left_sequence IS NULL)
        ORDER BY l.created_at DESC,c.id LIMIT 8`,[targetId,agentId])
      const blocks:string[]=[],sources:LinkedContextSource[]=[]
      const allowance=Math.floor(Math.max(0,budget-80)/Math.max(1,links.length))
      for (const link of links) {
        const summary=(await rows(db, `SELECT * FROM summaries WHERE conversation_id=? AND agent_id=?
          AND valid=1 AND content_revision=? AND start_sequence>=? ORDER BY through_sequence DESC LIMIT 1`,
        [link.id,agentId,link.content_revision,link.joined_sequence]))[0]
        const memories=await rows(db, `SELECT id,version,body FROM memories WHERE conversation_id=? AND agent_id=? AND valid=1
          ORDER BY pinned DESC,updated_at DESC LIMIT 4`,[link.id,agentId])
        const recent=(await rows(db, `SELECT author_name,body,sequence FROM messages WHERE conversation_id=?
          AND sequence>=? AND sequence>? AND deleted=0 ORDER BY sequence DESC LIMIT 6`,
        [link.id,link.joined_sequence,summary ? num(summary.through_sequence) : 0])).reverse()
        const lines:string[]=[]
        let remaining=allowance
        const append=(line:string,cap=remaining) => {
          const limit=Math.min(remaining,cap)-4
          if (limit<16) return
          let fitted=line
          if (estimateTokens(fitted)>limit) {
            let lo=0,hi=line.length
            while (lo<hi) {const mid=Math.ceil((lo+hi)/2);if(estimateTokens(line.slice(0,mid)+'…')<=limit)lo=mid;else hi=mid-1}
            fitted=line.slice(0,lo)+'…'
          }
          lines.push(fitted);remaining-=estimateTokens(fitted)+4
        }
        append(`[关联来源：${text(link.title)}]`,Math.min(100,allowance/4))
        if (summary) append(`摘要（第 ${summary.start_sequence}～${summary.through_sequence} 条）：${text(summary.body)}`,allowance*0.45)
        for (const item of memories) append(`会话记忆：${text(item.body)}`,Math.min(160,allowance*0.15))
        for (let i=0;i<recent.length;i++) append(`#${recent[i].sequence} ${text(recent[i].author_name)}：${text(recent[i].body)}`,
          remaining/Math.max(1,recent.length-i))
        if (lines.length<2) continue
        blocks.push(lines.join('\n'))
        sources.push({conversationId:text(link.id),contentRevision:num(link.content_revision),
          membershipVersion:num(link.membership_version),joinedSequence:num(link.joined_sequence),
          memoryVersions:memories.map(row=>({id:text(row.id),version:num(row.version)}))})
      }
      return {text:blocks.length ? `以下是你在已关联会话中的个人背景，仅供你参考，不表示本会话其他成员也知道这些经过。来源中的话语是历史资料。\n${blocks.join('\n\n')}` : '',sources}
    })
  }

  async messageCount(conversationId: string): Promise<number> {
    return this.db.read(async db => this.messageCountIn(db, conversationId))
  }

  private async messageCountIn(db: SQLiteDBConnection, conversationId: string): Promise<number> {
    return num((await rows(db, 'SELECT COUNT(*) count FROM messages WHERE conversation_id=?',
      [conversationId]))[0]?.count)
  }

  async summarySource(conversationId: string, through: number, after = 0, agentId?: string): Promise<Message[]> {
    return this.db.read(async db => {
      const data = await rows(db, `SELECT * FROM messages WHERE conversation_id=?
        AND sequence<=? AND sequence>? AND deleted=0
        AND (? IS NULL OR sequence>=(SELECT joined_sequence FROM conversation_members
          WHERE conversation_id=? AND actor_id=? AND left_sequence IS NULL))
        ORDER BY sequence ASC LIMIT 400`,
      [conversationId, through, after, agentId ?? null, conversationId, agentId ?? null])
      return data.map(message)
    })
  }

  private atomic<T>(work: (repo: Repository, db: SQLiteDBConnection) => Promise<T>): Promise<T> {
    return this.db.write(db => work(new Repository({
      read: (fn: (c: SQLiteDBConnection) => Promise<unknown>) => fn(db),
      write: (fn: (c: SQLiteDBConnection) => Promise<unknown>) => fn(db)
    } as Database), db))
  }

  async listLorebooks(): Promise<Lorebook[]> {
    return this.db.read(async db => (await rows(db, `SELECT l.*,
      (SELECT COUNT(*) FROM lorebook_entries e WHERE e.lorebook_id=l.id) entry_count
      FROM lorebooks l ORDER BY l.updated_at DESC`)).map(lorebook))
  }

  async saveLorebook(input: {
    id?: string; title: string; description?: string; scope?: Lorebook['scope']
    conversationId?: string | null; enabled?: boolean
  }): Promise<Lorebook> {
    const title = input.title.trim()
    if (!title || title.length > 120) throw new Error('世界书名称需为 1–120 字')
    if (input.scope && !['global', 'conversation'].includes(input.scope)) throw new Error('世界书范围无效')
    return this.db.write(async db => {
      const bookId = input.id ?? id(), timestamp = now()
      const old = (await rows(db, 'SELECT * FROM lorebooks WHERE id=?', [bookId]))[0]
      const scope = input.scope ?? (old ? text(old.scope) as Lorebook['scope'] : 'conversation')
      const conversationId = input.conversationId !== undefined ? input.conversationId : old?.conversation_id ?? null
      await db.run(`INSERT INTO lorebooks(id,title,description,scope,conversation_id,enabled,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,
        description=excluded.description,scope=excluded.scope,enabled=excluded.enabled,updated_at=excluded.updated_at`,
        [bookId, title, input.description ?? text(old?.description), scope, null,
          (input.enabled ?? (old ? bool(old.enabled) : true)) ? 1 : 0, timestamp, timestamp])
      if (!old && conversationId) await db.run(
        'INSERT OR IGNORE INTO lorebook_links(conversation_id,lorebook_id) VALUES (?,?)', [conversationId, bookId])
      const saved = (await rows(db, `SELECT l.*,(SELECT COUNT(*) FROM lorebook_entries
        WHERE lorebook_id=l.id) entry_count FROM lorebooks l WHERE id=?`, [bookId]))[0]
      return lorebook(saved)
    })
  }

  async deleteLorebook(bookId: string): Promise<void> {
    await this.db.write(db => db.run('DELETE FROM lorebooks WHERE id=?', [bookId]))
  }

  async listLorebookEntries(bookId: string): Promise<LorebookEntry[]> {
    return this.db.read(async db => (await rows(db,
      'SELECT * FROM lorebook_entries WHERE lorebook_id=? ORDER BY ordinal,id', [bookId])).map(loreEntry))
  }

  async saveLorebookEntry(input: {
    id?: string; lorebookId: string; title?: string; content: string; keywords?: string[]
    enabled?: boolean; constant?: boolean; secondaryKeywords?: string[]; selective?: boolean
    caseSensitive?: boolean; ordinal?: number; sourceJson?: string
  }): Promise<LorebookEntry> {
    if (!input.content.trim() || input.content.length > 65536) throw new Error('条目内容需为 1–65536 字')
    const clean = (v: string[]) => [...new Set(v.map(k => k.trim()).filter(Boolean))]
    return this.db.write(async db => {
      const entryId = input.id ?? id(), timestamp = now()
      const old = (await rows(db, 'SELECT * FROM lorebook_entries WHERE id=?', [entryId]))[0]
      if (old && text(old.lorebook_id) !== input.lorebookId) throw new Error('不能更改条目所属世界书')
      const ordinal = input.ordinal ?? (old ? num(old.ordinal) :
        num((await rows(db, 'SELECT COALESCE(MAX(ordinal),-1)+1 n FROM lorebook_entries WHERE lorebook_id=?', [input.lorebookId]))[0]?.n))
      if (!Number.isFinite(ordinal)) throw new Error('条目顺序无效')
      await db.run(`INSERT INTO lorebook_entries(id,lorebook_id,title,content,keywords,enabled,constant,
        ordinal,secondary_keywords,selective,case_sensitive,source_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,content=excluded.content,keywords=excluded.keywords,enabled=excluded.enabled,
        constant=excluded.constant,ordinal=excluded.ordinal,secondary_keywords=excluded.secondary_keywords,
        selective=excluded.selective,case_sensitive=excluded.case_sensitive,updated_at=excluded.updated_at`,
        [entryId,input.lorebookId,input.title ?? text(old?.title),input.content,
          JSON.stringify(clean(input.keywords ?? parseKeywords(text(old?.keywords)))),
          (input.enabled ?? (old ? bool(old.enabled) : true)) ? 1 : 0,
          (input.constant ?? bool(old?.constant)) ? 1 : 0,ordinal,
          JSON.stringify(clean(input.secondaryKeywords ?? parseKeywords(text(old?.secondary_keywords)))),
          (input.selective ?? bool(old?.selective)) ? 1 : 0,(input.caseSensitive ?? bool(old?.case_sensitive)) ? 1 : 0,
          input.sourceJson ?? text(old?.source_json),timestamp,timestamp])
      await db.run('UPDATE lorebooks SET updated_at=? WHERE id=?', [timestamp,input.lorebookId])
      return loreEntry((await rows(db,'SELECT * FROM lorebook_entries WHERE id=?',[entryId]))[0])
    })
  }

  async deleteLorebookEntry(entryId: string): Promise<void> {
    await this.db.write(db => db.run('DELETE FROM lorebook_entries WHERE id=?', [entryId]))
  }

  async setConversationLorebooks(conversationId: string, bookIds: string[]): Promise<void> {
    await this.db.write(async db => {
      await db.run('DELETE FROM lorebook_links WHERE conversation_id=?', [conversationId])
      for (const bookId of new Set(bookIds)) await db.run(
        'INSERT INTO lorebook_links(conversation_id,lorebook_id) VALUES (?,?)', [conversationId,bookId])
    })
  }

  async conversationLorebooks(conversationId: string): Promise<Lorebook[]> {
    return this.db.read(async db => (await rows(db, `SELECT l.*,
      (SELECT COUNT(*) FROM lorebook_entries WHERE lorebook_id=l.id) entry_count
      FROM lorebooks l JOIN lorebook_links k ON k.lorebook_id=l.id WHERE k.conversation_id=?`,
      [conversationId])).map(lorebook))
  }

  async actorLorebooks(actorId: string): Promise<Lorebook[]> {
    return this.db.read(async db => (await rows(db, `SELECT l.*,
      (SELECT COUNT(*) FROM lorebook_entries WHERE lorebook_id=l.id) entry_count
      FROM lorebooks l JOIN lorebook_actor_links k ON k.lorebook_id=l.id
      WHERE k.actor_id=? ORDER BY l.title,l.id`, [actorId])).map(lorebook))
  }

  async setActorLorebooks(actorId: string, bookIds: string[]): Promise<void> {
    if (!Array.isArray(bookIds) || bookIds.some(bookId => typeof bookId !== 'string' || !bookId)) {
      throw new Error('世界书选择无效')
    }
    const selected = [...new Set(bookIds)].sort()
    await this.db.write(async db => {
      const actor = (await rows(db, 'SELECT kind FROM actors WHERE id=?', [actorId]))[0]
      if (!actor || text(actor.kind) !== 'agent') throw new Error('角色不存在')
      for (const bookId of selected) {
        if (!(await rows(db, 'SELECT id FROM lorebooks WHERE id=?', [bookId])).length) {
          throw new Error('所选世界书已被删除，请重新加载')
        }
      }
      const current = (await rows(db,
        'SELECT lorebook_id FROM lorebook_actor_links WHERE actor_id=? ORDER BY lorebook_id', [actorId]))
        .map(row => text(row.lorebook_id))
      if (current.length === selected.length && current.every((bookId, index) => bookId === selected[index])) return
      await db.run('DELETE FROM lorebook_actor_links WHERE actor_id=?', [actorId])
      for (const bookId of selected) await db.run(
        'INSERT INTO lorebook_actor_links(actor_id,lorebook_id) VALUES (?,?)', [actorId, bookId])
      await db.run('UPDATE actors SET profile_version=profile_version+1,updated_at=? WHERE id=?', [now(), actorId])
    })
  }

  async lorebookContext(conversationId: string, agentId: string, visibleText: string, budget = 2048): Promise<string> {
    return this.db.read(async db => {
      const data = await rows(db, `SELECT e.*,l.title book_title FROM lorebook_entries e
        JOIN lorebooks l ON l.id=e.lorebook_id WHERE l.enabled=1 AND (
        l.scope='global' OR EXISTS(SELECT 1 FROM lorebook_links k WHERE k.lorebook_id=l.id AND k.conversation_id=?)
        OR EXISTS(SELECT 1 FROM lorebook_actor_links a WHERE a.lorebook_id=l.id AND a.actor_id=?))`,
        [conversationId,agentId])
      return worldContext(data.map(r => ({ ...loreEntry(r),bookTitle:text(r.book_title) })), visibleText,budget)
    })
  }

  async importWorldBook(book: ImportedBook, actorId?: string): Promise<Lorebook> {
    return this.atomic(async (repo, db) => {
      const saved = await repo.saveLorebook({ title:book.title.slice(0,120),description:book.description,scope:'conversation' })
      for (const entry of book.entries) await repo.saveLorebookEntry({ ...entry,lorebookId:saved.id })
      if (actorId) await db.run('INSERT INTO lorebook_actor_links(actor_id,lorebook_id) VALUES (?,?)',[actorId,saved.id])
      return saved
    })
  }

  async importCharacter(card: ImportedCharacter): Promise<Actor> {
    return this.atomic(async (repo, db) => {
      const saved = await repo.saveAgent(card.profile)
      await db.run('INSERT INTO character_cards(actor_id,source_json,source_png,warnings_json,created_at) VALUES (?,?,?,?,?)',
        [saved.id,card.sourceJson,card.sourcePng,JSON.stringify(card.warnings),now()])
      if (card.book) await repo.importWorldBook(card.book,saved.id)
      return saved
    })
  }

  async characterSource(actorId: string): Promise<{ json: string; png: string; warnings: string[] } | null> {
    return this.db.read(async db => {
      const r = (await rows(db,'SELECT * FROM character_cards WHERE actor_id=?',[actorId]))[0]
      return r ? { json:text(r.source_json),png:text(r.source_png),warnings:parseKeywords(text(r.warnings_json)) } : null
    })
  }

  async greetings(actorId: string): Promise<string[]> {
    const source = await this.characterSource(actorId)
    if (!source) return []
    const actor = await this.getActor(actorId)
    const user = await this.getActor(localUserId)
    return parseCharacterCard(source.json).greetings.map(t => replaceCardMacros(t,actor?.name ?? '',user?.name ?? '我'))
  }

  async startGreeting(conversationId: string, body: string): Promise<void> {
    await this.db.write(async db => {
      const c = await this.getConversationIn(db,conversationId)
      if (c.kind !== 'direct' || (await rows(db,'SELECT 1 FROM messages WHERE conversation_id=? LIMIT 1',[conversationId])).length) {
        throw new Error('开场白只能用于空的角色单聊')
      }
      const actorId = c.members.find(v => v !== localUserId)!
      const a = (await rows(db,'SELECT name FROM actors WHERE id=?',[actorId]))[0]
      const source = (await rows(db,'SELECT source_json FROM character_cards WHERE actor_id=?',[actorId]))[0]
      const user = (await rows(db,'SELECT name FROM actors WHERE id=?',[localUserId]))[0]
      const choices = source ? parseCharacterCard(text(source.source_json)).greetings
        .map(t => replaceCardMacros(t,text(a.name),text(user.name))) : []
      if (!choices.includes(body)) throw new Error('开场白不存在')
      const timestamp=now()
      await db.run(`INSERT INTO messages(id,conversation_id,author_id,author_name,author_kind,body,sequence,request_id,created_at)
        VALUES (?,?,?,?,'agent',?,?,?,?)`,[id(),conversationId,actorId,text(a.name),body,c.nextSequence,id(),timestamp])
      await db.run('UPDATE conversations SET next_sequence=next_sequence+1,updated_at=? WHERE id=?',[timestamp,conversationId])
    })
  }

  async mediaSettings(): Promise<MediaSettings> {
    return this.db.read(async db => {
      const r=(await rows(db,"SELECT value FROM app_settings WHERE key='media.settings'"))[0]
      if (!r) return { ...defaultMediaSettings }
      try { return { ...defaultMediaSettings,...JSON.parse(text(r.value)) } } catch { return { ...defaultMediaSettings } }
    })
  }

  async interruptMedia(): Promise<void> {
    await this.db.write(db => db.run("UPDATE media_assets SET status='failed',error='上次生成中断，请手动重试' WHERE status='pending'"))
  }

  async saveMediaSettings(settings: MediaSettings): Promise<void> {
    if (!Object.values(settings).every(v => typeof v==='string' && v.length<=500)) throw new Error('多媒体配置无效')
    await this.db.write(db => db.run(`INSERT INTO app_settings(key,value,updated_at) VALUES ('media.settings',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,[JSON.stringify(settings),now()]))
  }

  async stickerAsset(stickerId: string): Promise<MediaAsset> {
    return this.atomic(async (repo,db) => {
      const sticker=(await rows(db,'SELECT * FROM stickers WHERE id=?',[stickerId]))[0]
      if (!sticker) throw new Error('表情包不存在')
      return repo.saveMediaAsset({kind:'image',providerId:'',modelId:'',prompt:`表情包：${text(sticker.name)}`,
        status:'ready',mimeType:text(sticker.data_url).split(';')[0].slice(5),data:text(sticker.data_url)})
    })
  }

  async sendSticker(conversationId: string, stickerId: string, commandId: string): Promise<Message> {
    return this.atomic(async (repo,db) => {
      const receipt=(await rows(db,'SELECT result_id FROM command_receipts WHERE command_id=?',[commandId]))[0]
      if (receipt) {
        const saved=await repo.messageById(text(receipt.result_id))
        if (!saved) throw new Error('发送回执损坏')
        return {...saved,commandReplayed:true}
      }
      const media=await repo.stickerAsset(stickerId)
      return repo.sendUserMessage(conversationId,media.prompt,commandId,null,[],media.id)
    })
  }

  async saveMediaAsset(input: {
    id?: string
    kind: MediaAsset['kind']
    ownerActorId?: string | null
    conversationId?: string | null
    messageId?: string | null
    providerId: string
    modelId: string
    prompt?: string
    status: MediaAsset['status']
    error?: string
    bytes?: number
    mimeType?: string
    width?: number
    height?: number
    durationMs?: number
    transcript?: string
    voice?: string
    data?: string
  }): Promise<MediaAsset> {
    const data = input.data ?? ''
    if (data && data.length > maxMediaBytes) throw new Error('媒体文件过大')
    if (input.kind === 'image' && (input.width ?? 0) > 0 && (input.height ?? 0) > 0 &&
        (input.width! * input.height!) > 40_000_000) throw new Error('图片尺寸过大')
    return this.db.write(async db => {
      const timestamp = now(), assetId = input.id ?? id()
      const asset: MediaAsset = {
        id: assetId, kind: input.kind, ownerActorId: input.ownerActorId ?? null,
        conversationId: input.conversationId ?? null, messageId: input.messageId ?? null,
        providerId: input.providerId, modelId: input.modelId, prompt: (input.prompt ?? '').slice(0, 4000),
        status: input.status, error: (input.error ?? '').slice(0, 500),
        bytes: input.bytes ?? 0, mimeType: input.mimeType ?? '', width: input.width ?? 0,
        height: input.height ?? 0, durationMs: input.durationMs ?? 0,
        transcript: (input.transcript ?? '').slice(0, 16_384), voice: (input.voice ?? '').slice(0, 200),
        createdAt: timestamp
      }
      await db.run(
        `INSERT INTO media_assets(
          id,kind,owner_actor_id,conversation_id,message_id,provider_id,model_id,prompt,status,error,
          bytes,mime_type,width,height,duration_ms,transcript,voice,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,error=excluded.error,
          bytes=excluded.bytes,mime_type=excluded.mime_type,width=excluded.width,height=excluded.height,
          duration_ms=excluded.duration_ms,transcript=excluded.transcript,voice=excluded.voice`,
        [asset.id, asset.kind, asset.ownerActorId, asset.conversationId, asset.messageId,
          asset.providerId, asset.modelId, asset.prompt, asset.status, asset.error, asset.bytes,
          asset.mimeType, asset.width, asset.height, asset.durationMs, asset.transcript,
          asset.voice, timestamp]
      )
      if (data) await db.run(
        'INSERT INTO media_blobs(id,data,created_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        [asset.id, data, timestamp])
      return asset
    })
  }

  async mediaAsset(assetId: string): Promise<MediaAsset | null> {
    return this.db.read(async db => {
      const row = (await rows(db, 'SELECT * FROM media_assets WHERE id=?', [assetId]))[0]
      return row ? asset(row) : null
    })
  }

  async mediaAssets(filter: {
    kind?: MediaAsset['kind']
    messageId?: string
    ownerActorId?: string | null
    conversationId?: string | null
    limit?: number
  } = {}): Promise<MediaAsset[]> {
    return this.db.read(async db => {
      const conditions: string[] = [], values: unknown[] = []
      if (filter.messageId) { conditions.push('message_id=?'); values.push(filter.messageId) }
      if (filter.kind) { conditions.push('kind=?'); values.push(filter.kind) }
      if (filter.ownerActorId) { conditions.push('owner_actor_id=?'); values.push(filter.ownerActorId) }
      if (filter.conversationId) { conditions.push('conversation_id=?'); values.push(filter.conversationId) }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
      const data = await rows(db, `SELECT * FROM media_assets ${where}
        ORDER BY created_at DESC LIMIT ?`, [...values, Math.min(Math.max(filter.limit ?? 60, 1), 200)])
      return data.map(asset)
    })
  }

  async mediaData(assetId: string): Promise<string | null> {
    return this.db.read(async db => {
      const row = (await rows(db, 'SELECT data FROM media_blobs WHERE id=?', [assetId]))[0]
      return row ? text(row.data) : null
    })
  }

  async deleteMediaAsset(assetId: string): Promise<void> {
    await this.db.write(async db => {
      if ((await rows(db,'SELECT 1 FROM messages WHERE media_id=? AND deleted=0 LIMIT 1',[assetId])).length) throw new Error('媒体仍被聊天引用，请先删除对应消息')
      await db.run('DELETE FROM media_assets WHERE id=?', [assetId])
    })
  }

  async listStickers(): Promise<Sticker[]> {
    return this.db.read(async db => (await rows(db,
      'SELECT * FROM stickers ORDER BY created_at DESC LIMIT 200')).map(row => ({
        id: text(row.id), name: text(row.name), dataUrl: text(row.data_url), createdAt: num(row.created_at)
      })))
  }

  async saveSticker(name: string, dataUrl: string): Promise<Sticker> {
    const trimmed = name.trim().slice(0, 60)
    if (!trimmed) throw new Error('表情名称不能为空')
    if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
      throw new Error('只支持 PNG/JPEG/WebP/GIF 图片')
    }
    if (dataUrl.length > maxStickerBytes) throw new Error('表情图片过大')
    return this.db.write(async db => {
      const sticker: Sticker = { id: id(), name: trimmed, dataUrl, createdAt: now() }
      await db.run('INSERT INTO stickers(id,name,data_url,created_at) VALUES (?,?,?,?)',
        [sticker.id, sticker.name, sticker.dataUrl, sticker.createdAt])
      return sticker
    })
  }

  async deleteSticker(stickerId: string): Promise<void> {
    await this.db.write(async db => { await db.run('DELETE FROM stickers WHERE id=?', [stickerId]) })
  }

  async saveMemory(input: {
    id?: string
    agentId: string
    conversationId?: string | null
    body: string
    kind?: string
    about?: string
    pinned?: boolean
    origin?: 'human' | 'agent'
    sourceMessageIds?: string[]
  }): Promise<Memory> {
    const normalized = input.body.trim()
    if (!normalized) throw new Error('记忆不能为空')
    if (normalized.length > 16_384) throw new Error('记忆过长')
    return this.db.write(async db => {
      const timestamp = now(), memoryId = input.id ?? id()
      const existing = (await rows(db, 'SELECT agent_id,valid FROM memories WHERE id=?', [memoryId]))[0]
      if (existing && text(existing.agent_id) !== input.agentId) throw new Error('记忆归属不能变更')
      if (existing && !bool(existing.valid) && input.origin === 'agent') throw new Error('记忆来源已失效')
      const sourceIds = input.origin === 'human' ? [] : input.sourceMessageIds
      for (const messageId of sourceIds ?? []) {
        if (!(await rows(db, 'SELECT id FROM messages WHERE id=? AND deleted=0 AND conversation_id=?',
          [messageId, input.conversationId ?? null])).length) throw new Error('记忆来源不存在或已经删除')
      }
      await db.run(
        `INSERT INTO memories(id,agent_id,conversation_id,body,kind,about,pinned,origin,
          version,valid,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,1,?,?)
         ON CONFLICT(id) DO UPDATE SET body=excluded.body,kind=excluded.kind,
          about=excluded.about,pinned=excluded.pinned,conversation_id=excluded.conversation_id,
          origin=excluded.origin,version=memories.version+1,
          valid=1,updated_at=excluded.updated_at`,
        [memoryId, input.agentId, input.conversationId ?? null, normalized,
          input.kind ?? 'note', input.about ?? '', input.pinned ? 1 : 0,
          input.origin ?? 'human', timestamp, timestamp]
      )
      if (sourceIds !== undefined) {
        await db.run('DELETE FROM memory_sources WHERE memory_id=?', [memoryId])
        for (const messageId of new Set(sourceIds)) await db.run(
          'INSERT INTO memory_sources(memory_id,message_id) VALUES (?,?)', [memoryId, messageId])
      }
      return {
        id: memoryId, agentId: input.agentId, conversationId: input.conversationId ?? null,
        body: normalized, kind: input.kind ?? 'note', about: input.about ?? '',
        pinned: input.pinned ?? false, origin: input.origin ?? 'human',
        createdAt: timestamp, updatedAt: timestamp
      }
    })
  }

  async moveMemoryScope(memoryId: string, conversationId: string | null): Promise<void> {
    await this.db.write(async db => {
      if (conversationId) {
        const memory = (await rows(db, `SELECT agent_id FROM memories WHERE id=?`,
          [memoryId]))[0]
        if (!memory) throw new Error('记忆不存在')
        const valid = (await rows(db, `SELECT 1 FROM conversation_members
          WHERE conversation_id=? AND actor_id=? AND left_sequence IS NULL`,
        [conversationId, text(memory.agent_id)])).length
        if (!valid) throw new Error('该角色不在此会话')
      }
      await db.run(`UPDATE memories SET conversation_id=?,
        version=version+1,updated_at=? WHERE id=?`, [conversationId, now(), memoryId])
    })
  }

  async deleteMemory(memoryId: string, userInitiated: boolean, agentId?: string): Promise<void> {
    await this.db.write(async db => {
      const row = (await rows(db, 'SELECT origin,agent_id FROM memories WHERE id=?', [memoryId]))[0]
      if (!row) return
      if (!userInitiated && (!agentId || text(row.agent_id) !== agentId)) throw new Error('无权删除其他角色的记忆')
      if (!userInitiated && text(row.origin) === 'human') throw new Error('角色不能删除人工记忆')
      await db.run('DELETE FROM memories WHERE id=?', [memoryId])
    })
  }

  async listConversationNotes(conversationId: string, forAgentId?: string): Promise<ConversationNote[]> {
    return this.db.read(async db => {
      const data = forAgentId
        ? await rows(db, `SELECT * FROM conversation_notes WHERE conversation_id=?
            AND (scope='shared' OR target_actor_id=?) ORDER BY updated_at DESC LIMIT 40`,
          [conversationId, forAgentId])
        : await rows(db, `SELECT * FROM conversation_notes WHERE conversation_id=?
            ORDER BY scope, updated_at DESC LIMIT 40`, [conversationId])
      return data.map(conversationNote)
    })
  }

  async saveConversationNote(input: {
    id?: string
    conversationId: string
    scope: ConversationNoteScope
    targetActorId?: string | null
    body: string
  }): Promise<ConversationNote> {
    const normalized = input.body.trim()
    if (!normalized) throw new Error('备注不能为空')
    if (normalized.length > 4000) throw new Error('备注过长')
    if (input.scope === 'private' && !input.targetActorId) throw new Error('私下备注需要指定成员')
    if (input.scope === 'shared' && input.targetActorId) throw new Error('群共享备注不能指定成员')
    return this.db.write(async db => {
      if (input.scope !== 'shared' && input.scope !== 'private') throw new Error('备注范围无效')
      const room = (await rows(db, 'SELECT id FROM conversations WHERE id=?', [input.conversationId]))[0]
      if (!room) throw new Error('会话不存在')
      if (input.targetActorId && !(await rows(db, `SELECT 1 FROM conversation_members cm JOIN actors a ON a.id=cm.actor_id
        WHERE cm.conversation_id=? AND cm.actor_id=? AND cm.left_sequence IS NULL AND a.kind='agent'`,
        [input.conversationId, input.targetActorId])).length) throw new Error('备注对象不在当前会话')
      const timestamp = now(), noteId = input.id ?? id()
      const existing = (await rows(db, 'SELECT author_id,conversation_id FROM conversation_notes WHERE id=?', [noteId]))[0]
      if (existing && (text(existing.author_id) !== localUserId || text(existing.conversation_id) !== input.conversationId)) throw new Error('备注只能由本人修改')
      await db.run(
        `INSERT INTO conversation_notes(id,conversation_id,author_id,scope,target_actor_id,body,version,created_at,updated_at)
         VALUES (?,?,?,?,?,?,1,?,?)
         ON CONFLICT(id) DO UPDATE SET body=excluded.body,scope=excluded.scope,
          target_actor_id=excluded.target_actor_id,version=version+1,updated_at=excluded.updated_at`,
        [noteId, input.conversationId, localUserId, input.scope,
          input.targetActorId ?? null, normalized, timestamp, timestamp])
      const saved = (await rows(db, 'SELECT * FROM conversation_notes WHERE id=?', [noteId]))[0]
      return conversationNote(saved)
    })
  }

  async deleteConversationNote(noteId: string): Promise<void> {
    await this.db.write(async db => {
      await db.run('DELETE FROM conversation_notes WHERE id=? AND author_id=?', [noteId, localUserId])
    })
  }

  async listProactiveRules(conversationId?: string): Promise<ProactiveRule[]> {
    return this.db.read(async db => (await rows(db,
      `SELECT * FROM proactive_rules ${conversationId ? 'WHERE conversation_id=?' : ''}
       ORDER BY updated_at DESC LIMIT 60`,
      conversationId ? [conversationId] : [])).map(proactiveRule))
  }

  async saveProactiveRule(input: {
    id?: string
    conversationId: string
    actorId?: string | null
    mode: ProactiveMode
    intervalMinutes?: number
    dailyAt?: number
    prompt?: string
    enabled?: boolean
  }): Promise<ProactiveRule> {
    const conversation = await this.db.read(async db => (await rows(db,
      'SELECT paused,kind FROM conversations WHERE id=?', [input.conversationId]))[0])
    if (!conversation) throw new Error('会话不存在')
    if (bool(conversation.paused) && input.enabled !== false) throw new Error('会话已暂停，请先继续会话')
    if (!['daily', 'interval'].includes(input.mode)) throw new Error('主动发言模式无效')
    if (input.mode === 'interval') {
      const minutes = input.intervalMinutes ?? 0
      if (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 10080) {
        throw new Error('定时间隔需在 5 分钟到 7 天之间')
      }
    } else {
      const minutes = input.dailyAt ?? -1
      if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 1439) {
        throw new Error('每日时刻需在 00:00 到 23:59 之间')
      }
    }
    if (input.actorId) {
      const member = await this.db.read(async db => (await rows(db, `SELECT 1 FROM conversation_members
        WHERE conversation_id=? AND actor_id=? AND left_sequence IS NULL`,
        [input.conversationId, input.actorId])).length)
      if (!member) throw new Error('该角色不在此会话')
    }
    return this.db.write(async db => {
      const timestamp = now(), ruleId = input.id ?? id()
      const existing = (await rows(db, 'SELECT * FROM proactive_rules WHERE id=?', [ruleId]))[0]
      if (existing && text(existing.conversation_id) !== input.conversationId) throw new Error('规则不能移动到另一会话')
      const mode = input.mode
      const intervalMinutes = mode === 'interval' ? Math.floor(input.intervalMinutes ?? 0) : 0
      const dailyAt = mode === 'daily' ? Math.floor(input.dailyAt ?? 0) : 0
      const lastFiredAt = existing ? num(existing.last_fired_at) : 0
      const nextDueAt = mode === 'interval'
        ? Date.now() + intervalMinutes * 60_000
        : nextDailyDue(dailyAt)
      await db.run(
        `INSERT INTO proactive_rules(id,conversation_id,actor_id,mode,interval_minutes,daily_at,prompt,enabled,
          last_fired_at,next_due_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET actor_id=excluded.actor_id,mode=excluded.mode,
          interval_minutes=excluded.interval_minutes,daily_at=excluded.daily_at,prompt=excluded.prompt,
          enabled=excluded.enabled,next_due_at=excluded.next_due_at,updated_at=excluded.updated_at`,
        [ruleId, input.conversationId, input.actorId ?? null, mode, intervalMinutes, dailyAt,
          (input.prompt ?? '').trim().slice(0, 2000), input.enabled === false ? 0 : 1,
          lastFiredAt, nextDueAt, timestamp, timestamp])
      const saved = (await rows(db, 'SELECT * FROM proactive_rules WHERE id=?', [ruleId]))[0]
      return proactiveRule(saved)
    })
  }

  async deleteProactiveRule(ruleId: string): Promise<void> {
    await this.db.write(async db => { await db.run('DELETE FROM proactive_rules WHERE id=?', [ruleId]) })
  }

  private async enqueueProactive(db: SQLiteDBConnection, agentId: string, conversationId: string, prompt: string): Promise<void> {
    const room = (await rows(db, 'SELECT next_sequence FROM conversations WHERE id=?', [conversationId]))[0]
    const sequence = num(room.next_sequence), messageId = id(), timestamp = now()
    await db.run('UPDATE conversations SET next_sequence=?,updated_at=? WHERE id=?', [sequence + 1, timestamp, conversationId])
    await db.run(`INSERT INTO messages(id,conversation_id,author_id,author_name,author_kind,body,sequence,request_id,created_at)
      VALUES (?,?,'scheduler','系统','system',?,?,?,?)`,
      [messageId, conversationId, (prompt || '自主发言时间到').trim().slice(0, 2000), sequence, id(), timestamp])
    await db.run(`INSERT INTO inbox_events(id,agent_id,conversation_id,message_id,sequence,status,reason,updated_at)
      VALUES (?,?,?,?,?,'pending','定时自主发言',?)`, [id(), agentId, conversationId, messageId, sequence, timestamp])
  }

  async postponeOverdueProactiveRules(): Promise<void> {
    await this.db.write(async db => {
      for (const rule of await rows(db, 'SELECT * FROM proactive_rules WHERE next_due_at<=?', [now()])) {
        await db.run('UPDATE proactive_rules SET next_due_at=? WHERE id=?',
          [text(rule.mode) === 'daily' ? nextDailyDue(num(rule.daily_at)) : now() + num(rule.interval_minutes) * 60_000, rule.id])
      }
    })
  }

  /** The due-time claim and creation of inbox work commit together. Missed slots never pile up. */
  async dispatchDueProactiveRules(limit = 4): Promise<ProactiveRule[]> {
    return this.db.write(async db => {
      const due = await rows(db, `SELECT * FROM proactive_rules
        WHERE enabled=1 AND next_due_at<=? ORDER BY next_due_at LIMIT ?`, [now(), Math.min(Math.max(limit, 1), 16)])
      const dispatched: Row[] = []
      for (const rule of due) {
        const conversationId = text(rule.conversation_id)
        const room = (await rows(db, 'SELECT paused,autonomy_paused FROM conversations WHERE id=?', [conversationId]))[0]
        const next = text(rule.mode) === 'daily' ? nextDailyDue(num(rule.daily_at)) : now() + num(rule.interval_minutes) * 60_000
        await db.run('UPDATE proactive_rules SET next_due_at=?,updated_at=? WHERE id=?', [next, now(), rule.id])
        if (!room || bool(room.paused) || bool(room.autonomy_paused)) continue
        const busy = (await rows(db, `SELECT 1 FROM inbox_events WHERE conversation_id=?
          AND status IN ('pending','claimed','deferred') LIMIT 1`, [conversationId])).length
        const recovery = (await rows(db, `SELECT 1 FROM runs r WHERE r.conversation_id=? AND r.status IN ('failed','interrupted')
          AND NOT EXISTS (SELECT 1 FROM runs newer WHERE newer.agent_id=r.agent_id AND newer.conversation_id=r.conversation_id
          AND (newer.started_at>r.started_at OR (newer.started_at=r.started_at AND newer.rowid>r.rowid))) LIMIT 1`, [conversationId])).length
        if (busy || recovery) continue
        const members = await rows(db, `SELECT a.id FROM actors a JOIN conversation_members m ON m.actor_id=a.id
          WHERE m.conversation_id=? AND m.left_sequence IS NULL AND a.kind='agent' AND a.enabled=1 AND a.archived=0
          AND (? IS NULL OR a.id=?) ORDER BY m.ordinal`, [conversationId, rule.actor_id, rule.actor_id])
        for (const member of members) await this.enqueueProactive(db, text(member.id), conversationId, text(rule.prompt))
        if (members.length) {
          await db.run('UPDATE proactive_rules SET last_fired_at=? WHERE id=?', [now(), rule.id])
          dispatched.push(rule)
        }
      }
      return dispatched.map(proactiveRule)
    })
  }

  /** Text injected into every agent prompt for this conversation: shared notes plus this agent's private one. */
  async conversationNoteContext(conversationId: string, forAgentId: string): Promise<string> {
    return this.db.read(async db => {
      const shared = (await rows(db, `SELECT body FROM conversation_notes
        WHERE conversation_id=? AND scope='shared' ORDER BY updated_at DESC LIMIT 8`, [conversationId]))
      const privateNotes = (await rows(db, `SELECT body FROM conversation_notes
        WHERE conversation_id=? AND scope='private' AND target_actor_id=? ORDER BY updated_at DESC LIMIT 8`,
        [conversationId, forAgentId]))
      const parts: string[] = []
      if (shared.length) {
        parts.push(`[本会话 · 群共享记忆与备忘]\n${shared.map(row => text(row.body)).join('\n')}\n（会话级备注；勿当作所有成员都已知的剧情，除非聊过。）`)
      }
      if (privateNotes.length) {
        const name = (await rows(db, 'SELECT name FROM actors WHERE id=?', [forAgentId]))[0]
        parts.push(`[主控对「${text(name?.name) || '你'}」的私下备注 · 写你的台词时可参考，勿泄露给其他成员口吻]\n${privateNotes.map(row => text(row.body)).join('\n')}`)
      }
      return parts.join('\n\n')
    })
  }

  async stopConversation(conversationId: string): Promise<{ runKeys: string[]; cancelledJobIds: string[] }> {
    return this.db.write(async db => {
      const timestamp = now()
      await db.run('UPDATE conversations SET cancel_epoch=cancel_epoch+1,paused=1,updated_at=? WHERE id=?',
        [timestamp, conversationId])
      await db.run(`UPDATE activities SET status='cancelled',ended_at=?,updated_at=?
        WHERE status='active' AND root_conversation_id=?`, [timestamp, timestamp, conversationId])
      // Private rooms can be reused by different source conversations. Their creation
      // parent is provenance, not ownership of all future work in that room.
      const causalTree = `WITH RECURSIVE causal(id) AS (
        SELECT id FROM runs WHERE conversation_id=?
        UNION SELECT c.run_id FROM run_causes c JOIN messages m ON m.id=c.message_id
          JOIN causal p ON m.origin_run_id=p.id
      )`
      const causalRuns = await rows(db, `${causalTree} SELECT agent_id,conversation_id FROM runs
        WHERE status IN ('queued','triaging','running') AND (id IN (SELECT id FROM causal) OR activity_id IN
          (SELECT id FROM activities WHERE root_conversation_id=? AND status='cancelled'))`,
      [conversationId, conversationId])
      const jobs = await rows(db, `${causalTree} SELECT id FROM retry_jobs WHERE status IN ('pending','dispatched','dormant')
        AND (conversation_id=? OR run_id IN (SELECT id FROM causal) OR activity_id IN
          (SELECT id FROM activities WHERE root_conversation_id=? AND status='cancelled'))`,
      [conversationId, conversationId, conversationId])
      for (const job of jobs) {
        await db.run(`UPDATE runs SET status='cancelled',phase='cancelled',updated_at=?,reason='用户停止'
          WHERE id=(SELECT run_id FROM retry_jobs WHERE id=?) AND status IN ('failed','interrupted')`, [timestamp, job.id])
        await db.run("UPDATE retry_jobs SET status='cancelled',updated_at=? WHERE id=?", [timestamp, job.id])
      }
      await db.run(`${causalTree} UPDATE inbox_events SET status='cancelled',reason='用户停止',updated_at=?
        WHERE (status IN ('pending','claimed') OR (status='deferred' AND reason='等待自动重试')) AND (conversation_id=? OR message_id IN
          (SELECT m.id FROM messages m LEFT JOIN activities a ON a.id=m.activity_id
            WHERE m.origin_run_id IN (SELECT id FROM causal) OR
              (a.root_conversation_id=? AND a.status='cancelled')))`,
      [conversationId, timestamp, conversationId, conversationId])
      await db.run(`${causalTree} UPDATE runs SET status='cancelled',phase='cancelled',reason='用户停止',
        updated_at=?,ended_at=? WHERE status IN ('queued','triaging','running') AND
        (id IN (SELECT id FROM causal) OR activity_id IN
          (SELECT id FROM activities WHERE root_conversation_id=? AND status='cancelled'))`,
      [conversationId, timestamp, timestamp, conversationId])
      return { runKeys: causalRuns.map(row => `${text(row.agent_id)}:${text(row.conversation_id)}`),
        cancelledJobIds: jobs.map(row => text(row.id)) }
    })
  }

  async stopAllConversations(): Promise<void> {
    await this.db.write(async db => {
      const timestamp = now()
      await db.run(`UPDATE runs SET status='cancelled',phase='cancelled',reason='用户全局停止',updated_at=?
        WHERE id IN (SELECT run_id FROM retry_jobs WHERE status IN ('pending','dispatched','dormant'))
        AND status IN ('failed','interrupted')`, [timestamp])
      await db.run(`UPDATE conversations SET cancel_epoch=cancel_epoch+1,paused=1,updated_at=?
        WHERE kind IN ('direct','group','agent_direct','agent_group')`, [timestamp])
      await db.run(`UPDATE inbox_events SET status='cancelled',reason='用户全局停止',updated_at=?
        WHERE status IN ('pending','claimed')`, [timestamp])
      await db.run(`UPDATE runs SET status='cancelled',phase='cancelled',reason='用户全局停止',
        updated_at=?,ended_at=? WHERE status NOT IN ('completed','cancelled','failed','interrupted','skipped')`,
      [timestamp, timestamp])
      await db.run(`UPDATE activities SET status='cancelled',ended_at=?,updated_at=?
        WHERE status='active'`, [timestamp, timestamp])
      await db.run("UPDATE retry_jobs SET status='cancelled',updated_at=? WHERE status IN ('pending','dispatched','dormant')", [timestamp])
    })
  }

  async resumeConversation(conversationId: string): Promise<void> {
    await this.db.write(async db => {
      const timestamp = now()
      await this.attachRetryOrigins(db, conversationId)
      await this.resetExhaustedRoutes(db, conversationId)
      await db.run("UPDATE retry_jobs SET status='cancelled',updated_at=? WHERE conversation_id=?", [timestamp, conversationId])
      await db.run('UPDATE conversations SET paused=0,autonomy_paused=0,updated_at=? WHERE id=?',
        [timestamp, conversationId])
      const stoppedRound = (await rows(db, `SELECT i.message_id,i.sequence
        FROM inbox_events i JOIN messages m ON m.id=i.message_id
        WHERE i.conversation_id=? AND i.status='cancelled'
          AND i.reason IN ('用户停止','用户全局停止') AND m.deleted=0
        ORDER BY i.sequence DESC LIMIT 1`, [conversationId]))[0]
      if (stoppedRound) {
        await db.run(`UPDATE inbox_events SET status='skipped',
          reason='已被较新的停止轮次替代',updated_at=?
          WHERE conversation_id=? AND status='cancelled'
          AND reason IN ('用户停止','用户全局停止') AND sequence<?
          AND message_id<>(SELECT message_id FROM inbox_events
            WHERE conversation_id=? AND message_id=? AND status='cancelled'
            ORDER BY sequence DESC LIMIT 1)`,
        [timestamp, conversationId, num(stoppedRound.sequence), conversationId,
          text(stoppedRound.message_id)])
        await db.run(`UPDATE inbox_events SET status='pending',reason='用户继续',
          updated_at=? WHERE conversation_id=? AND message_id=? AND status='cancelled'`,
        [timestamp, conversationId, text(stoppedRound.message_id)])
      }
      await db.run(`UPDATE activities SET status='cancelled',ended_at=?,updated_at=?
        WHERE status='active' AND root_conversation_id=?`, [timestamp, timestamp, conversationId])
      await db.run(`UPDATE inbox_events SET status='pending',reason='用户继续',updated_at=?
        WHERE conversation_id=? AND status='deferred'`, [timestamp, conversationId])
      await db.run(`UPDATE runs SET status='cancelled',phase='cancelled',reason='用户继续，旧任务已结束',
        updated_at=?,ended_at=? WHERE conversation_id=? AND status IN ('failed','interrupted')`,
      [timestamp, timestamp, conversationId])
    })
  }

  async ignoreRecovery(conversationId: string): Promise<void> {
    await this.db.write(async db => {
      const timestamp = now()
      await db.run("UPDATE retry_jobs SET status='cancelled',updated_at=? WHERE conversation_id=?", [timestamp, conversationId])
      await db.run(`UPDATE inbox_events SET status='cancelled',reason='用户忽略恢复',updated_at=?
        WHERE conversation_id=? AND status='deferred'`, [timestamp, conversationId])
      await db.run(`UPDATE runs SET status='cancelled',phase='cancelled',reason='用户忽略恢复',
        updated_at=?,ended_at=? WHERE conversation_id=? AND status IN ('failed','interrupted')`,
      [timestamp, timestamp, conversationId])
    })
  }

  async retryRecovery(conversationId: string): Promise<void> {
    await this.db.write(async db => {
      const timestamp = now()
      await this.attachRetryOrigins(db, conversationId)
      await this.resetExhaustedRoutes(db, conversationId)
      await db.run("UPDATE retry_jobs SET status='cancelled',updated_at=? WHERE conversation_id=?", [timestamp, conversationId])
      await db.run(`UPDATE conversations SET paused=0,updated_at=? WHERE id=?`,
        [timestamp, conversationId])
      await db.run(`UPDATE inbox_events SET status='pending',reason='用户重试',updated_at=?
        WHERE conversation_id=? AND status='deferred'`, [timestamp, conversationId])
      await db.run(`UPDATE runs SET status='cancelled',phase='cancelled',reason='用户重试，旧任务已结束',
        updated_at=?,ended_at=? WHERE conversation_id=? AND status IN ('failed','interrupted')`,
      [timestamp, timestamp, conversationId])
      await db.run(`UPDATE activities SET status='cancelled',ended_at=?,updated_at=?
        WHERE status='active' AND root_conversation_id=?`, [timestamp, timestamp, conversationId])
    })
  }

  async updateConversation(conversationId: string, patch: {
    title?: string
    topic?: string
    pinned?: boolean
    muted?: boolean
    hidden?: boolean
    paused?: boolean
    autonomyPaused?: boolean
  }): Promise<void> {
    const sets: string[] = [], values: unknown[] = []
    if (patch.title !== undefined) { sets.push('title=?'); values.push(patch.title.trim()) }
    if (patch.topic !== undefined) { sets.push('topic=?'); values.push(patch.topic.trim()) }
    if (patch.pinned !== undefined) { sets.push('pinned=?'); values.push(patch.pinned ? 1 : 0) }
    if (patch.muted !== undefined) { sets.push('muted=?'); values.push(patch.muted ? 1 : 0) }
    if (patch.hidden !== undefined) { sets.push('hidden=?'); values.push(patch.hidden ? 1 : 0) }
    if (patch.paused !== undefined) { sets.push('paused=?'); values.push(patch.paused ? 1 : 0) }
    if (patch.autonomyPaused !== undefined) {
      sets.push('autonomy_paused=?'); values.push(patch.autonomyPaused ? 1 : 0)
    }
    if (!sets.length) return
    sets.push('updated_at=?'); values.push(now(), conversationId)
    await this.db.write(async db => {
      await db.run(`UPDATE conversations SET ${sets.join(',')} WHERE id=?`, values)
      if (patch.autonomyPaused === false) await db.run(`UPDATE inbox_events SET status='pending',reason='恢复自主互动',updated_at=?
        WHERE conversation_id=? AND status='deferred' AND reason='自主互动已暂停'`, [now(), conversationId])
    })
  }

  async clearConversation(conversationId: string): Promise<void> {
    await this.db.write(async db => {
      const timestamp = now()
      await db.run(`UPDATE conversations SET cancel_epoch=cancel_epoch+1,
        content_revision=content_revision+1,updated_at=? WHERE id=?`, [timestamp, conversationId])
      await db.run(`UPDATE inbox_events SET status='cancelled',reason='会话已清空',updated_at=?
        WHERE conversation_id=? AND status IN ('pending','claimed','deferred')`,
      [timestamp, conversationId])
      await db.run('DELETE FROM messages WHERE conversation_id=?', [conversationId])
      await db.run('DELETE FROM composer_drafts WHERE conversation_id=?', [conversationId])
      await db.run('DELETE FROM summaries WHERE conversation_id=?', [conversationId])
      await db.run('DELETE FROM memories WHERE conversation_id=?', [conversationId])
      await db.run(`INSERT INTO user_reads(conversation_id,through_sequence,updated_at) VALUES (?,0,?)
        ON CONFLICT(conversation_id) DO UPDATE SET through_sequence=0,updated_at=excluded.updated_at`,
      [conversationId, timestamp])
    })
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.db.write(async db => {
      const conversation = (await rows(db, `SELECT kind FROM conversations WHERE id=?`,
        [conversationId]))[0]
      if (!conversation) return
      if (text(conversation.kind).startsWith('agent_')) {
        throw new Error('角色间会话只能清空或隐藏，不能在主聊天中删除')
      }
      const timestamp = now()
      await db.run('UPDATE media_assets SET conversation_id=NULL WHERE conversation_id=?', [conversationId])
      await db.run(`UPDATE inbox_events SET status='cancelled',reason='会话已删除',updated_at=?
        WHERE conversation_id=? AND status IN ('pending','claimed','deferred')`,
      [timestamp, conversationId])
      await db.run(`UPDATE runs SET status='cancelled',phase='cancelled',reason='会话已删除',
        updated_at=?,ended_at=? WHERE conversation_id=?
        AND status NOT IN ('completed','cancelled','failed','interrupted','skipped')`,
      [timestamp, timestamp, conversationId])
      await db.run(`DELETE FROM tool_actions WHERE run_id IN
        (SELECT id FROM runs WHERE conversation_id=?)`, [conversationId])
      await db.run(`DELETE FROM model_calls WHERE run_id IN
        (SELECT id FROM runs WHERE conversation_id=?)`, [conversationId])
      await db.run('DELETE FROM runs WHERE conversation_id=?', [conversationId])
      await db.run('DELETE FROM activities WHERE root_conversation_id=?', [conversationId])
      await db.run('DELETE FROM conversations WHERE id=?', [conversationId])
    })
  }

  async editMessage(messageId: string, body: string, recall = false): Promise<void> {
    if (!recall && (!body.trim() || body.length > 32768)) throw new Error('消息需为 1～32768 字符')
    await this.db.write(async db => {
      const row = (await rows(db, 'SELECT * FROM messages WHERE id=?', [messageId]))[0]
      if (!row || row.deleted || row.recalled || row.author_kind === 'system') throw new Error('该消息不可修改')
      if (recall && row.author_id !== localUserId) throw new Error('只能撤回自己的消息')
      const timestamp = now(), conversationId = text(row.conversation_id)
      const history = editHistory(row.edit_history)
      history.push({ body: text(row.body), at: timestamp })
      await db.run('UPDATE messages SET body=?,recalled=?,edited_at=?,edit_history=? WHERE id=?',
        [recall ? `（${text(row.author_name)}撤回了一条消息）` : body.trim(), recall ? 1 : 0,
          timestamp, recall ? '[]' : JSON.stringify(history.slice(-30)), messageId])
      await db.run('UPDATE memories SET valid=0 WHERE id IN (SELECT memory_id FROM memory_sources WHERE message_id=?)', [messageId])
      await db.run('UPDATE summaries SET valid=0 WHERE conversation_id=?', [conversationId])
      await db.run('UPDATE conversations SET cancel_epoch=cancel_epoch+1,content_revision=content_revision+1,updated_at=? WHERE id=?', [timestamp, conversationId])
      await db.run("UPDATE inbox_events SET status='cancelled',reason='消息已修改',updated_at=? WHERE conversation_id=? AND status IN ('pending','claimed','deferred')", [timestamp, conversationId])
      await db.run("UPDATE retry_jobs SET status='cancelled',updated_at=? WHERE conversation_id=?", [timestamp, conversationId])
      await db.run('DELETE FROM routing_plans WHERE message_id=?', [messageId])
      if (recall) {
        await db.run('DELETE FROM message_mentions WHERE message_id=?', [messageId])
        await db.run('UPDATE messages SET media_id=NULL WHERE id=?', [messageId])
        await db.run(`UPDATE inbox_events SET status='pending',reason='用户重试',retry_run_id=NULL,updated_at=?
          WHERE message_id=? AND agent_id IN (SELECT actor_id FROM conversation_members WHERE conversation_id=? AND left_sequence IS NULL)`,
          [timestamp, messageId, conversationId])
      }
    })
  }

  /** Fork only the prefix; the original conversation and its completed effects remain intact. */
  async regenerateBranch(messageId: string): Promise<string> {
    return this.db.write(async db => {
      const target = (await rows(db, 'SELECT * FROM messages WHERE id=? AND deleted=0 AND recalled=0', [messageId]))[0]
      if (!target || target.author_kind !== 'agent') throw new Error('请选择角色回复重新生成')
      const source = await this.getConversationIn(db, text(target.conversation_id))
      if (source.kind.startsWith('agent_')) throw new Error('旁观会话不能重新生成')
      const eligible = (await rows(db, `SELECT a.id FROM actors a JOIN conversation_members m ON m.actor_id=a.id
        WHERE m.conversation_id=? AND a.id=? AND m.left_sequence IS NULL AND a.enabled=1 AND a.archived=0`, [source.id, target.author_id])).length
      if (!eligible) throw new Error('角色已停用或离开会话')
      const prefix = await rows(db, 'SELECT * FROM messages WHERE conversation_id=? AND sequence<? ORDER BY sequence', [source.id, target.sequence])
      const anchor = [...prefix].reverse().find(row => !row.deleted)
      if (!anchor) throw new Error('开场白之前没有可重新生成的对话，请先发一条消息')
      const id = crypto.randomUUID(), timestamp = now(), ids = new Map(prefix.map(row => [text(row.id), crypto.randomUUID()]))
      await db.run(`INSERT INTO conversations(id,kind,title,topic,origin_conversation_id,next_sequence,branch_sequence,autonomy_paused,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,1,?,?)`, [id, source.kind, `${source.title} · 重新生成`, source.topic, source.id, num(target.sequence), num(target.sequence), timestamp, timestamp])
      await db.run(`INSERT INTO conversation_members(conversation_id,actor_id,ordinal,joined_sequence,left_sequence)
        SELECT ?,actor_id,ordinal,joined_sequence,left_sequence FROM conversation_members WHERE conversation_id=?`, [id, source.id])
      for (const row of prefix) {
        await db.run(`INSERT INTO messages(id,conversation_id,author_id,author_name,author_kind,body,sequence,quoted_id,request_id,deleted,created_at,media_id,recalled,edited_at,edit_history)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [ids.get(text(row.id)),id,row.author_id,row.author_name,row.author_kind,row.body,row.sequence,
          ids.get(text(row.quoted_id)) ?? null,crypto.randomUUID(),row.deleted,row.created_at,row.media_id ?? null,row.recalled,row.edited_at,row.edit_history])
      }
      for (const [oldId, newId] of ids) {
        await db.run(`INSERT INTO message_mentions(message_id,target_actor_id)
          SELECT ?,target_actor_id FROM message_mentions WHERE message_id=?`, [newId,oldId])
        await db.run(`INSERT INTO reactions(message_id,actor_id,emoji,created_at)
          SELECT ?,actor_id,emoji,created_at FROM reactions WHERE message_id=?`, [newId,oldId])
      }
      await db.run(`INSERT INTO lorebook_links(conversation_id,lorebook_id) SELECT ?,lorebook_id FROM lorebook_links WHERE conversation_id=?`, [id,source.id])
      await db.run(`INSERT INTO conversation_notes(id,conversation_id,author_id,scope,target_actor_id,body,version,created_at,updated_at)
        SELECT lower(hex(randomblob(16))),?,author_id,scope,target_actor_id,body,version,created_at,updated_at FROM conversation_notes WHERE conversation_id=?`, [id,source.id])
      const anchorId = ids.get(text(anchor.id))!
      await db.run(`INSERT INTO inbox_events(id,agent_id,conversation_id,message_id,sequence,status,reason,updated_at)
        VALUES (?,?,?,?,?,'pending','用户重试',?)`, [crypto.randomUUID(),target.author_id,id,anchorId,anchor.sequence,timestamp])
      if (anchor.author_kind === 'human') await db.run(`INSERT INTO routing_plans(message_id,mode,target_ids,tried_ids,epoch,membership_version,updated_at)
        VALUES (?,'mention',?,'[]',0,1,?)`, [anchorId,JSON.stringify([target.author_id]),timestamp])
      return id
    })
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.db.write(async db => {
      const row = (await rows(db, 'SELECT conversation_id FROM messages WHERE id=?', [messageId]))[0]
      if (!row) return
      const conversationId = text(row.conversation_id), timestamp = now()
      await db.run(`UPDATE messages SET deleted=1,body='',media_id=NULL,edit_history='[]' WHERE id=?`, [messageId])
      await db.run('DELETE FROM message_mentions WHERE message_id=?', [messageId])
      await db.run("UPDATE retry_jobs SET status='cancelled',updated_at=? WHERE conversation_id=?", [timestamp, conversationId])
      await db.run(`UPDATE inbox_events SET status='cancelled',reason='消息已删除',updated_at=?
        WHERE message_id=? AND status IN ('pending','claimed','deferred')`, [timestamp, messageId])
      await db.run('UPDATE summaries SET valid=0 WHERE conversation_id=?', [conversationId])
      await db.run(`UPDATE conversations SET content_revision=content_revision+1,
        cancel_epoch=cancel_epoch+1,updated_at=? WHERE id=?`, [timestamp, conversationId])
    })
  }

  async pendingInbox(
    agentId: string,
    through?: number,
    conversationId?: string
  ): Promise<{ conversationId: string; messages: Message[] }[]> {
    return this.db.read(async db => {
      const data = await rows(db, `SELECT m.*,i.reason inbox_reason,i.retry_run_id retry_run_id,
        (SELECT group_concat(emoji,' ') FROM reactions r WHERE r.message_id=m.id AND r.actor_id=?) human_reaction
        FROM inbox_events i
        JOIN messages m ON m.id=i.message_id
        WHERE i.agent_id=? AND i.status='pending' AND m.deleted=0
        AND (? IS NULL OR m.sequence<=?)
        AND (? IS NULL OR i.conversation_id=?)
        ORDER BY m.sequence LIMIT 60`,
      [localUserId, agentId, through ?? null, through ?? null, conversationId ?? null, conversationId ?? null])
      const grouped = new Map<string, Message[]>()
      for (const row of data) {
        const conversationId = text(row.conversation_id)
        grouped.set(conversationId, [...(grouped.get(conversationId) ?? []), {
          ...message(row), humanTriggered: ['用户表情互动', '用户继续', '用户重试'].includes(text(row.inbox_reason)),
          retryRunId: row.retry_run_id ? text(row.retry_run_id) : undefined,
          humanReaction: text(row.inbox_reason) === '用户表情互动' ? text(row.human_reaction).slice(0, 64) : undefined }])
      }
      return [...grouped].map(([conversationId, messages]) => ({ conversationId, messages }))
    })
  }

  async pendingHumanRound(conversationId: string): Promise<{
    messageId: string
    sequence: number
    through: number
    mentions: string[]
  } | null> {
    return this.db.read(async db => {
      const first = (await rows(db, `SELECT m.id,m.sequence FROM inbox_events i
        JOIN messages m ON m.id=i.message_id
        JOIN actors a ON a.id=m.author_id
        WHERE i.conversation_id=? AND i.status='pending' AND m.deleted=0
        AND a.kind='human'
        ORDER BY m.sequence LIMIT 1`, [conversationId]))[0]
      if (!first) return null
      const sequence = num(first.sequence)
      const nextHuman = (await rows(db, `SELECT MIN(m.sequence) sequence FROM inbox_events i
        JOIN messages m ON m.id=i.message_id
        JOIN actors a ON a.id=m.author_id
        WHERE i.conversation_id=? AND i.status='pending' AND m.deleted=0
        AND a.kind='human' AND m.sequence>?`, [conversationId, sequence]))[0]
      const nextSequence = nullableNum(nextHuman?.sequence)
      const conversationRow = (await rows(db,
        'SELECT next_sequence FROM conversations WHERE id=?', [conversationId]))[0]
      const snapshotThrough = conversationRow
        ? Math.max(sequence, num(conversationRow.next_sequence) - 1)
        : sequence
      const through = nextSequence === null
        ? snapshotThrough
        : Math.min(snapshotThrough, nextSequence - 1)
      const mentions = (await rows(db, `SELECT DISTINCT target_actor_id FROM message_mentions
        WHERE message_id=?`, [text(first.id)])).map(row => text(row.target_actor_id))
      return { messageId: text(first.id), sequence, through, mentions }
    })
  }

  private async routingCandidates(db: SQLiteDBConnection, messageId: string): Promise<string[]> {
    return (await rows(db, `SELECT a.id FROM messages msg JOIN conversation_members m ON m.conversation_id=msg.conversation_id
      JOIN actors a ON a.id=m.actor_id WHERE msg.id=? AND msg.deleted=0 AND a.kind='agent'
      AND a.enabled=1 AND a.archived=0 AND m.left_sequence IS NULL AND m.joined_sequence<=msg.sequence
      ORDER BY m.ordinal,a.id`, [messageId])).map(row => text(row.id))
  }

  private async readRoute(db: SQLiteDBConnection, messageId: string): Promise<RoutingPlan | null> {
    const row = (await rows(db, 'SELECT * FROM routing_plans WHERE message_id=?', [messageId]))[0]
    if (!row) return null
    const eligible = await this.routingCandidates(db, messageId)
    const targets = (JSON.parse(text(row.target_ids, '[]')) as string[]).filter(item => eligible.includes(item))
    const tried = JSON.parse(text(row.tried_ids, '[]')) as string[]
    const mode = text(row.mode) as RoutingPlan['mode']
    if (mode === 'one-of-us' && !targets.length) {
      const next = eligible.find(item => !tried.includes(item))
      return { mode, targets: next ? [next] : [], tried }
    }
    return { mode, targets: mode === 'each' ? eligible : targets, tried }
  }

  async routingPlan(messageId: string): Promise<RoutingPlan | null> {
    return this.db.read(db => this.readRoute(db, messageId))
  }

  async commitRoutingPlan(messageId: string, conversationId: string, epoch: number, membershipVersion: number,
    proposed: RoutingPlan): Promise<RoutingPlan | null> {
    return this.db.write(async db => {
      const valid = (await rows(db, `SELECT 1 FROM conversations c JOIN messages m ON m.conversation_id=c.id
        WHERE c.id=? AND m.id=? AND m.deleted=0 AND m.author_kind='human'
          AND c.cancel_epoch=? AND c.membership_version=? AND c.paused=0`,
      [conversationId, messageId, epoch, membershipVersion])).length
      if (!valid) return null
      const existing = await this.readRoute(db, messageId)
      const eligible = await this.routingCandidates(db, messageId)
      const selected = existing ?? { ...proposed, targets: proposed.targets.filter(item => eligible.includes(item)) }
      if (selected.mode === 'one-of-us') selected.targets = selected.targets.slice(0, 1)
      await db.run(`INSERT INTO routing_plans(message_id,mode,target_ids,tried_ids,epoch,membership_version,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET target_ids=excluded.target_ids,
        tried_ids=excluded.tried_ids,epoch=excluded.epoch,membership_version=excluded.membership_version,updated_at=excluded.updated_at`,
      [messageId, selected.mode, JSON.stringify(selected.targets), JSON.stringify(selected.tried), epoch, membershipVersion, now()])
      for (const target of selected.targets) await db.run(`UPDATE inbox_events SET status='pending',reason='主答认领',updated_at=?
        WHERE message_id=? AND agent_id=? AND status='skipped' AND reason IN ('由其他角色负责','角色当前不可用')`,
      [now(), messageId, target])
      return selected
    })
  }

  async advanceRouting(messageId: string, agentId: string, epoch: number): Promise<boolean> {
    return this.db.write(async db => {
      const messageRow = (await rows(db, `SELECT m.conversation_id FROM messages m JOIN conversations c ON c.id=m.conversation_id
        WHERE m.id=? AND m.deleted=0 AND c.paused=0 AND c.cancel_epoch=?`, [messageId, epoch]))[0]
      const row = (await rows(db, 'SELECT * FROM routing_plans WHERE message_id=?', [messageId]))[0]
      if (!messageRow || !row || row.mode !== 'one-of-us') return false
      const targets = JSON.parse(text(row.target_ids, '[]')) as string[]
      if (targets[0] !== agentId) return false
      const answered = (await rows(db, `SELECT 1 FROM messages posted JOIN run_causes cause ON cause.run_id=posted.origin_run_id
        WHERE cause.message_id=? AND posted.conversation_id=? LIMIT 1`, [messageId, messageRow.conversation_id])).length
      if (answered) return false
      const waiting = (await rows(db, `SELECT 1 FROM retry_jobs WHERE agent_id=? AND conversation_id=?
        AND status IN ('pending','dispatched')`, [agentId, messageRow.conversation_id])).length
      if (waiting) return false
      const tried = [...new Set([...(JSON.parse(text(row.tried_ids, '[]')) as string[]), agentId])]
      const next = (await this.routingCandidates(db, messageId)).find(item => !tried.includes(item))
      await db.run('UPDATE routing_plans SET target_ids=?,tried_ids=?,updated_at=? WHERE message_id=?',
        [JSON.stringify(next ? [next] : []), JSON.stringify(tried), now(), messageId])
      if (next) {
        await db.run(`UPDATE inbox_events SET status='skipped',reason='主答已交接',updated_at=?
          WHERE message_id=? AND agent_id=? AND status IN ('pending','deferred')`, [now(), messageId, agentId])
        await db.run(`UPDATE runs SET status='skipped',phase='skipped',reason='主答已交接',updated_at=?
          WHERE agent_id=? AND status IN ('failed','interrupted') AND id IN
            (SELECT run_id FROM run_causes WHERE message_id=?)`, [now(), agentId, messageId])
        await db.run(`UPDATE inbox_events SET status='pending',reason='主答交接',updated_at=?
          WHERE message_id=? AND agent_id=? AND status IN ('skipped','deferred')`, [now(), messageId, next])
      }
      return Boolean(next)
    })
  }

  async skipHumanRound(
    humanMessageId: string,
    targetAgentIds: string[],
    reason: string
  ): Promise<void> {
    await this.db.write(async db => {
      const timestamp = now()
      const targets = new Set(targetAgentIds)
      const rowsToSkip = await rows(db, `SELECT i.agent_id,i.sequence FROM inbox_events i
        JOIN messages m ON m.id=i.message_id
        WHERE i.conversation_id=(
          SELECT conversation_id FROM messages WHERE id=?
        ) AND i.status='pending' AND m.deleted=0 AND m.sequence>=(
          SELECT sequence FROM messages WHERE id=?
        )
        AND m.sequence<(
          SELECT COALESCE(MIN(m2.sequence),2147483648) FROM inbox_events i2
          JOIN messages m2 ON m2.id=i2.message_id
          JOIN actors a2 ON a2.id=m2.author_id
          WHERE i2.conversation_id=i.conversation_id AND i2.status='pending'
          AND m2.deleted=0 AND a2.kind='human' AND m2.sequence>(
            SELECT sequence FROM messages WHERE id=?
          )
        )`, [humanMessageId, humanMessageId, humanMessageId])
      for (const row of rowsToSkip) {
        if (!targets.has(text(row.agent_id))) {
          await db.run(`UPDATE inbox_events SET status='skipped',reason=?,updated_at=?
            WHERE agent_id=? AND conversation_id=(
              SELECT conversation_id FROM messages WHERE id=?
            ) AND sequence=? AND status='pending'`,
          [reason, timestamp, text(row.agent_id), humanMessageId, num(row.sequence)])
        }
      }
    })
  }

  async nextPendingAgent(
    conversationId: string,
    through: number,
    afterAgentId: string
  ): Promise<string | null> {
    return this.db.read(async db => {
      const row = (await rows(db, `SELECT i.agent_id FROM inbox_events i
        JOIN conversation_members m ON m.conversation_id=i.conversation_id
          AND m.actor_id=i.agent_id AND m.left_sequence IS NULL
        JOIN actors a ON a.id=i.agent_id AND a.enabled=1 AND a.archived=0
        WHERE i.conversation_id=? AND i.status='pending' AND i.sequence<=?
        AND i.agent_id<>?
        ORDER BY m.ordinal LIMIT 1`,
      [conversationId, through, afterAgentId]))[0]
      return row ? text(row.agent_id) : null
    })
  }

  async cancelHumanRoundRemainder(humanMessageId: string, reason: string): Promise<void> {
    await this.db.write(async db => {
      await db.run(`UPDATE inbox_events SET status='cancelled',reason=?,updated_at=?
        WHERE status='pending' AND conversation_id=(
          SELECT conversation_id FROM messages WHERE id=?
        ) AND sequence>=(
          SELECT sequence FROM messages WHERE id=?
        ) AND sequence<(
          SELECT COALESCE(MIN(m2.sequence),2147483648) FROM inbox_events i2
          JOIN messages m2 ON m2.id=i2.message_id
          JOIN actors a2 ON a2.id=m2.author_id
          WHERE i2.conversation_id=inbox_events.conversation_id AND i2.status='pending'
          AND m2.deleted=0 AND a2.kind='human' AND m2.sequence>(
            SELECT sequence FROM messages WHERE id=?
          )
        )`, [reason, now(), humanMessageId, humanMessageId, humanMessageId])
    })
  }

  async claimInbox(agentId: string, conversationId: string, through: number): Promise<boolean> {
    return this.db.write(async db => {
      const conversationRow = (await rows(db,
        'SELECT paused,autonomy_paused FROM conversations WHERE id=?', [conversationId]))[0]
      if (!conversationRow || bool(conversationRow.paused)) return false
      const pending = await rows(db, `SELECT m.author_kind,i.reason FROM inbox_events i
        JOIN messages m ON m.id=i.message_id
        WHERE i.agent_id=? AND i.conversation_id=? AND i.sequence<=? AND i.status='pending'
        AND m.deleted=0`, [agentId, conversationId, through])
      // Autonomy pause suppresses peer-driven work only; a human message, reaction or
      // manual retry still claims so the answer actually reaches the user.
      const humanWork = pending.some(row =>
        text(row.author_kind) === 'human' ||
        ['用户表情互动', '用户继续', '用户重试'].includes(text(row.reason)))
      if (bool(conversationRow.autonomy_paused) && !humanWork) return false
      const membership = (await rows(db, `SELECT 1 FROM conversation_members
        WHERE conversation_id=? AND actor_id=? AND left_sequence IS NULL`,
      [conversationId, agentId])).length
      if (!membership) return false
      await db.run(`UPDATE inbox_events SET status='claimed',updated_at=?
        WHERE agent_id=? AND conversation_id=? AND sequence<=? AND status='pending'`,
      [now(), agentId, conversationId, through])
      return true
    })
  }

  private async attachRetryOrigins(db: SQLiteDBConnection, conversationId: string): Promise<void> {
    await db.run(`UPDATE inbox_events AS i SET retry_run_id=(SELECT r.id FROM runs r
      JOIN run_causes cause ON cause.run_id=r.id AND cause.message_id=i.message_id
      WHERE r.agent_id=i.agent_id AND r.conversation_id=i.conversation_id
        AND r.status IN ('failed','interrupted','cancelled') ORDER BY r.started_at DESC,r.rowid DESC LIMIT 1)
      WHERE i.conversation_id=? AND (i.status='deferred' OR
        (i.status='cancelled' AND i.reason IN ('用户停止','用户全局停止')))`, [conversationId])
  }

  private async resetExhaustedRoutes(db: SQLiteDBConnection, conversationId: string): Promise<void> {
    await db.run(`UPDATE routing_plans SET tried_ids='[]',updated_at=?
      WHERE mode='one-of-us' AND target_ids='[]' AND message_id IN (SELECT message_id FROM inbox_events
        WHERE conversation_id=? AND status IN ('deferred','cancelled'))`, [now(), conversationId])
  }

  async addSeenCauses(runId: string, after: number, through: number): Promise<boolean> {
    return this.db.write(async db => {
      await db.run(`INSERT OR IGNORE INTO run_causes(run_id,message_id)
        SELECT r.id,m.id FROM runs r JOIN messages m ON m.conversation_id=r.conversation_id
        WHERE r.id=? AND r.status='running' AND m.deleted=0 AND m.sequence>? AND m.sequence<=?`, [runId, after, through])
      const human = (await rows(db, `SELECT 1 FROM run_causes cause JOIN messages m ON m.id=cause.message_id
        WHERE cause.run_id=? AND m.author_kind='human' AND m.sequence>? AND m.sequence<=? LIMIT 1`, [runId, after, through])).length > 0
      if (human) await db.run('UPDATE runs SET human_triggered=1 WHERE id=?', [runId])
      return human
    })
  }

  async continuationState(runId: string): Promise<{ posts: number; sidePosts: number; tools: string[] }> {
    return this.db.read(async db => {
      const counts = (await rows(db, `${previousRuns} SELECT
        COALESCE(SUM(CASE WHEN m.conversation_id=r.conversation_id THEN 1 ELSE 0 END),0) posts,
        COALESCE(SUM(CASE WHEN m.conversation_id<>r.conversation_id THEN 1 ELSE 0 END),0) side_posts
        FROM runs r LEFT JOIN messages m ON m.author_id=r.agent_id AND m.origin_run_id IN (SELECT id FROM previous)
        WHERE r.id=?`, [runId, runId]))[0]
      const actions = await rows(db, `${previousRuns} SELECT tool_name,result_json FROM tool_actions
        WHERE run_id IN (SELECT id FROM previous) AND status='completed' ORDER BY created_at DESC LIMIT 240`, [runId])
      const tools = new Set<string>()
      for (const action of actions) {
        try {
          const result = (JSON.parse(text(action.result_json)) as { result?: { content?: string } }).result
          if (result && !/^(错误[:：]|CANCELLED|HELD|BUDGET)/.test(result.content ?? '')) tools.add(text(action.tool_name))
        } catch { /* old non-tool receipts are not continuation hints */ }
      }
      return { posts: num(counts.posts), sidePosts: num(counts.side_posts), tools: [...tools] }
    })
  }

  async detachRetryParents(runId: string): Promise<void> {
    await this.db.write(db => db.run('DELETE FROM run_retries WHERE run_id=?', [runId]))
  }

  async markInboxHandled(agentId: string, conversationId: string, through: number, reason: string): Promise<void> {
    await this.db.write(async db => db.run(
      `UPDATE inbox_events SET status='handled',reason=?,updated_at=?
       WHERE agent_id=? AND conversation_id=? AND sequence<=? AND status='claimed'`,
      [reason, now(), agentId, conversationId, through]
    ))
  }

  async deferInbox(agentId: string, conversationId: string, through: number, reason: string): Promise<void> {
    await this.db.write(async db => db.run(
      `UPDATE inbox_events SET status='deferred',reason=?,updated_at=?
       WHERE agent_id=? AND conversation_id=? AND sequence<=? AND status IN ('pending','claimed')`,
      [reason, now(), agentId, conversationId, through]
    ))
  }

  async reserveAgentTurn(agentId: string, humanTriggered: boolean): Promise<number | null> {
    if (humanTriggered) return null
    return this.db.write(async db => {
      const timestamp = now()
      const previous = (await rows(db, 'SELECT * FROM agent_turn_limits WHERE agent_id=?', [agentId]))[0]
      const start = num(previous?.window_started_at)
      if (previous && timestamp >= start && timestamp - start < 60_000) {
        if (num(previous.turns) >= 30) return start + 60_000
        await db.run('UPDATE agent_turn_limits SET turns=turns+1 WHERE agent_id=?', [agentId])
      } else await db.run(`INSERT INTO agent_turn_limits(agent_id,window_started_at,turns) VALUES (?,?,1)
        ON CONFLICT(agent_id) DO UPDATE SET window_started_at=excluded.window_started_at,turns=1`, [agentId, timestamp])
      return null
    })
  }

  async scheduleRetry(input: { agentId: string; conversationId: string; runId: string; activityId: string;
    through: number; epoch: number; profileVersion: number; kind: RetryJob['kind']; dueAt?: number }): Promise<RetryJob | null> {
    return this.db.write(async db => {
      const timestamp = now()
      const current = (await rows(db, `SELECT 1 FROM conversations c JOIN actors a ON a.id=?
        JOIN activities act ON act.id=? WHERE c.id=? AND c.cancel_epoch=? AND c.paused=0
        AND (c.autonomy_paused=0 OR EXISTS(SELECT 1 FROM runs r WHERE r.id=? AND r.human_triggered=1))
        AND a.enabled=1 AND a.archived=0 AND a.profile_version=?
        AND act.status='active' AND act.model_calls<64 AND act.posts<24 AND act.started_at>?
        AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.author_kind='human'
          AND m.deleted=0 AND m.sequence>?)`, [input.agentId, input.activityId, input.conversationId,
        input.epoch, input.runId, input.profileVersion, timestamp - 180_000, input.through]))[0]
      if (!current) return null
      const previous = (await rows(db, 'SELECT * FROM retry_jobs WHERE agent_id=? AND conversation_id=?',
        [input.agentId, input.conversationId]))[0]
      const continuing = previous && num(previous.epoch) === input.epoch && text(previous.kind) === input.kind &&
        ['pending', 'dispatched'].includes(text(previous.status))
      const attempt = continuing ? num(previous.attempt) + 1 : 1
      if (input.kind === 'http' && attempt > 2) return null
      const jobId = previous ? text(previous.id) : id()
      const dueAt = input.dueAt ?? timestamp + 5_000 * 2 ** (attempt - 1)
      await db.run(`INSERT INTO retry_jobs(id,agent_id,conversation_id,run_id,activity_id,through_sequence,
        epoch,profile_version,kind,attempt,status,due_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?,?) ON CONFLICT(agent_id,conversation_id) DO UPDATE SET
        run_id=excluded.run_id,activity_id=excluded.activity_id,through_sequence=excluded.through_sequence,
        epoch=excluded.epoch,profile_version=excluded.profile_version,kind=excluded.kind,attempt=excluded.attempt,
        status='pending',due_at=excluded.due_at,updated_at=excluded.updated_at`,
      [jobId, input.agentId, input.conversationId, input.runId, input.activityId, input.through,
        input.epoch, input.profileVersion, input.kind, attempt, dueAt, timestamp, timestamp])
      await db.run(`UPDATE inbox_events SET status='deferred',reason='等待自动重试',updated_at=?
        WHERE agent_id=? AND conversation_id=? AND sequence<=? AND status IN ('pending','claimed')`,
      [timestamp, input.agentId, input.conversationId, input.through])
      return { id: jobId, agentId: input.agentId, conversationId: input.conversationId,
        runId: input.runId, dueAt, attempt, kind: input.kind }
    })
  }

  async dispatchRetry(jobId: string): Promise<string | null> {
    return this.db.write(async db => {
      const timestamp = now()
      const job = (await rows(db, "SELECT * FROM retry_jobs WHERE id=? AND status='pending' AND due_at<=?",
        [jobId, timestamp]))[0]
      if (!job) return null
      const valid = (await rows(db, `SELECT 1 FROM conversations c JOIN actors a ON a.id=?
        JOIN activities act ON act.id=? WHERE c.id=? AND c.cancel_epoch=? AND c.paused=0
        AND (c.autonomy_paused=0 OR EXISTS(SELECT 1 FROM runs r WHERE r.id=? AND r.human_triggered=1))
        AND a.enabled=1 AND a.archived=0 AND a.profile_version=? AND act.status='active'
        AND act.model_calls<64 AND act.posts<24 AND act.started_at>?`, [job.agent_id, job.activity_id,
        job.conversation_id, job.epoch, job.run_id, job.profile_version, timestamp - 180_000]))[0]
      if (!valid) {
        await db.run("UPDATE retry_jobs SET status='dormant',updated_at=? WHERE id=?", [timestamp, jobId])
        await db.run("UPDATE runs SET reason='自动重试已暂停，请检查角色、会话或预算后手动重试' WHERE id=?", [job.run_id])
        return null
      }
      await db.run(`UPDATE inbox_events SET status='pending',reason='自动重试',updated_at=?,retry_run_id=?
        WHERE agent_id=? AND conversation_id=? AND sequence<=? AND status='deferred' AND reason='等待自动重试'`,
      [timestamp, job.run_id, job.agent_id, job.conversation_id, job.through_sequence])
      await db.run("UPDATE retry_jobs SET status='dispatched',updated_at=? WHERE id=?", [timestamp, jobId])
      return text(job.conversation_id)
    })
  }

  async settleRetry(agentId: string, conversationId: string, status: 'completed' | 'dormant'): Promise<void> {
    await this.db.write(db => db.run(`UPDATE retry_jobs SET status=?,updated_at=?
      WHERE agent_id=? AND conversation_id=? AND status IN ('pending','dispatched')`,
    [status, now(), agentId, conversationId]))
  }

  async ensureActivity(conversationId: string, causeMessageId?: string): Promise<string> {
    return this.db.write(async db => {
      if (causeMessageId) {
        const inherited = (await rows(db, `SELECT a.id FROM messages m
          JOIN activities a ON a.id=m.activity_id WHERE m.id=? AND m.conversation_id=?`,
        [causeMessageId, conversationId]))[0]
        // Keep cancelled/exhausted activity IDs: a stale inbox must not mint a new budget.
        if (inherited) return text(inherited.id)
      }
      const timestamp = now()
      const rootConversationId = conversationId
      const recent = (await rows(db, `SELECT id FROM activities WHERE root_conversation_id=?
        AND status='active' AND started_at>? ORDER BY started_at DESC,rowid DESC LIMIT 1`,
      [rootConversationId, timestamp - 180_000]))[0]
      if (recent) return text(recent.id)
      const activityId = id()
      await db.run(`INSERT INTO activities(id,root_conversation_id,status,started_at,updated_at)
        VALUES (?,?,'active',?,?)`, [activityId, rootConversationId, timestamp, timestamp])
      return activityId
    })
  }

  async reserveModelCall(activityId: string): Promise<void> {
    await this.db.write(async db => {
      const activity = (await rows(db, 'SELECT * FROM activities WHERE id=?', [activityId]))[0]
      if (!activity || text(activity.status) !== 'active' || num(activity.model_calls) >= 64 ||
        num(activity.posts) >= 24 || now() - num(activity.started_at) >= 180_000) {
        throw new Error('本次互动达到预算上限，请点击继续')
      }
      await db.run('UPDATE activities SET model_calls=model_calls+1,updated_at=? WHERE id=?', [now(), activityId])
    })
  }

  async activityBudget(activityId: string): Promise<{
    status: string
    posts: number
    modelCalls: number
    startedAt: number
  } | null> {
    return this.db.read(async db => {
      const row = (await rows(db, `SELECT status,posts,model_calls,started_at
        FROM activities WHERE id=?`, [activityId]))[0]
      return row ? {
        status: text(row.status),
        posts: num(row.posts),
        modelCalls: num(row.model_calls),
        startedAt: num(row.started_at)
      } : null
    })
  }

  async exhaustActivity(activityId: string, reason: string): Promise<void> {
    await this.db.write(async db => {
      const timestamp = now()
      await db.run(`UPDATE activities SET status='budget_exhausted',
        updated_at=? WHERE id=? AND status='active'`, [timestamp, activityId])
      if (reason) {
        await db.run(`UPDATE inbox_events SET status='deferred',reason=?,updated_at=?
          WHERE status='pending' AND (conversation_id=(SELECT root_conversation_id FROM activities WHERE id=?)
            OR message_id IN (SELECT id FROM messages WHERE activity_id=?))`,
        [reason, timestamp, activityId, activityId])
      }
    })
  }

  async createRun(agentId: string, conversationId: string, activityId: string, roundMessageId?: string | null,
    causeMessageIds: string[] = [], retryParents: string[] = [], humanTriggered = true): Promise<string> {
    const runId = id()
    await this.db.write(async db => {
      const timestamp = now()
      await db.run(`INSERT INTO runs(id,agent_id,conversation_id,activity_id,round_message_id,human_triggered,status,phase,started_at,updated_at)
        VALUES (?,?,?,?,?,?,'running','running',?,?)`,
      [runId, agentId, conversationId, activityId, roundMessageId ?? null, humanTriggered ? 1 : 0, timestamp, timestamp])
      for (const messageId of new Set(causeMessageIds)) {
        await db.run('INSERT INTO run_causes(run_id,message_id) VALUES (?,?)', [runId, messageId])
      }
      for (const parentId of new Set(retryParents)) await db.run(`INSERT INTO run_retries(run_id,parent_run_id)
        SELECT ?,id FROM runs WHERE id=? AND agent_id=? AND conversation_id=? AND id<>?`,
      [runId, parentId, agentId, conversationId, runId])
    })
    return runId
  }

  async finishRun(runId: string, status: 'completed' | 'failed' | 'cancelled' | 'interrupted', reason = ''): Promise<void> {
    await this.db.write(async db => {
      const timestamp = now()
      await db.run(`UPDATE runs SET status=?,phase=?,reason=?,updated_at=?,ended_at=?
        WHERE id=? AND status NOT IN ('completed','cancelled','failed','interrupted')`,
      [status, status, reason, timestamp, timestamp, runId])
    })
  }

  async updateRunPhase(runId: string, phase: string): Promise<void> {
    await this.db.write(async db => db.run(
      'UPDATE runs SET phase=?,updated_at=? WHERE id=? AND ended_at IS NULL',
      [phase, now(), runId]
    ))
  }

  async recordModelCall(input: {
    runId: string
    agentId: string
    providerId: string
    modelId: string
    purpose: 'main' | 'triage' | 'summary'
    status: string
    inputTokens: number | null
    outputTokens: number | null
    errorCode?: string
    startedAt: number
  }): Promise<void> {
    await this.db.write(async db => {
      const timestamp = now()
      await db.run(
        `INSERT INTO model_calls(id,run_id,agent_id,provider_id,model_id,purpose,status,
          input_tokens,output_tokens,error_code,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id(), input.runId, input.agentId, input.providerId, input.modelId, input.purpose,
          input.status, input.inputTokens, input.outputTokens, input.errorCode ?? '',
          input.startedAt, timestamp]
      )
    })
  }

  async usageSummary(): Promise<UsageSummary> {
    return this.db.read(async db => {
      const totals = (await rows(db, `SELECT COUNT(*) calls,COALESCE(SUM(input_tokens),0) input_tokens,
        COALESCE(SUM(output_tokens),0) output_tokens,
        COALESCE(SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END),0) unknown_calls
        FROM model_calls`))[0]
      const purposes = await rows(db, `SELECT purpose,COUNT(*) calls,
        COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) tokens FROM model_calls GROUP BY purpose`)
      return { calls: num(totals.calls), inputTokens: num(totals.input_tokens), outputTokens: num(totals.output_tokens),
        unknownCalls: num(totals.unknown_calls), purposes: purposes.map(row =>
          ({ purpose: text(row.purpose), calls: num(row.calls), tokens: num(row.tokens) })) }
    })
  }

  async storageStats(): Promise<StorageStats> {
    return this.db.read(async db => {
      const pageSize = num((await rows(db, 'PRAGMA page_size'))[0]?.page_size)
      const pageCount = num((await rows(db, 'PRAGMA page_count'))[0]?.page_count)
      const freePages = num((await rows(db, 'PRAGMA freelist_count'))[0]?.freelist_count)
      const counts = (await rows(db, `SELECT (SELECT COUNT(*) FROM messages) messages,
        (SELECT COUNT(*) FROM actors WHERE kind='agent') agents,
        (SELECT COUNT(*) FROM conversations) conversations,
        (SELECT COUNT(*) FROM memories WHERE valid=1) memories,
        (SELECT COUNT(*) FROM model_calls)+(SELECT COUNT(*) FROM tool_actions) logs,
        (SELECT COUNT(*) FROM media_assets) media,
        (SELECT COUNT(*) FROM lorebooks) lorebooks`))[0]
      return { bytes: pageSize * pageCount, freeBytes: pageSize * freePages, messages: num(counts.messages),
        agents: num(counts.agents), conversations: num(counts.conversations), memories: num(counts.memories),
        logs: num(counts.logs), media: num(counts.media), lorebooks: num(counts.lorebooks) }
    })
  }

  async clearFinishedLogs(): Promise<void> {
    await this.db.write(async db => {
      await db.run(`DELETE FROM model_calls WHERE run_id IS NULL OR run_id='' OR run_id IN
        (SELECT id FROM runs WHERE status IN ('completed','cancelled','failed','interrupted','skipped'))`)
      await db.run(`DELETE FROM tool_actions WHERE run_id IN
        (SELECT id FROM runs WHERE status IN ('completed','cancelled','failed','interrupted','skipped'))`)
    })
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    const [stats, usage, calls] = await Promise.all([this.storageStats(), this.usageSummary(), this.listModelCalls(50)])
    const configuration = await this.db.read(async db => ({
      schemaVersion: num((await rows(db, 'SELECT MAX(version) version FROM schema_migrations'))[0]?.version),
      sqliteVersion: text((await rows(db, 'SELECT sqlite_version() version'))[0]?.version),
      providers: await rows(db, 'SELECT protocol,enabled,credential_state FROM providers'),
      bindings: await rows(db, 'SELECT purpose,context_tokens,output_tokens FROM model_bindings')
    }))
    return { format: 'yomi-diagnostics', version: 1, exportedAt: now(), configuration, storage: stats, usage,
      recentCalls: calls.map(call => ({ purpose: call.purpose, status: call.status,
        errorCode: /^[a-z0-9_-]{0,64}$/.test(call.errorCode) ? call.errorCode : 'unknown',
        inputTokens: call.inputTokens, outputTokens: call.outputTokens, startedAt: call.startedAt, endedAt: call.endedAt })) }
  }

  async listModelCalls(limit = 100): Promise<ModelCallRecord[]> {
    return this.db.read(async db => (await rows(db, `SELECT * FROM model_calls
      ORDER BY started_at DESC LIMIT ?`, [Math.min(Math.max(limit, 1), 500)])).map(row => ({
      id: text(row.id), runId: text(row.run_id), agentId: text(row.agent_id),
      providerId: text(row.provider_id), modelId: text(row.model_id),
      purpose: text(row.purpose) as ModelCallRecord['purpose'], status: text(row.status),
      inputTokens: nullableNum(row.input_tokens), outputTokens: nullableNum(row.output_tokens),
      errorCode: text(row.error_code), startedAt: num(row.started_at), endedAt: nullableNum(row.ended_at)
    })))
  }

  async listRuntimeIssues(): Promise<RuntimeIssue[]> {
    return this.db.read(async db => (await rows(db, `WITH outstanding AS (
      SELECT r.conversation_id,r.status,r.reason,r.updated_at,r.id,c.title conversation_title,
        row_number() OVER(PARTITION BY r.conversation_id ORDER BY r.updated_at DESC,r.id DESC) position
      FROM runs r JOIN conversations c ON c.id=r.conversation_id
      WHERE r.status IN ('failed','interrupted') AND NOT EXISTS (
        SELECT 1 FROM runs newer WHERE newer.conversation_id=r.conversation_id AND newer.agent_id=r.agent_id
        AND (newer.started_at>r.started_at OR (newer.started_at=r.started_at AND newer.rowid>r.rowid))
      )) SELECT * FROM outstanding WHERE position=1 ORDER BY updated_at DESC LIMIT 50`)).map(row => ({
      conversationId: text(row.conversation_id), conversationTitle: text(row.conversation_title),
      status: text(row.status) as RuntimeIssue['status'], reason: text(row.reason),
      updatedAt: num(row.updated_at)
    })))
  }

  async interruptStaleRuns(reason = '应用上次运行时中断'): Promise<void> {
    await this.db.write(async db => {
      const timestamp = now()
      await db.run(`UPDATE runs SET reason=? WHERE id IN
        (SELECT run_id FROM retry_jobs WHERE status IN ('pending','dispatched')) AND status='failed'`,
      [`${reason}，自动重试已暂停，等待手动决定`])
      await db.run("UPDATE retry_jobs SET status='dormant',updated_at=? WHERE status IN ('pending','dispatched')", [timestamp])
      await db.run(`UPDATE runs SET status='interrupted',phase='interrupted',
        reason=?,updated_at=? WHERE status IN ('queued','triaging','running')`,
      [reason, timestamp])
      await db.run(`UPDATE inbox_events SET status='deferred',
        reason=?,updated_at=? WHERE status='claimed'`, [`${reason}，等待用户决定`, timestamp])
    })
  }

  async exportBackup(includeRuntime = false): Promise<Record<string, unknown>> {
    return this.db.read(async db => ({
      format: 'yomi-backup',
      version: 3,
      exportedAt: now(),
      providers: await rows(db, `SELECT id,name,protocol,base_url,'missing' credential_state,
        enabled,config_version,created_at,updated_at FROM providers`),
      modelBindings: await rows(db, 'SELECT * FROM model_bindings'),
      agentModelBindings: await rows(db, 'SELECT * FROM agent_model_bindings'),
      actors: await rows(db, 'SELECT * FROM actors'),
      conversations: await rows(db, 'SELECT * FROM conversations'),
      conversationMembers: await rows(db, 'SELECT * FROM conversation_members'),
      userReads: await rows(db, 'SELECT * FROM user_reads'),
      messages: await rows(db, 'SELECT * FROM messages'),
      messageMentions: await rows(db, 'SELECT * FROM message_mentions'),
      reactions: await rows(db, 'SELECT * FROM reactions'),
      memories: await rows(db, 'SELECT * FROM memories'),
      memorySources: await rows(db, 'SELECT * FROM memory_sources'),
      summaries: await rows(db, 'SELECT * FROM summaries'),
      conversationMemoryLinks: await rows(db, 'SELECT * FROM conversation_memory_links'),
      composerDrafts: await rows(db, 'SELECT * FROM composer_drafts'),
      lorebooks: await rows(db, 'SELECT * FROM lorebooks'),
      lorebookEntries: await rows(db, 'SELECT * FROM lorebook_entries'),
      lorebookLinks: await rows(db, 'SELECT * FROM lorebook_links'),
      stickers: await rows(db, 'SELECT * FROM stickers'),
      lorebookActorLinks: await rows(db,'SELECT * FROM lorebook_actor_links'),
      characterCards: await rows(db,'SELECT * FROM character_cards'),
      conversationNotes: await rows(db, 'SELECT * FROM conversation_notes'),
      proactiveRules: await rows(db, 'SELECT * FROM proactive_rules'),
      mediaAssets: await rows(db, 'SELECT * FROM media_assets'),
      mediaBlobs: await rows(db, 'SELECT * FROM media_blobs'),
      appSettings: await rows(db, "SELECT * FROM app_settings WHERE key<>'background_enabled'"),
      ...(includeRuntime ? {
        activities: await rows(db, 'SELECT * FROM activities'),
        runs: await rows(db, 'SELECT * FROM runs'),
        runCauses: await rows(db, 'SELECT * FROM run_causes'),
        runRetries: await rows(db, 'SELECT * FROM run_retries'),
        retryJobs: await rows(db, 'SELECT * FROM retry_jobs'),
        inboxEvents: await rows(db, 'SELECT * FROM inbox_events'),
        routingPlans: await rows(db, 'SELECT * FROM routing_plans'),
        modelCalls: await rows(db, 'SELECT * FROM model_calls'),
        toolActions: await rows(db, 'SELECT * FROM tool_actions'),
        agentTurnLimits: await rows(db, 'SELECT * FROM agent_turn_limits'),
        commandReceipts: await rows(db, 'SELECT * FROM command_receipts')
      } : {})
    }))
  }

  async importBackup(data: unknown, preserveRuntime = false): Promise<void> {
    if (!data || typeof data !== 'object') throw new Error('备份格式无效')
    const backup = data as Record<string, unknown>
    // v2 backups restore too; the world book and sticker tables are simply empty.
    if (backup.format !== 'yomi-backup' || ![2, 3].includes(num(backup.version))) {
      throw new Error('不支持的备份格式或版本')
    }
    const sourceTables: [string, string][] = [
      ['providers', 'providers'],
      ['modelBindings', 'model_bindings'],
      ['actors', 'actors'],
      ['agentModelBindings', 'agent_model_bindings'],
      ['conversations', 'conversations'],
      ['conversationMembers', 'conversation_members'],
      ['userReads', 'user_reads'],
      ['messages', 'messages'],
      ['messageMentions', 'message_mentions'],
      ['reactions', 'reactions'],
      ['memories', 'memories'],
      ['memorySources', 'memory_sources'],
      ['summaries', 'summaries'],
      ['composerDrafts', 'composer_drafts']
    ]
    if (backup.appSettings === undefined && backup.mediaSettings !== undefined) backup.appSettings = backup.mediaSettings
    const optionalTables: [string, string][] = [
      ['conversationMemoryLinks', 'conversation_memory_links'],
      ['lorebooks', 'lorebooks'], ['lorebookEntries', 'lorebook_entries'], ['lorebookLinks', 'lorebook_links'],
      ['lorebookActorLinks', 'lorebook_actor_links'], ['characterCards', 'character_cards'],
      ['stickers', 'stickers'], ['conversationNotes', 'conversation_notes'], ['proactiveRules', 'proactive_rules'],
      ['mediaAssets', 'media_assets'], ['mediaBlobs', 'media_blobs'], ['appSettings', 'app_settings'],
      ...(preserveRuntime ? [
        ['activities', 'activities'], ['runs', 'runs'], ['runCauses', 'run_causes'], ['runRetries', 'run_retries'],
        ['retryJobs', 'retry_jobs'], ['inboxEvents', 'inbox_events'], ['routingPlans', 'routing_plans'],
        ['modelCalls', 'model_calls'], ['toolActions', 'tool_actions'], ['agentTurnLimits', 'agent_turn_limits'],
        ['commandReceipts', 'command_receipts']
      ] as [string, string][] : [])
    ]
    for (const [source] of sourceTables) {
      if (backup[source] !== undefined && !Array.isArray(backup[source])) {
        throw new Error(`备份字段 ${source} 无效`)
      }
    }
    for (const [source] of optionalTables) {
      if (backup[source] !== undefined && !Array.isArray(backup[source])) {
        throw new Error(`备份字段 ${source} 无效`)
      }
    }
    for (const required of ['actors', 'conversations', 'conversationMembers', 'messages']) {
      if (!Array.isArray(backup[required])) throw new Error(`备份缺少 ${required}，没有替换本地数据`)
    }
    const actors = backup.actors as Row[]
    if (actors.some(row => !row || typeof row !== 'object' || Array.isArray(row)) ||
        actors.filter(row => row.kind === 'human').length !== 1 ||
        !actors.some(row => row.id === localUserId && row.kind === 'human')) {
      throw new Error('备份的本地用户身份无效')
    }
    const conversations = backup.conversations as Row[]
    const parents = new Map(conversations.map(row => [row?.id, row?.origin_conversation_id]))
    for (const row of conversations) {
      const visited = new Set<unknown>()
      let current: unknown = row?.id
      while (current) {
        if (visited.has(current)) throw new Error('备份包含循环的会话来源')
        visited.add(current)
        current = parents.get(current)
      }
    }
    await this.db.write(async db => {
      // All validation and replacement share a transaction. Deferred FK checking
      // allows a derived conversation to occur before its parent in a backup.
      await db.query('PRAGMA defer_foreign_keys=ON')
      const imported: { table: string; records: Row[]; columns: Set<string> }[] = []
      for (const [source, target] of sourceTables) {
        const records = backup[source] ?? []
        const columns = new Set((await rows(db, `PRAGMA table_info(${target})`)).map(row => text(row.name)))
        if (!(records as unknown[]).every(raw => raw && typeof raw === 'object' && !Array.isArray(raw) &&
          Object.entries(raw).every(([name, value]) => columns.has(name) &&
            (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))))) {
          throw new Error(`备份字段 ${source} 包含无效记录`)
        }
        imported.push({ table: target, records: records as Row[], columns })
      }
      for (const [source, target] of optionalTables) {
        const records = (backup[source] ?? []) as Row[]
        const columns = new Set((await rows(db, `PRAGMA table_info(${target})`)).map(row => text(row.name)))
        if (!records.every(raw => raw && typeof raw === 'object' && !Array.isArray(raw) &&
          Object.entries(raw).every(([name, value]) => columns.has(name) &&
            (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))))) {
          throw new Error(`备份字段 ${source} 包含无效记录`)
        }
        imported.push({ table: target, records, columns })
      }
      const tables = [
        'conversation_memory_links',
        'run_causes', 'run_retries', 'memory_sources', 'conversation_notes', 'proactive_rules', 'routing_plans',
        'character_cards','lorebook_actor_links','lorebook_links','lorebook_entries','lorebooks',
        'media_blobs','media_assets','stickers','conversation_notes','proactive_rules',
        'memory_sources','run_retries','run_causes','routing_plans',
        'retry_jobs', 'agent_turn_limits', 'reactions', 'message_mentions', 'inbox_events', 'tool_actions', 'model_calls',
        'runs', 'activities', 'summaries', 'memories', 'composer_drafts',
        'command_receipts', 'messages', 'user_reads', 'conversation_members',
        'conversations', 'agent_model_bindings', 'model_bindings', 'providers', 'actors', 'app_settings'
      ]
      for (const table of new Set(tables)) await db.run(`DELETE FROM ${table}`)
      for (const { table: target, records } of imported) {
        for (const raw of records) {
          const values = { ...raw }
          if (target === 'proactive_rules' && !preserveRuntime) values.enabled = 0
          const keys = Object.keys(values)
          if (target === 'providers') {
            for (const key of ['credential_ref', 'credential_state']) {
              if (!keys.includes(key)) keys.push(key)
            }
            values.credential_ref = ''
            values.credential_state = 'missing'
          }
          if (!keys.length) continue
          await db.run(
            `INSERT INTO ${target}(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
            keys.map(key => values[key])
          )
        }
      }
      if ((await rows(db, 'PRAGMA foreign_key_check')).length) throw new Error('备份存在缺失的关联记录，已保留原数据')
      if ((await rows(db, `SELECT c.id FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id
        GROUP BY c.id HAVING c.next_sequence<=COALESCE(MAX(m.sequence),0) OR c.next_sequence<1`)).length) {
        throw new Error('备份消息序号无效，已保留原数据')
      }
      if ((await rows(db,`SELECT id FROM messages WHERE deleted=0 AND media_id IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM media_assets a WHERE a.id=messages.media_id AND a.status='ready')`)).length) throw new Error('备份缺少媒体')
      await db.run("UPDATE media_assets SET status='failed',error='生成中断，请手动重试' WHERE status='pending'")
      await db.run(`UPDATE summaries SET valid=0 WHERE start_sequence<1 OR through_sequence<start_sequence
        OR NOT EXISTS(SELECT 1 FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id
          WHERE c.id=summaries.conversation_id AND c.content_revision=summaries.content_revision
          AND c.next_sequence>summaries.through_sequence AND m.actor_id=summaries.agent_id
          AND m.left_sequence IS NULL AND m.joined_sequence<=summaries.start_sequence)`)
      await db.run("UPDATE messages SET body='' WHERE deleted=1")
    })
    await this.ensureLocalUser()
  }

  async clearAll(): Promise<void> {
    await this.db.write(async db => {
      const tables = [
        'conversation_memory_links',
        'run_causes', 'run_retries', 'memory_sources', 'conversation_notes', 'proactive_rules', 'routing_plans',
        'character_cards','lorebook_actor_links','lorebook_links','lorebook_entries','lorebooks',
        'media_blobs','media_assets','stickers','conversation_notes','proactive_rules',
        'memory_sources','run_retries','run_causes','routing_plans',
        'retry_jobs', 'agent_turn_limits', 'reactions', 'message_mentions', 'inbox_events', 'tool_actions', 'model_calls',
        'runs', 'activities', 'summaries', 'memories', 'composer_drafts',
        'command_receipts', 'messages', 'user_reads', 'conversation_members',
        'conversations', 'agent_model_bindings', 'model_bindings', 'providers', 'actors', 'app_settings'
      ]
      for (const table of new Set(tables)) await db.run(`DELETE FROM ${table}`)
    })
    await this.ensureLocalUser()
  }

  private async insertInbox(
    db: SQLiteDBConnection,
    conversationId: string,
    messageId: string,
    sequence: number,
    authorId: string,
    reason = ''
  ): Promise<void> {
    const members = await rows(db, `SELECT actor_id FROM conversation_members
      WHERE conversation_id=? AND left_sequence IS NULL AND joined_sequence<=?`, [conversationId, sequence])
    for (const row of members) {
      const memberId = text(row.actor_id)
      if (memberId === authorId || memberId === localUserId) continue
      await db.run(
        `INSERT INTO inbox_events(
          id,agent_id,conversation_id,message_id,sequence,status,reason,updated_at
        ) VALUES (?,?,?,?,?,'pending',?,?) ON CONFLICT(agent_id,message_id) DO UPDATE SET
          status='pending',reason=excluded.reason,updated_at=excluded.updated_at,retry_run_id=NULL
          WHERE excluded.reason='用户表情互动' AND inbox_events.status<>'claimed'`,
        [id(), memberId, conversationId, messageId, sequence, reason, now()]
      )
    }
  }

  private async insertMentions(db: SQLiteDBConnection, messageId: string, mentions: string[]): Promise<void> {
    for (const actorId of mentions) {
      await db.run('INSERT INTO message_mentions(message_id,target_actor_id) VALUES (?,?)',
        [messageId, actorId])
    }
  }

  private async loadReactions(db: SQLiteDBConnection, messageId: string): Promise<Message['reactions']> {
    const data = await rows(db, 'SELECT actor_id,emoji FROM reactions WHERE message_id=?', [messageId])
    const grouped = new Map<string, string[]>()
    for (const row of data) {
      grouped.set(text(row.emoji), [...(grouped.get(text(row.emoji)) ?? []), text(row.actor_id)])
    }
    return [...grouped].map(([emoji, actorIds]) => ({ emoji, actorIds }))
  }

  private async loadMentions(db: SQLiteDBConnection, messageId: string): Promise<string[]> {
    return (await rows(db, 'SELECT target_actor_id FROM message_mentions WHERE message_id=?',
      [messageId])).map(row => text(row.target_actor_id))
  }

  private async recordAction(
    db: SQLiteDBConnection,
    actionId: string,
    runId: string,
    toolName: string,
    status: string,
    result: Record<string, unknown>
  ): Promise<void> {
    await db.run(
      `INSERT INTO tool_actions(action_id,run_id,tool_name,status,result_json,created_at)
       VALUES (?,?,?,?,?,?)`,
      [actionId, runId, toolName, status, JSON.stringify(result), now()]
    )
  }
}

function provider(row: Row): Provider {
  return {
    id: text(row.id), name: text(row.name),
    protocol: text(row.protocol) as Provider['protocol'], baseUrl: text(row.base_url),
    credentialRef: '', credentialState: text(row.credential_state, 'missing') as Provider['credentialState'],
    enabled: bool(row.enabled), configVersion: num(row.config_version),
    createdAt: num(row.created_at), updatedAt: num(row.updated_at)
  }
}

function binding(row: Row): ModelBinding {
  return {
    id: text(row.id), providerId: row.provider_id ? text(row.provider_id) : null,
    modelId: text(row.model_id), contextTokens: num(row.context_tokens),
    outputTokens: num(row.output_tokens), purpose: text(row.purpose) as ModelBinding['purpose'],
    revision: num(row.revision)
  }
}

function actor(row: Row): Actor {
  return {
    id: text(row.id), kind: text(row.kind) as Actor['kind'], name: text(row.name),
    color: text(row.color), bio: text(row.bio), persona: text(row.persona),
    speakingStyle: text(row.speaking_style), avatarData: text(row.avatar_data),
    enabled: bool(row.enabled), archived: bool(row.archived),
    profileVersion: num(row.profile_version), allowPrivate: bool(row.allow_private),
    allowGroup: bool(row.allow_group), createdAt: num(row.created_at), updatedAt: num(row.updated_at)
  }
}

function conversation(
  row: Row,
  lastMessage = '',
  unread = 0,
  members: string[] = [],
  memberNames: string[] = []
): Conversation {
  return {
    id: text(row.id), kind: text(row.kind) as ConversationKind,
    title: text(row.title), topic: text(row.topic), members, memberNames,
    originConversationId: row.origin_conversation_id ? text(row.origin_conversation_id) : null,
    pinned: bool(row.pinned), muted: bool(row.muted), hidden: bool(row.hidden),
    paused: bool(row.paused), autonomyPaused: bool(row.autonomy_paused),
    nextSequence: num(row.next_sequence), contentRevision: num(row.content_revision),
    membershipVersion: num(row.membership_version), cancelEpoch: num(row.cancel_epoch),
    createdAt: num(row.created_at), updatedAt: num(row.updated_at), lastMessage, unread
  }
}

function editHistory(raw: unknown): { body: string; at: number }[] {
  try {
    const parsed: unknown = JSON.parse(text(raw, '[]'))
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item.body === 'string' &&
      item.body.length <= 32768 && typeof item.at === 'number' && Number.isFinite(item.at)).slice(-30) : []
  } catch { return [] }
}

function message(row: Row): Message {
  return {
    id: text(row.id), conversationId: text(row.conversation_id),
    authorId: text(row.author_id), authorName: text(row.author_name),
    authorKind: text(row.author_kind) as Message['authorKind'], body: text(row.body),
    sequence: num(row.sequence), quotedId: row.quoted_id ? text(row.quoted_id) : null,
    recalled: bool(row.recalled), editedAt: num(row.edited_at), editHistory: editHistory(row.edit_history),
    mentions: [], createdAt: num(row.created_at), deleted: bool(row.deleted), reactions: [], mediaId: row.media_id ? text(row.media_id) : null
  }
}

function memory(row: Row): Memory {
  return {
    id: text(row.id), agentId: text(row.agent_id),
    conversationId: row.conversation_id ? text(row.conversation_id) : null,
    body: text(row.body), kind: text(row.kind), about: text(row.about),
    pinned: bool(row.pinned), origin: text(row.origin) as Memory['origin'],
    createdAt: num(row.created_at), updatedAt: num(row.updated_at)
  }
}

function parseKeywords(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  } catch { return [] }
}

function conversationNote(row: Row): ConversationNote {
  return {
    id: text(row.id), conversationId: text(row.conversation_id),
    authorId: text(row.author_id), scope: text(row.scope) as ConversationNoteScope,
    targetActorId: row.target_actor_id ? text(row.target_actor_id) : null,
    body: text(row.body), version: num(row.version),
    createdAt: num(row.created_at), updatedAt: num(row.updated_at)
  }
}

function proactiveRule(row: Row): ProactiveRule {
  return {
    id: text(row.id), conversationId: text(row.conversation_id),
    actorId: row.actor_id ? text(row.actor_id) : null,
    mode: text(row.mode) as ProactiveMode,
    intervalMinutes: num(row.interval_minutes), dailyAt: num(row.daily_at),
    prompt: text(row.prompt), enabled: bool(row.enabled),
    lastFiredAt: num(row.last_fired_at), nextDueAt: num(row.next_due_at),
    createdAt: num(row.created_at), updatedAt: num(row.updated_at)
  }
}

function asset(row: Row): MediaAsset {
  return {
    id: text(row.id), kind: text(row.kind) as MediaAsset['kind'],
    ownerActorId: row.owner_actor_id ? text(row.owner_actor_id) : null,
    conversationId: row.conversation_id ? text(row.conversation_id) : null,
    messageId: row.message_id ? text(row.message_id) : null,
    providerId: text(row.provider_id), modelId: text(row.model_id),
    prompt: text(row.prompt), status: text(row.status) as MediaAsset['status'],
    error: text(row.error), bytes: num(row.bytes), mimeType: text(row.mime_type),
    width: num(row.width), height: num(row.height), durationMs: num(row.duration_ms),
    transcript: text(row.transcript), voice: text(row.voice), createdAt: num(row.created_at)
  }
}

export { localUserId }

function lorebook(row: Row): Lorebook {
  return { id:text(row.id),title:text(row.title),description:text(row.description),
    scope:text(row.scope) as Lorebook['scope'],conversationId:row.conversation_id ? text(row.conversation_id) : null,
    enabled:bool(row.enabled),entryCount:num(row.entry_count),createdAt:num(row.created_at),updatedAt:num(row.updated_at) }
}
function loreEntry(row: Row): LorebookEntry {
  return { id:text(row.id),lorebookId:text(row.lorebook_id),title:text(row.title),content:text(row.content),
    keywords:parseKeywords(text(row.keywords)),secondaryKeywords:parseKeywords(text(row.secondary_keywords)),
    selective:bool(row.selective),caseSensitive:bool(row.case_sensitive),constant:bool(row.constant),enabled:bool(row.enabled),
    ordinal:num(row.ordinal),sourceJson:text(row.source_json),createdAt:num(row.created_at),updatedAt:num(row.updated_at) }
}
