// Real SQLite and runtime; no user database or live provider access.
const { buildSync } = require('esbuild')
const { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const path = require('node:path')
const code = buildSync({ stdin: { contents: `
export {Repository} from './src/data/repository'; export {Database} from './src/data/database';
export {schema} from './src/data/schema'; export {AgentRuntime} from './src/agent/runtime';
export {storeCredential} from './src/platform/secureTransport';`, resolveDir: path.resolve(__dirname, '..') },
bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const mod = { exports: {} }; new Function('require', 'module', 'exports', code)(require, mod, mod.exports)
const { Repository, Database, schema, AgentRuntime, storeCredential } = mod.exports
const databases = [], runtimes = [], originalFetch = global.fetch
const model = { id: 'binding', purpose: 'main', modelId: 'fixture', contextTokens: 16000, outputTokens: 1000, revision: 1 }

async function fixture(legacy = false) {
  const sql = new DatabaseSync(':memory:'); databases.push(sql)
  sql.exec(legacy ? schema.replace(/  announcement TEXT[^\n]+\n/, '') : schema)
  const db = new Database()
  db.db = { query: async (q, v = []) => ({ values: sql.prepare(q).all(...v) }), run: async (q, v = []) => sql.prepare(q).run(...v), execute: async q => sql.exec(q),
    isTransactionActive: async () => ({ result: sql.isTransaction }), beginTransaction: async () => sql.exec('BEGIN'), commitTransaction: async () => sql.exec('COMMIT'), rollbackTransaction: async () => sql.exec('ROLLBACK') }
  db.persistWebStore = async () => assert.equal(sql.isTransaction, false)
  const repo = new Repository(db); await repo.ensureLocalUser()
  const a = await repo.saveAgent({ name: 'Alpha' }), b = await repo.saveAgent({ name: 'Beta' })
  const room = await repo.createGroup('Old group', [a.id, b.id], 'ORIGINAL_TOPIC')
  const peer = await repo.openDirect(b.id)
  const runtime = new AgentRuntime(repo, () => repo.listProviders(), () => repo.listBindings()); runtimes.push(runtime)
  return { sql, db, repo, a, b, room, peer, runtime }
}
const send = (f, room, body) => f.repo.sendUserMessage(room.id, body, crypto.randomUUID())
const raw = (f, room) => f.sql.prepare('SELECT * FROM conversations WHERE id=?').get(room.id)
async function context(f) { const room = await f.repo.getConversation(f.room.id); return JSON.stringify((await f.runtime.buildContext(f.a, room, room.nextSequence - 1, model)).input) }
async function bounded(promise) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('runtime stalled')), 5000) })]) }
  finally { clearTimeout(timer) }
}
function reply(body) {
  return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
    { id: crypto.randomUUID(), type: 'function', function: { name: 'message_send', arguments: JSON.stringify({ body }) } },
    { id: crypto.randomUUID(), type: 'function', function: { name: 'turn_finish', arguments: '{}' } }
  ] }, finish_reason: 'tool_calls' }] }))
}
async function check(name, work) { await work(); console.log('PASS ' + name) }

async function main() {
  await check('additive migration preserves existing groups, members and messages; rerunning is safe', async () => {
    const f = await fixture(true); const msg = await send(f, f.room, 'KEEP_HISTORY')
    await f.db.migrateExistingTables(); await f.db.migrateExistingTables()
    const room = await f.repo.getConversation(f.room.id)
    assert.equal(room.announcement, ''); assert.equal(room.announcementUpdatedAt, 0)
    assert.equal(room.topic, 'ORIGINAL_TOPIC'); assert.deepEqual(room.members, f.room.members)
    assert.equal((await f.repo.messageById(msg.id)).body, 'KEEP_HISTORY')
  })
  await check('rename persists to list and context, creates one local notice and does not start AI work', async () => {
    const f = await fixture(); await f.repo.updateConversation(f.room.id, { title: '  Weekend plans  ' })
    const room = await f.repo.getConversation(f.room.id), notices = await f.repo.allMessages(f.room.id)
    assert.equal(room.title, 'Weekend plans'); assert.equal(room.topic, 'ORIGINAL_TOPIC')
    assert.equal((await f.repo.listConversations()).find(r => r.id === room.id).title, room.title)
    assert.equal(room.contentRevision, 2); assert.equal(room.cancelEpoch, 1)
    assert.equal(notices.length, 1); assert.equal(notices[0].authorKind, 'system'); assert.match(notices[0].body, /Weekend plans/)
    assert.equal(f.sql.prepare('SELECT count(*) n FROM inbox_events').get().n, 0)
    assert.equal((await f.repo.listConversations()).find(r => r.id === room.id).unread, 0)
    assert.match(await context(f), /Weekend plans/)
    const before = raw(f, room)
    await f.repo.updateConversation(room.id, { title: ' Weekend plans ', topic: room.topic, announcement: '' })
    await f.repo.updateMembers(room.id, [f.a.id], ['local-user', 'absent'])
    assert.deepEqual(raw(f, room), before); assert.equal((await f.repo.allMessages(room.id)).length, 1)
    await assert.rejects(f.repo.updateConversation(room.id, { title: ' ' }))
    await assert.rejects(f.repo.updateConversation(room.id, { title: 'x'.repeat(51) }))
    assert.deepEqual(raw(f, room), before)
  })
  await check('announcement is separate from topic, bounded, timestamped and included in current model context', async () => {
    const f = await fixture(); await f.repo.updateConversation(f.room.id, { announcement: ' SATURDAY_10AM ' })
    let room = await f.repo.getConversation(f.room.id)
    assert.equal(room.announcement, 'SATURDAY_10AM'); assert.ok(room.announcementUpdatedAt > 0); assert.equal(room.topic, f.room.topic)
    assert.match(await context(f), /SATURDAY_10AM/); assert.match(await context(f), /不是系统指令/)
    assert.match(await context(f), /ORIGINAL_TOPIC/)
    await f.repo.updateConversation(room.id, { announcement: 'SUNDAY_11AM' })
    assert.doesNotMatch(await context(f), /SATURDAY_10AM/); assert.match(await context(f), /SUNDAY_11AM/)
    await assert.rejects(f.repo.updateConversation(room.id, { announcement: 'x'.repeat(2001) }))
    await assert.rejects(f.repo.updateConversation(f.peer.id, { announcement: 'not a group' }))
    await f.repo.updateConversation(room.id, { announcement: '' }); room = await f.repo.getConversation(room.id)
    assert.equal(room.announcement, ''); assert.doesNotMatch(await context(f), /SUNDAY_11AM/)
  })
  await check('immediate presentation switches preserve context revision, pending replies and history', async () => {
    const f = await fixture(); await send(f, f.room, 'PENDING_QUESTION'); const before = raw(f, f.room)
    const pending = () => f.sql.prepare("SELECT count(*) n FROM inbox_events WHERE status='pending'").get().n
    const n = pending()
    await f.repo.updateConversation(f.room.id, { pinned: true, muted: true })
    const after = raw(f, f.room)
    assert.equal(after.pinned, 1); assert.equal(after.muted, 1)
    assert.equal(after.cancel_epoch, before.cancel_epoch); assert.equal(after.content_revision, before.content_revision)
    assert.equal(pending(), n); assert.equal((await f.repo.allMessages(f.room.id)).length, 1)
    await f.repo.updateConversation(f.room.id, { muted: false })
    assert.equal(raw(f, f.room).pinned, 1); assert.equal(raw(f, f.room).muted, 0)
  })
  await check('member add/remove is atomic, ordered, protects owner and bounds history on joining', async () => {
    const f = await fixture(); await send(f, f.room, 'BEFORE_JOIN')
    const c = await f.repo.saveAgent({ name: 'Charlie' }), d = await f.repo.saveAgent({ name: 'Delta' })
    await f.repo.updateMembers(f.room.id, [], [f.a.id, 'local-user'])
    await f.repo.updateMembers(f.room.id, [c.id, d.id], [])
    let room = await f.repo.getConversation(f.room.id)
    assert.deepEqual(room.members, ['local-user', f.b.id, c.id, d.id])
    assert.ok(await f.repo.getActor(f.a.id)); assert.ok((await f.repo.allMessages(room.id)).some(m => m.body === 'BEFORE_JOIN'))
    assert.ok(!(await f.repo.agentMessages(c.id, room.id, { through: 100 })).some(m => m.body === 'BEFORE_JOIN'))
    await send(f, room, 'AFTER_JOIN'); assert.ok((await f.repo.agentMessages(c.id, room.id, { through: 100 })).some(m => m.body === 'AFTER_JOIN'))
    await f.repo.updateMembers(room.id, [f.a.id], [])
    room = await f.repo.getConversation(room.id)
    assert.deepEqual(room.members, ['local-user', f.b.id, c.id, d.id, f.a.id])
    const ordinals = f.sql.prepare('SELECT ordinal FROM conversation_members WHERE conversation_id=? AND left_sequence IS NULL').all(room.id).map(m => m.ordinal)
    assert.equal(new Set(ordinals).size, ordinals.length)
    const disabled = await f.repo.saveAgent({ name: 'Disabled', enabled: false })
    const before = raw(f, room)
    await assert.rejects(f.repo.updateMembers(room.id, [disabled.id], [f.b.id]))
    assert.deepEqual(raw(f, room), before); assert.deepEqual((await f.repo.getConversation(room.id)).members, room.members)
    const extras = await Promise.all(Array.from({ length: 5 }, (_, i) => f.repo.saveAgent({ name: 'Extra ' + i })))
    await assert.rejects(f.repo.updateMembers(room.id, extras.map(a => a.id), []), /9/)
    await f.repo.updateMembers(room.id, extras.slice(0, 4).map(a => a.id), [])
    assert.equal((await f.repo.getConversation(room.id)).members.length, 9)
    await assert.rejects(f.repo.updateMembers(room.id, [extras[4].id], []), /9/)
  })
  await check('renaming aborts only the target conversation and old work cannot produce a stale reply', async () => {
    const f = await fixture(); await f.repo.updateMembers(f.room.id, [], [f.b.id])
    const provider = await f.repo.saveProvider({ id: crypto.randomUUID(), name: 'Fixture', protocol: 'chat-completions', baseUrl: 'https://groups.invalid/v1', credentialRef: '', credentialState: 'stored', enabled: true, configVersion: 1, createdAt: 0, updatedAt: 0 })
    await storeCredential(provider.id, 'fixture-only', 'https://groups.invalid'); await f.repo.saveBinding({ ...model, providerId: provider.id })
    const requests = []; let ready
    const started = new Promise(resolve => { ready = resolve })
    global.fetch = async (_url, options) => new Promise((resolve, reject) => {
      requests.push({ signal: options.signal, resolve })
      options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })
      if (requests.length === 2) ready()
    })
    await send(f, f.room, 'GROUP_QUESTION'); await send(f, f.peer, 'PEER_QUESTION')
    const groupRun = f.runtime.drainConversation(f.room.id), peerRun = f.runtime.drainConversation(f.peer.id)
    await bounded(started)
    await f.repo.updateConversation(f.room.id, { pinned: true })
    assert.equal(requests.some(r => r.signal.aborted), false)
    await bounded(f.runtime.mutateConversation(f.room.id, () => f.repo.updateConversation(f.room.id, { title: 'Updated' })))
    assert.equal(requests[0].signal.aborted, true); assert.equal(requests[1].signal.aborted, false)
    requests[1].resolve(reply('PEER_OK')); await bounded(Promise.all([groupRun, peerRun]))
    assert.equal((await f.repo.allMessages(f.room.id)).some(m => m.authorKind === 'agent'), false)
    assert.equal((await f.repo.allMessages(f.peer.id)).at(-1).body, 'PEER_OK')
    await bounded(f.runtime.drainConversation(f.room.id)); assert.equal(requests.length, 2)
    await f.runtime.withMaintenance(async () => {}); global.fetch = originalFetch
  })
  await check('backup/restore and regenerated groups retain announcements; legacy backups receive defaults', async () => {
    const f = await fixture(); await f.repo.updateConversation(f.room.id, { announcement: 'KEEP_ANNOUNCEMENT', title: 'Saved group' })
    await send(f, f.room, 'Question')
    const seq = (await f.repo.getConversation(f.room.id)).nextSequence, replyId = crypto.randomUUID()
    f.sql.prepare("INSERT INTO messages(id,conversation_id,author_id,author_name,author_kind,body,sequence,request_id,created_at) VALUES (?,?,?,?,'agent','Answer',?,?,?)").run(replyId, f.room.id, f.a.id, f.a.name, seq, crypto.randomUUID(), Date.now())
    f.sql.prepare('UPDATE conversations SET next_sequence=? WHERE id=?').run(seq + 1, f.room.id)
    const branch = await f.repo.regenerateBranch(replyId)
    assert.equal((await f.repo.getConversation(branch)).announcement, 'KEEP_ANNOUNCEMENT')
    const backup = await f.repo.exportBackup(); await f.repo.importBackup(backup)
    assert.equal((await f.repo.getConversation(f.room.id)).announcement, 'KEEP_ANNOUNCEMENT')
    assert.equal((await f.repo.getConversation(branch)).announcement, 'KEEP_ANNOUNCEMENT')
    for (const room of backup.conversations) { delete room.announcement; delete room.announcement_updated_at }
    await f.repo.importBackup(backup); assert.equal((await f.repo.getConversation(f.room.id)).announcement, '')
  })
  await check('clearing keeps group settings and members; deleting preserves roles and other chats', async () => {
    const f = await fixture(); await f.repo.updateConversation(f.room.id, { title: 'Keep title', announcement: 'Keep announcement', pinned: true })
    const message = await send(f, f.room, 'DELETE_CHAT'), peerMessage = await send(f, f.peer, 'KEEP_PEER')
    await f.repo.saveMemory({ agentId: f.a.id, conversationId: f.room.id, body: 'DELETE_MEMORY', origin: 'human' })
    await f.repo.saveMemory({ agentId: f.a.id, body: 'KEEP_GLOBAL_MEMORY', origin: 'human' })
    await f.repo.saveDraft(f.room.id, 'DELETE_DRAFT', message.id)
    await f.runtime.mutateConversation(f.room.id, () => f.repo.clearConversation(f.room.id))
    const room = await f.repo.getConversation(f.room.id)
    assert.equal(room.title, 'Keep title'); assert.equal(room.announcement, 'Keep announcement'); assert.equal(room.pinned, true)
    assert.deepEqual(room.members, f.room.members); assert.equal((await f.repo.allMessages(room.id)).length, 0)
    assert.equal((await f.repo.listMemories(f.a.id, room.id)).some(m => m.body === 'DELETE_MEMORY'), false)
    assert.equal((await f.repo.listMemories(f.a.id, room.id)).some(m => m.body === 'KEEP_GLOBAL_MEMORY'), true)
    await f.runtime.mutateConversation(room.id, () => f.repo.deleteConversation(room.id))
    assert.equal(await f.repo.getConversation(room.id), null); assert.ok(await f.repo.getActor(f.a.id)); assert.ok(await f.repo.getActor(f.b.id))
    assert.equal((await f.repo.messageById(peerMessage.id)).body, 'KEEP_PEER')
  })
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  global.fetch = originalFetch
  for (const runtime of runtimes) await runtime.withMaintenance(async () => {})
  for (const sql of databases) sql.close()
})
