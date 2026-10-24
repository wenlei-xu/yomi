import { Database } from './database'
import { Repository } from './repository'
import { mergeBackupModules, type BackupModule, type Snapshot } from './modularBackup'

type Manifest = {
  active: string; previous: string | null; pending: string | null
  phase: string; revision: number; switchedAt: number; note: string
}
export type RecoveryInfo = { canRollback: boolean; switchedAt: number; note: string }
const validName = (name: unknown): name is string => typeof name === 'string' && /^yomi(?:_store_[a-f0-9]{32})?$/.test(name)

/** Independent SQLite catalog: its atomic commits choose a complete data generation. */
export class DataStore {
  private readonly catalog = new Database('yomi_catalog', false)
  private current!: Database

  get database(): Database { return this.current }

  async open(): Promise<void> {
    await this.catalog.open()
    await this.catalog.write(async db => {
      await db.run(`CREATE TABLE IF NOT EXISTS store_manifest(
        id INTEGER PRIMARY KEY CHECK(id=1), active TEXT NOT NULL, previous TEXT, pending TEXT,
        phase TEXT NOT NULL DEFAULT 'idle', revision INTEGER NOT NULL DEFAULT 1,
        switched_at INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '')`)
      await db.run('CREATE TABLE IF NOT EXISTS store_gc(name TEXT PRIMARY KEY)')
      await db.run("INSERT OR IGNORE INTO store_manifest(id,active,phase) VALUES (1,'yomi','new')")
    })
    let manifest = await this.manifest()
    if (manifest.pending) {
      await this.catalog.write(async db => {
        await db.run('INSERT OR IGNORE INTO store_gc(name) VALUES (?)', [manifest.pending])
        await db.run(`UPDATE store_manifest SET pending=NULL,phase='idle',revision=revision+1,
          note='上次恢复未完成，已保留原数据' WHERE id=1`)
      })
      manifest = await this.manifest()
    }
    try {
      this.current = await this.openGeneration(manifest.active, manifest.phase === 'new' && manifest.active === 'yomi')
      if (manifest.phase === 'new') await this.catalog.write(db => db.run("UPDATE store_manifest SET phase='idle' WHERE id=1"))
    }
    catch (error) {
      if (!manifest.previous) throw error
      this.current = await this.openGeneration(manifest.previous)
      await this.catalog.write(async db => {
        await db.run(`UPDATE store_manifest SET active=?,previous=NULL,phase='idle',revision=revision+1,
          note='恢复后的数据无法打开，已自动回退到上一份本地数据' WHERE id=1`, [manifest.previous])
        await db.run('INSERT OR IGNORE INTO store_gc(name) VALUES (?)', [manifest.active])
      })
    }
    await this.collectGarbage().catch(() => undefined)
  }

  async info(): Promise<RecoveryInfo> {
    const state = await this.manifest()
    return { canRollback: Boolean(state.previous), switchedAt: state.switchedAt, note: state.note }
  }

  async restore(payload: unknown, modules?: BackupModule[], overwrite = false): Promise<void> {
    const before = await this.manifest()
    if (before.pending) throw new Error('另一次数据恢复尚未结束')
    const name = `yomi_store_${crypto.randomUUID().replace(/-/g, '')}`
    let candidate: Database | null = null
    let committed = false
    await this.catalog.write(async db => {
      await db.run("UPDATE store_manifest SET pending=?,phase='building',revision=revision+1 WHERE id=1", [name])
    })
    try {
      candidate = await this.openGeneration(name, true)
      const snapshot = modules
        ? mergeBackupModules(await new Repository(this.current).exportBackup(true), payload as Snapshot, modules, overwrite)
        : payload
      await new Repository(candidate).importBackup(snapshot, Boolean(modules))
      await candidate.checkIntegrity()
      await this.catalog.write(db => db.run("UPDATE store_manifest SET phase='prepared' WHERE id=1"))
      await this.activate(candidate, before)
      committed = true
    } finally {
      await candidate?.close()
      if (!committed) {
        await this.catalog.write(async db => {
          await db.run('INSERT OR IGNORE INTO store_gc(name) VALUES (?)', [name])
          await db.run("UPDATE store_manifest SET pending=NULL,phase='idle',revision=revision+1 WHERE id=1")
        })
      }
      await this.collectGarbage().catch(() => undefined)
    }
  }

  async rollback(): Promise<void> {
    const before = await this.manifest()
    if (!before.previous) throw new Error('没有可回退的本地数据')
    const candidate = await this.openGeneration(before.previous)
    try { await this.activate(candidate, before) }
    finally { await candidate.close() }
  }

  /** Discard retained generations as part of explicitly clearing all local data. */
  async discardPrevious(): Promise<void> {
    const state = await this.manifest()
    await this.catalog.write(async db => {
      if (state.previous) await db.run('INSERT OR IGNORE INTO store_gc(name) VALUES (?)', [state.previous])
      await db.run("UPDATE store_manifest SET previous=NULL,revision=revision+1 WHERE id=1")
    })
    await this.collectGarbage()
  }

  private async activate(candidate: Database, before: Manifest): Promise<void> {
    const name = candidate.databaseName
    await this.catalog.write(async db => {
      const state = (await db.query('SELECT active FROM store_manifest WHERE id=1')).values?.[0]
      if (state?.active !== before.active) throw new Error('数据版本已变化，请重新恢复')
      await db.run(`UPDATE store_manifest SET active=?,previous=?,pending=NULL,phase='idle',
        revision=revision+1,switched_at=?,note='' WHERE id=1`, [name, before.active, Date.now()])
      if (before.previous && before.previous !== name) await db.run(
        'INSERT OR IGNORE INTO store_gc(name) VALUES (?)', [before.previous])
    })
    try { await this.current.adopt(candidate) }
    catch (error) {
      await this.catalog.write(db => db.run(`UPDATE store_manifest SET active=?,previous=?,
        pending=NULL,phase='idle',revision=revision+1 WHERE id=1`, [before.active, before.previous]))
      // closeConnection can fail after releasing a native handle. Reopen the old
      // generation before exposing the application again.
      await this.current.open()
      throw error
    }
  }

  private async openGeneration(name: string, allowCreate = false): Promise<Database> {
    if (!validName(name)) throw new Error('本地数据目录记录损坏')
    if (!allowCreate && !await Database.exists(name)) throw new Error('本地数据文件缺失')
    const database = new Database(name)
    try {
      await database.open()
      await database.checkIntegrity()
      return database
    } catch (error) { await database.close().catch(() => undefined); throw error }
  }

  private async manifest(): Promise<Manifest> {
    return this.catalog.read(async db => {
      const row = (await db.query('SELECT * FROM store_manifest WHERE id=1')).values?.[0]
      if (!row || !validName(row.active) || (row.previous !== null && !validName(row.previous)) ||
          (row.pending !== null && !validName(row.pending))) throw new Error('本地数据目录记录损坏')
      return { active: row.active, previous: row.previous as string | null, pending: row.pending as string | null,
        phase: String(row.phase), revision: Number(row.revision), switchedAt: Number(row.switched_at), note: String(row.note) }
    })
  }

  private async collectGarbage(): Promise<void> {
    const state = await this.manifest()
    const garbage = await this.catalog.read(async db => (await db.query('SELECT name FROM store_gc')).values ?? [])
    for (const row of garbage) {
      const name = row.name
      if (!validName(name) || [state.active, state.previous, state.pending].includes(name)) continue
      await Database.remove(name)
      await this.catalog.write(db => db.run('DELETE FROM store_gc WHERE name=?', [name]))
    }
  }
}
