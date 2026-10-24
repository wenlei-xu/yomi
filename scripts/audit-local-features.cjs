const { buildSync } = require('esbuild')
const { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const path = require('node:path')
const compiled = buildSync({ stdin: { contents: `
export { Repository } from './src/data/repository'; export { Database } from './src/data/database';
export { schema } from './src/data/schema'; export { DataStore } from './src/data/store';
export { AgentRuntime } from './src/agent/runtime'; export {storeCredential} from './src/platform/secureTransport'; export * from './src/data/modularBackup';`,
  resolveDir: path.resolve(__dirname, '..') }, bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const mod = { exports: {} }
new Function('require', 'module', 'exports', compiled)(require, mod, mod.exports)
const { Repository, Database, schema, DataStore, AgentRuntime, createBackupZip, readBackupZip, mergeBackupModules, storeCredential } = mod.exports
const connections = new Map()
function connection(name) {
  if (connections.has(name)) return connections.get(name)
  const sql = new DatabaseSync(':memory:')
  const conn = {
    query: async (q, values = []) => ({ values: sql.prepare(q).all(...values) }),
    run: async (q, values = []) => sql.prepare(q).run(...values),
    execute: async q => sql.exec(q),
    isTransactionActive: async () => ({ result: sql.isTransaction }),
    beginTransaction: async () => sql.exec('BEGIN'), commitTransaction: async () => sql.exec('COMMIT'),
    rollbackTransaction: async () => sql.exec('ROLLBACK')
  }
  const entry = { sql, conn }; connections.set(name, entry); return entry
}
// Real SQL and real staging catalog, with the native connection lifecycle replaced.
Database.prototype.open = async function () {
  const { conn } = connection(this.databaseName); this.db = conn
  if (this.initializeSchema) { await this.migrateExistingTables(); await conn.execute(schema) }
}
Database.prototype.close = async function () { this.db = null }
Database.prototype.persistWebStore = async function () { assert.equal(connections.get(this.databaseName).sql.isTransaction, false) }
Database.prototype.adopt = async function (candidate) { this.name = candidate.name; this.db = candidate.db; candidate.db = null }
Database.exists = async name => connections.has(name)
Database.remove = async name => { connections.get(name)?.sql.close(); connections.delete(name) }
async function fixture() {
  const db = new Database(`fixture-${crypto.randomUUID()}`); await db.open()
  const repo = new Repository(db); await repo.ensureLocalUser()
  const a = await repo.saveAgent({ name: 'A' }), b = await repo.saveAgent({ name: 'B' })
  const room = await repo.createGroup('group', [a.id, b.id])
  return { db, repo, a, b, room, sql: connections.get(db.databaseName).sql }
}
async function main() {
  const f = await fixture()
  await f.repo.saveConversationNote({ conversationId: f.room.id, scope: 'shared', body: 'SHARED-FACT' })
  const privateNote = await f.repo.saveConversationNote({ conversationId: f.room.id, scope: 'private', targetActorId: f.a.id, body: 'A-PRIVATE' })
  await f.repo.saveConversationNote({ conversationId: f.room.id, scope: 'private', targetActorId: f.b.id, body: 'B-PRIVATE' })
  assert.match(await f.repo.conversationNoteContext(f.room.id, f.a.id), /SHARED-FACT/)
  assert.doesNotMatch(await f.repo.conversationNoteContext(f.room.id, f.a.id), /B-PRIVATE/)
  assert.doesNotMatch(await f.repo.conversationNoteContext(f.room.id, f.b.id), /A-PRIVATE/)
  await f.repo.saveConversationNote({ ...privateNote, body: 'A-EDITED' })
  assert.match(await f.repo.conversationNoteContext(f.room.id, f.a.id), /A-EDITED/)
  const outsider = await f.repo.saveAgent({ name: 'outsider' })
  await assert.rejects(f.repo.saveConversationNote({ conversationId: f.room.id, scope: 'private', targetActorId: outsider.id, body: 'no' }))
  console.log('PASS: shared notes, private isolation, editing, membership validation')

  const msg = await f.repo.sendUserMessage(f.room.id, 'ORIGINAL', 'message-1')
  await f.repo.saveSummary({ agentId: f.a.id, conversationId: f.room.id, contentRevision: f.room.contentRevision,
    startSequence: 1, throughSequence: 1, body: 'CUMULATIVE' })
  const runtime = new AgentRuntime(f.repo, async () => [], async () => [])
  const context = await runtime.buildContext(f.a, f.room, 1, { contextTokens: 16000, outputTokens: 1000 })
  assert.match(JSON.stringify(context.input), /第 1～1 条/)
  assert.match(JSON.stringify(context.input), /CUMULATIVE/)
  assert.doesNotMatch(JSON.stringify(context.input), /B-PRIVATE/)
  console.log('PASS: anchored summary and private notes reach only intended context')

  const scheduled = await fixture()
  const dm = await scheduled.repo.openDirect(scheduled.a.id)
  const rule = await scheduled.repo.saveProactiveRule({ conversationId: dm.id, actorId: scheduled.a.id, mode: 'interval', intervalMinutes: 5 })
  scheduled.sql.prepare('UPDATE proactive_rules SET next_due_at=0 WHERE id=?').run(rule.id)
  assert.equal((await scheduled.repo.dispatchDueProactiveRules()).length, 1)
  assert.equal((await scheduled.repo.dispatchDueProactiveRules()).length, 0)
  assert.equal(await scheduled.repo.pendingHumanRound(dm.id), null)
  const inbox = await scheduled.repo.pendingInbox(scheduled.a.id, undefined, dm.id)
  assert.equal(inbox[0].messages[0].authorKind, 'system')
  assert.equal(inbox[0].messages[0].humanTriggered, false)
  const provider = { id: crypto.randomUUID(), name: 'schedule test', protocol: 'responses', baseUrl: 'https://audit.invalid/v1',
    enabled: true, credentialState: 'stored', credentialRef: '', configVersion: 1, createdAt: 0, updatedAt: 0 }
  await scheduled.repo.saveProvider(provider)
  await storeCredential(provider.id, 'test-only', 'https://audit.invalid')
  await scheduled.repo.saveBinding({ id: crypto.randomUUID(), purpose: 'main', providerId: provider.id,
    modelId: 'audit', contextTokens: 16000, outputTokens: 1000, revision: 1 })
  const agentRuntime = new AgentRuntime(scheduled.repo, () => scheduled.repo.listProviders(), () => scheduled.repo.listBindings())
  agentRuntime.wakeConversation = () => {}
  const previousFetch = global.fetch
  let calls = 0
  global.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ output: [{ type: 'function_call', call_id: crypto.randomUUID(),
      name: 'turn_finish', arguments: '{}' }], usage: { input_tokens: 1, output_tokens: 1 } }))
  }
  try { await agentRuntime.drainConversation(dm.id) } finally { global.fetch = previousFetch }
  assert.equal(calls, 1)
  assert.equal((await scheduled.repo.pendingInbox(scheduled.a.id, undefined, dm.id)).length, 0)
  assert.equal((await scheduled.repo.listRuntimeIssues()).length, 0)

  await scheduled.repo.stopConversation(dm.id)
  scheduled.sql.prepare('UPDATE proactive_rules SET next_due_at=0 WHERE id=?').run(rule.id)
  assert.equal((await scheduled.repo.dispatchDueProactiveRules()).length, 0)
  await scheduled.repo.postponeOverdueProactiveRules()
  assert.ok((await scheduled.repo.listProactiveRules())[0].nextDueAt > Date.now())
  await assert.rejects(scheduled.repo.saveProactiveRule({ conversationId: scheduled.room.id, mode: 'interval', intervalMinutes: 0 }))
  console.log('PASS: durable schedule dispatch, no duplicate ticks, no impersonated user, stop, missed-slot handling')

  const old = await f.repo.exportBackup()
  const zip = await createBackupZip(old, 'test-password', ['memories'])
  assert.equal(zip[0], 0x50); assert.equal(zip[1], 0x4b)
  assert.ok(!Buffer.from(zip).includes(Buffer.from('A-EDITED')))
  await assert.rejects(readBackupZip(zip, 'wrong-password'))
  const archive = await readBackupZip(zip, 'test-password')
  assert.ok(archive.preview.modules.includes('memories'))
  await f.repo.sendUserMessage(f.room.id, 'NEW-LOCAL-HISTORY', 'message-2')
  await f.repo.saveAgent({ ...f.a, name: 'NEW-LOCAL-NAME' })
  const base = await f.repo.exportBackup(true)
  const merged = mergeBackupModules(base, archive.snapshot, ['memories'])
  assert.equal(merged.actors.find(a => a.id === f.a.id).name, 'NEW-LOCAL-NAME')
  assert.ok(merged.messages.some(m => m.body === 'NEW-LOCAL-HISTORY'))
  const destination = await fixture()
  await destination.repo.importBackup(merged, true)
  assert.ok((await destination.repo.allMessages(f.room.id)).some(m => m.body === 'NEW-LOCAL-HISTORY'))
  assert.equal((await destination.repo.listConversationNotes(f.room.id)).length, 3)
  const bad = structuredClone(merged); bad.messages[0].conversation_id = 'missing'
  await assert.rejects(destination.repo.importBackup(bad, true))
  assert.ok((await destination.repo.allMessages(f.room.id)).some(m => m.body === 'NEW-LOCAL-HISTORY'))
  console.log('PASS: encrypted ZIP, password rejection, partial merge, unchanged roles/history, SQL rollback')

  const roleZip = await readBackupZip(await createBackupZip(old, 'test-password', ['roles']), 'test-password')
  assert.deepEqual(roleZip.preview.modules, ['roles'])
  const overwrite = mergeBackupModules(base, roleZip.snapshot, ['roles'], true)
  assert.equal(overwrite.actors.find(a => a.id === f.a.id).name, 'A')
  assert.ok(overwrite.messages.some(m => m.body === 'NEW-LOCAL-HISTORY'))
  console.log('PASS: roles-only export and explicit overwrite leave chats intact')

  const store = new DataStore(); await store.open()
  const live = new Repository(store.database); await live.ensureLocalUser()
  const local = await live.saveAgent({ name: 'LOCAL-ONLY' })
  await store.restore(roleZip.snapshot, ['roles'])
  assert.ok(await live.getActor(local.id)); assert.ok(await live.getActor(f.a.id))
  assert.equal((await store.info()).canRollback, true)
  await store.rollback()
  assert.ok(await live.getActor(local.id)); assert.equal(await live.getActor(f.a.id), null)
  const broken = structuredClone(old); broken.conversationMembers[0].actor_id = 'missing'
  await assert.rejects(store.restore(broken))
  assert.ok(await live.getActor(local.id))
  console.log('PASS: staged partial restore, old database retained, rollback, failed candidate leaves active data untouched')

  // Existing databases gain the column without erasing their current summary.
  const migration = await fixture()
  await migration.repo.saveSummary({ agentId: migration.a.id, conversationId: migration.room.id, contentRevision: migration.room.contentRevision, throughSequence: 1, body: 'CUMULATIVE' })
  migration.sql.exec('ALTER TABLE summaries DROP COLUMN start_sequence')
  await migration.db.migrateExistingTables()
  assert.equal((await migration.repo.summaryFor(migration.a.id, migration.room.id, migration.room.contentRevision)).body, 'CUMULATIVE')
  console.log('PASS: additive summary migration preserves existing data')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  for (const { sql } of connections.values()) sql.close()
})
