const { buildSync } = require('esbuild')
const { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const path = require('node:path')

const compiled = buildSync({ stdin: { contents: `
export { Repository } from './src/data/repository'; export { Database } from './src/data/database';
export { schema } from './src/data/schema'; export { AgentRuntime } from './src/agent/runtime';
export { storeCredential } from './src/platform/secureTransport';`, resolveDir: path.resolve(__dirname, '..') },
  bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const mod = { exports: {} }
new Function('require', 'module', 'exports', compiled)(require, mod, mod.exports)
const { Repository, Database, schema, AgentRuntime, storeCredential } = mod.exports
const databases = []
const originalFetch = global.fetch
let activeRuntime

function fixture() {
  const sql = new DatabaseSync(':memory:'); sql.exec(schema); databases.push(sql)
  const db = new Database()
  db.db = {
    query: async (q, values = []) => ({ values: sql.prepare(q).all(...values) }),
    run: async (q, values = []) => sql.prepare(q).run(...values), execute: async q => sql.exec(q),
    isTransactionActive: async () => ({ result: sql.isTransaction }),
    beginTransaction: async () => sql.exec('BEGIN'), commitTransaction: async () => sql.exec('COMMIT'),
    rollbackTransaction: async () => sql.exec('ROLLBACK')
  }
  db.persistWebStore = async () => assert.equal(sql.isTransaction, false)
  return { sql, repo: new Repository(db) }
}

async function bounded(promise) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Runtime did not progress')), 4000) })]) }
  finally { clearTimeout(timer) }
}
function reply(body) {
  return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
    { id: crypto.randomUUID(), type: 'function', function: { name: 'message_send', arguments: JSON.stringify({ body }) } },
    { id: crypto.randomUUID(), type: 'function', function: { name: 'turn_finish', arguments: '{}' } }
  ] }, finish_reason: 'tool_calls' }] }), { headers: { 'content-type': 'application/json' } })
}

async function main() {
  const { repo, sql } = fixture(); await repo.ensureLocalUser()
  const a = await repo.saveAgent({ name: 'Original', persona: 'Keep this persona', bio: 'Keep this bio', speakingStyle: 'Brief', allowPrivate: false })
  const b = await repo.saveAgent({ name: 'Peer' })
  const direct = await repo.openDirect(a.id), peer = await repo.openDirect(b.id)
  const group = await repo.createGroup('Group title', [a.id, b.id])
  const avatar = 'data:image/png;base64,aGVsbG8='
  const edited = await repo.saveAgent({ id: a.id, name: a.name, avatarData: avatar })
  assert.equal(edited.persona, a.persona); assert.equal(edited.bio, a.bio)
  assert.equal(edited.allowPrivate, false); assert.equal(edited.profileVersion, a.profileVersion)
  assert.equal(edited.createdAt, a.createdAt); assert.equal(edited.avatarData, avatar)
  await repo.saveAgent({ id: a.id, name: 'Renamed' })
  assert.equal((await repo.getConversation(direct.id)).title, 'Renamed')
  assert.equal((await repo.getConversation(group.id)).title, 'Group title')
  const third = await repo.saveAgent({ name: 'Third peer' })
  const peerSource = await repo.createGroup('Peer source', [b.id, third.id])
  const privateRoom = await repo.openAgentDirect(peerSource.id, b.id, third.id)
  await repo.saveAgent({ id: third.id, name: 'Updated peer' })
  assert.equal((await repo.getConversation(privateRoom.id)).title, privateRoom.title.replace('Third peer', 'Updated peer'))
  console.log('PASS partial/avatar edits preserve existing settings; direct titles follow rename')

  const message = await repo.sendUserMessage(group.id, 'A shared question', crypto.randomUUID())
  const activity = await repo.ensureActivity(group.id)
  const retryRun = await repo.createRun(a.id, group.id, activity)
  const retry = await repo.scheduleRetry({ agentId: a.id, conversationId: group.id, activityId: activity, runId: retryRun,
    through: message.sequence, epoch: group.cancelEpoch, profileVersion: (await repo.getActor(a.id)).profileVersion, kind: 'http' })
  assert.ok(retry)
  await repo.finishRun(retryRun, 'failed', 'temporary error')
  await repo.saveMemory({ agentId: a.id, body: 'Kept memory', origin: 'human' })
  await repo.setAgentStatus(a.id, 'disabled')
  assert.equal(sql.prepare('SELECT status FROM retry_jobs WHERE id=?').get(retry.id).status, 'cancelled')
  assert.equal(sql.prepare('SELECT status FROM runs WHERE id=?').get(retryRun).status, 'cancelled')
  assert.equal(sql.prepare('SELECT status FROM inbox_events WHERE agent_id=? AND message_id=?').get(a.id, message.id).status, 'cancelled')
  assert.equal(sql.prepare('SELECT status FROM inbox_events WHERE agent_id=? AND message_id=?').get(b.id, message.id).status, 'pending')
  assert.equal((await repo.listMemories(a.id)).length, 1)
  assert.equal((await repo.allMessages(group.id)).length, 1)
  assert.equal((await repo.openDirect(a.id)).id, direct.id)
  await assert.rejects(repo.sendUserMessage(direct.id, 'Blocked', crypto.randomUUID()), /启用角色/)
  await assert.rejects(repo.createGroup('Blocked group', [a.id]), /已启用/)
  await repo.setAgentStatus(a.id, 'archived')
  assert.equal((await repo.getActor(a.id)).enabled, false)
  await repo.setAgentStatus(a.id, 'disabled')
  assert.equal((await repo.getActor(a.id)).archived, false)
  assert.equal((await repo.getActor(a.id)).enabled, false)
  await repo.setAgentStatus(a.id, 'active')
  assert.equal(sql.prepare('SELECT status FROM inbox_events WHERE agent_id=? AND message_id=?').get(a.id, message.id).status, 'cancelled')
  await assert.rejects(repo.saveAgent({ id: 'local-user', name: 'Wrong' }), /个人资料/)
  await assert.rejects(repo.deleteAgent('local-user'), /角色不存在/)
  console.log('PASS disable/archive/restore retain history, retire old work, and leave peer work eligible')

  const provider = await repo.saveProvider({ id: crypto.randomUUID(), name: 'Fixture', protocol: 'chat-completions',
    baseUrl: 'https://roles.invalid/v1', credentialRef: '', credentialState: 'stored', enabled: true, configVersion: 1, createdAt: 0, updatedAt: 0 })
  const binding = { id: crypto.randomUUID(), providerId: provider.id, modelId: 'fixture', purpose: 'main', contextTokens: 16000, outputTokens: 1000, revision: 1 }
  await assert.rejects(repo.saveAgentDetails({ id: a.id, name: 'Should roll back' }, {
    privateMemo: 'Should roll back too', modelBindings: [{ ...binding, contextTokens: 1000 }]
  }), /配置无效/)
  assert.equal((await repo.getActor(a.id)).name, 'Renamed')
  assert.equal((await repo.listMemories(a.id)).some(item => item.kind === 'private-note'), false)
  await repo.saveAgentDetails({ id: a.id, name: 'Renamed' }, { privateMemo: 'Private memo', modelBindings: [binding] })
  assert.equal((await repo.listBindings()).find(item => item.agentId === a.id).modelId, 'fixture')
  assert.equal((await repo.listMemories(a.id)).find(item => item.kind === 'private-note').body, 'Private memo')
  console.log('PASS profile, memo and independent model save atomically; invalid models roll everything back')

  await repo.saveBinding(binding)
  await storeCredential(provider.id, 'fixture-only', 'https://roles.invalid')
  const runtime = new AgentRuntime(repo, () => repo.listProviders(), () => repo.listBindings())
  activeRuntime = runtime
  const requests = []
  let notifyRequests
  let notifyFirst
  const started = new Promise(resolve => { notifyRequests = resolve })
  const firstStarted = new Promise(resolve => { notifyFirst = resolve })
  global.fetch = async (_url, options) => new Promise((resolve, reject) => {
    const entry = { signal: options.signal, resolve }; requests.push(entry)
    options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    if (requests.length === 1) notifyFirst()
    if (requests.length === 2) notifyRequests()
  })
  await repo.sendUserMessage(direct.id, 'Target question', crypto.randomUUID())
  const runningA = runtime.drainConversation(direct.id)
  await bounded(firstStarted)
  await repo.sendUserMessage(peer.id, 'Peer question', crypto.randomUUID())
  const runningB = runtime.drainConversation(peer.id)
  await bounded(started)
  await bounded(runtime.mutateAgent(b.id, () => repo.saveAgent({ id: b.id, name: b.name, avatarData: avatar })))
  assert.equal(requests[1].signal.aborted, false, 'Changing only the avatar must not interrupt a reply')
  await bounded(runtime.mutateAgent(b.id, () => repo.saveAgentDetails({ id: b.id, name: b.name }, { privateMemo: '' })))
  assert.equal(requests[1].signal.aborted, false, 'Saving unchanged settings must not interrupt a reply')
  await bounded(runtime.mutateAgent(a.id, () => repo.setAgentStatus(a.id, 'disabled')))
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(requests[1].signal.aborted, false)
  requests[1].resolve(reply('Peer finishes normally'))
  await bounded(Promise.all([runningA, runningB]))
  assert.equal((await repo.allMessages(direct.id)).some(item => item.authorKind === 'agent'), false)
  assert.equal((await repo.allMessages(peer.id)).at(-1).body, 'Peer finishes normally')
  await runtime.mutateAgent(a.id, () => repo.setAgentStatus(a.id, 'active'))
  await bounded(runtime.drainConversation(direct.id)); assert.equal(requests.length, 2)
  global.fetch = async () => reply('New settings are active')
  await repo.sendUserMessage(direct.id, 'New question', crypto.randomUUID())
  await bounded(runtime.drainConversation(direct.id))
  assert.equal((await repo.allMessages(direct.id)).at(-1).body, 'New settings are active')
  await runtime.withMaintenance(async () => {})
  console.log('PASS disable aborts only that actor; enable does not replay old questions and accepts new ones')

  await repo.deleteAgent(a.id)
  assert.equal(await repo.getActor(a.id), null)
  assert.equal((await repo.allMessages(direct.id)).at(-1).body, 'New settings are active')
  console.log('PASS deleting a role preserves historical messages')
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  global.fetch = originalFetch
  if (activeRuntime) await activeRuntime.withMaintenance(async () => {})
  for (const sql of databases) sql.close()
})
