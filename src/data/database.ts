import { Capacitor } from '@capacitor/core'
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite'
import { schema, schemaVersion } from './schema'
import { removeClosedDatabase } from '../platform/dataFiles'

export type Row = Record<string, unknown>
const sqliteOwner = new SQLiteConnection(CapacitorSQLite)
let webSqliteReady: Promise<void> | null = null

async function initializeWebSqlite(): Promise<void> {
  if (Capacitor.getPlatform() !== 'web') return
  if (!webSqliteReady) {
    webSqliteReady = (async () => {
      const { defineCustomElements } = await import('jeep-sqlite/loader')
      defineCustomElements(window)
      if (!document.querySelector('jeep-sqlite')) {
        const element = document.createElement('jeep-sqlite')
        element.setAttribute('wasmPath', '/assets')
        document.body.append(element)
      }
      await customElements.whenDefined('jeep-sqlite')
      await CapacitorSQLite.initWebStore()
    })().catch(error => {
      webSqliteReady = null
      throw error
    })
  }
  await webSqliteReady
}

export class Database {
  private queue: Promise<unknown> = Promise.resolve()
  private db: SQLiteDBConnection | null = null

  constructor(private name = 'yomi', private readonly initializeSchema = true) {}

  get databaseName(): string { return this.name }

  static async exists(name: string): Promise<boolean> {
    return Boolean((await sqliteOwner.isDatabase(name)).result)
  }

  private sqlite(): SQLiteConnection {
    return sqliteOwner
  }

  async open(): Promise<void> {
    await initializeWebSqlite()
    const sqlite = this.sqlite()
    // A WebView reload discards JS handles while the native plugin can retain
    // them. Reconcile that registry before creating or retrieving a handle.
    await sqlite.checkConnectionsConsistency()
    const existing = await sqlite.isConnection(this.name, false)
    this.db = existing.result
      ? await sqlite.retrieveConnection(this.name, false)
      : await sqlite.createConnection(this.name, false, 'no-encryption', 1, false)
    try {
      await this.db.open()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes('already open')) throw error
    }
    await this.db.query('SELECT 1')
    await this.rollbackIfActive()
    if (!this.initializeSchema) return
    await this.migrateExistingTables()
    await this.db.execute(schema, false)
    // Older prototypes owned local books by one conversation; preserve the
    // binding while making the book reusable independently of that chat.
    await this.db.run(`INSERT OR IGNORE INTO lorebook_links(conversation_id,lorebook_id)
      SELECT conversation_id,id FROM lorebooks WHERE conversation_id IS NOT NULL`, [], false)
    await this.db.run('UPDATE lorebooks SET conversation_id=NULL WHERE conversation_id IS NOT NULL', [], false)
    await this.db.run(
      `UPDATE summaries SET start_sequence=1 WHERE start_sequence IS NULL OR start_sequence<1`, [], false)
    await this.db.run(
      `INSERT OR IGNORE INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)`,
      [schemaVersion, `yomi-v${schemaVersion}`, Date.now()], false
    )
    // Older builds may have stored a reference in this column. Credentials now
    // live only in Android Keystore; never carry a plaintext reference forward.
    await this.db.run(
      `UPDATE providers SET credential_ref='', credential_state='missing'
       WHERE credential_ref<>'' OR credential_state<>'missing'`, [], false)
    await this.db.query('PRAGMA foreign_keys=ON')
  }

  async checkIntegrity(): Promise<void> {
    await this.read(async db => {
      const check = (await db.query('PRAGMA quick_check')).values ?? []
      if (check.length !== 1 || Object.values(check[0])[0] !== 'ok' ||
          (await db.query('PRAGMA foreign_key_check')).values?.length) {
        throw new Error('本地数据库完整性检查失败')
      }
    })
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      if (!this.db) return
      await sqliteOwner.closeConnection(this.name, false)
      this.db = null
    })
  }

  async compact(): Promise<void> {
    await this.read(async db => { await db.execute('VACUUM;', false) })
  }

  /** Swap the handle while keeping the Repository's Database object stable. */
  async adopt(candidate: Database): Promise<void> {
    await candidate.queue
    await this.enqueue(async () => {
      if (!candidate.db) throw new Error('暂存数据库尚未打开')
      if (this.db) await sqliteOwner.closeConnection(this.name, false)
      this.name = candidate.name
      this.db = candidate.db
      candidate.db = null
    })
  }

  static async remove(name: string): Promise<void> {
    if (!/^yomi(?:_store_[a-f0-9]{32})?$/.test(name)) throw new Error('无效的数据文件名称')
    if (!await Database.exists(name)) return
    if ((await sqliteOwner.isConnection(name, false)).result) await sqliteOwner.closeConnection(name, false)
    if (await removeClosedDatabase(name)) return
    const temporary = new Database(name, false)
    try {
      await temporary.open()
      await temporary.read(db => db.delete())
    } finally { await temporary.close() }
  }

  private async rollbackIfActive(): Promise<void> {
    if (!this.db) return
    try {
      const active = await this.db.isTransactionActive()
      if (active.result) await this.db.rollbackTransaction()
    } catch {
      // The plugin can reject this probe while a new native handle is initializing.
    }
  }

  private async migrateExistingTables(): Promise<void> {
    if (!this.db) return
    const additions: Record<string, Record<string, string>> = {
      providers: { credential_state: "TEXT NOT NULL DEFAULT 'missing'", config_version: 'INTEGER NOT NULL DEFAULT 1' },
      schema_migrations: { checksum: "TEXT NOT NULL DEFAULT ''" },
      model_bindings: { revision: 'INTEGER NOT NULL DEFAULT 1' },
      actors: {
        speaking_style: "TEXT NOT NULL DEFAULT ''",
        avatar_data: "TEXT NOT NULL DEFAULT ''",
        profile_version: 'INTEGER NOT NULL DEFAULT 1',
        allow_private: 'INTEGER NOT NULL DEFAULT 1',
        allow_group: 'INTEGER NOT NULL DEFAULT 1'
      },
      conversations: {
        branch_sequence: 'INTEGER NOT NULL DEFAULT 0',
        origin_conversation_id: 'TEXT',
        content_revision: 'INTEGER NOT NULL DEFAULT 1',
        membership_version: 'INTEGER NOT NULL DEFAULT 1',
        autonomy_paused: 'INTEGER NOT NULL DEFAULT 0'
      },
      conversation_members: {
        ordinal: 'INTEGER NOT NULL DEFAULT 0',
        joined_sequence: 'INTEGER NOT NULL DEFAULT 0',
        left_sequence: 'INTEGER'
      },
      user_reads: { updated_at: 'INTEGER NOT NULL DEFAULT 0' },
      messages: { recalled: 'INTEGER NOT NULL DEFAULT 0', edited_at: 'INTEGER NOT NULL DEFAULT 0', edit_history: "TEXT NOT NULL DEFAULT '[]'", activity_id: 'TEXT', origin_run_id: 'TEXT', media_id: 'TEXT' },
      lorebook_entries: { secondary_keywords: "TEXT NOT NULL DEFAULT '[]'", selective: 'INTEGER NOT NULL DEFAULT 0',
        case_sensitive: 'INTEGER NOT NULL DEFAULT 0', source_json: "TEXT NOT NULL DEFAULT ''" },
      inbox_events: { reason: "TEXT NOT NULL DEFAULT ''", updated_at: 'INTEGER NOT NULL DEFAULT 0', retry_run_id: 'TEXT' },
      memories: { version: 'INTEGER NOT NULL DEFAULT 1', valid: 'INTEGER NOT NULL DEFAULT 1' },
      summaries: { start_sequence: 'INTEGER NOT NULL DEFAULT 1',
        segment_start_sequence: 'INTEGER NOT NULL DEFAULT 0', segment_body: "TEXT NOT NULL DEFAULT ''" },
      runs: { activity_id: 'TEXT', phase: "TEXT NOT NULL DEFAULT 'queued'", ended_at: 'INTEGER', round_message_id: 'TEXT', human_triggered: 'INTEGER NOT NULL DEFAULT 1' }
    }
    for (const [table, columns] of Object.entries(additions)) {
      const exists = (await this.db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table])).values?.length
      if (!exists) continue
      const current = new Set(((await this.db.query(`PRAGMA table_info(${table})`)).values ?? []).map(row => String(row.name)))
      for (const [column, definition] of Object.entries(columns)) {
        if (!current.has(column)) await this.db.execute(
          `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, false)
      }
    }
  }

  read<T>(work: (db: SQLiteDBConnection) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      if (!this.db) throw new Error('数据库尚未打开')
      return work(this.db)
    })
  }

  write<T>(work: (db: SQLiteDBConnection) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      if (!this.db) throw new Error('数据库尚未打开')
      await this.rollbackIfActive()
      await this.db.beginTransaction()
      try {
        const result = await work(transactionConnection(this.db))
        await this.db.commitTransaction()
        return result
      } catch (error) {
        try { await this.db.rollbackTransaction() } catch { /* preserve the original failure */ }
        throw error
      }
    })
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work, work)
    this.queue = pending.catch(() => undefined)
    return pending
  }
}

/**
 * The Capacitor SQLite API starts a transaction for every run/execute call by
 * default. All repository writes execute inside a transaction managed by
 * Database.write(), so nested statements must opt out of that default.
 */
function transactionConnection(db: SQLiteDBConnection): SQLiteDBConnection {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'run') {
        return (statement: string, values: unknown[] = [], _transaction = true,
          returnMode = 'no', isSQL92 = true) =>
          target.run(statement, values, false, returnMode, isSQL92)
      }
      if (property === 'execute') {
        return (statements: string, _transaction = true, isSQL92 = true) =>
          target.execute(statements, false, isSQL92)
      }
      if (property === 'executeSet') {
        return (set: Parameters<SQLiteDBConnection['executeSet']>[0],
          _transaction = true, returnMode = 'no', isSQL92 = true) =>
          target.executeSet(set, false, returnMode, isSQL92)
      }
      return Reflect.get(target, property, receiver)
    }
  })
}
