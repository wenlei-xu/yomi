// Regression checks against real Repository SQL and Runtime methods; no external API calls.
const { buildSync } = require('esbuild')
const { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const compiled = buildSync({ stdin: { contents: `
export {Repository} from './src/data/repository'; export {Database} from './src/data/database';
export {schema} from './src/data/schema'; export {AgentRuntime} from './src/agent/runtime';
export {storeCredential,secureRequest} from './src/platform/secureTransport';
export {resolveBinding} from './src/agent/policy'; export {AgentQueue} from './src/agent/scheduler';
export {CommandGate} from './src/app/maintenance'; export {encryptBackup,decryptBackup} from './src/data/backupCrypto';
export {RequestGate,assertContextFits} from './src/agent/limits';
export {validateToolCall} from './src/agent/tools'; export {callModel} from './src/model/protocol';`, resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const mod = { exports: {} }
new Function('require', 'module', 'exports', compiled)(require, mod, mod.exports)
const { Repository, Database, schema, AgentRuntime, storeCredential, RequestGate,
  assertContextFits, validateToolCall, secureRequest, callModel, resolveBinding, AgentQueue,
  CommandGate, encryptBackup, decryptBackup } = mod.exports
const passed = []
const nativeFetch = global.fetch
let decisionResponder = () => ({ mode: 'each', actionable: false })
let responder = () => ({ text: '', calls: [{ name: 'turn_finish', arguments: {} }] })
global.fetch = async (url, options) => {
  assert.match(String(url), /^https:\/\/audit\.invalid\//)
  if (options.signal.aborted) throw new Error('cancelled')
  const request = JSON.parse(options.body)
  const value = /为群聊选择|判断角色是否应/.test(request.instructions ?? '')
    ? { text: JSON.stringify(await decisionResponder(request)), calls: [] }
    : await responder(request, options.signal)
  if (value.httpStatus) return new Response('unavailable', { status: value.httpStatus })
  if (options.signal.aborted) throw new Error('cancelled')
  const calls = (value.calls ?? []).map(call => ({ id: crypto.randomUUID(), ...call }))
  return new Response(JSON.stringify(String(url).endsWith('/responses') ? {
    output: [...(value.text ? [{ type: 'message', content: [{ type: 'output_text', text: value.text }] }] : []),
      ...calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }))],
    usage: { input_tokens: 10, output_tokens: 10 }
  } : { choices: [{ message: { content: value.text ?? '', tool_calls: calls.map(call => ({ id: call.id,
    type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10 } }))
}
async function fixture() {
  const sql = new DatabaseSync(':memory:')
  sql.exec(schema)
  let active = false
  const connection = {
    query: async (q, values = []) => ({ values: sql.prepare(q).all(...values) }),
    run: async (q, values = []) => sql.prepare(q).run(...values),
    isTransactionActive: async () => ({ result: active }),
    beginTransaction: async () => { sql.exec('BEGIN IMMEDIATE'); active = true },
    commitTransaction: async () => { sql.exec('COMMIT'); active = false },
    rollbackTransaction: async () => { sql.exec('ROLLBACK'); active = false }
  }
  const database = new Database()
  database.db = connection
  const repo = new Repository(database)
  await repo.ensureLocalUser()
  const a = await repo.saveAgent({ name: 'Alpha' })
  const b = await repo.saveAgent({ name: 'Beta' })
  const room = await repo.createGroup('audit', [a.id, b.id])
  const provider = { id: crypto.randomUUID(), name: 'Audit', protocol: 'responses', baseUrl: 'https://audit.invalid/v1',
    credentialState: 'stored', credentialRef: '', enabled: true, configVersion: 1, createdAt: 0, updatedAt: 0 }
  await repo.saveProvider(provider)
  const binding = { id: crypto.randomUUID(), providerId: provider.id, modelId: 'audit', contextTokens: 16000,
    outputTokens: 1000, purpose: 'main', revision: 1 }
  await repo.saveBinding(binding)
  await storeCredential(provider.id, 'audit-only-no-real-key', 'https://audit.invalid')
  const runtime = new AgentRuntime(repo, () => repo.listProviders(), () => repo.listBindings())
  // Dispatch is driven explicitly so tests leave no timer or user database behind.
  runtime.wakeConversation = () => {}
  return { sql, database, repo, a, b, room, binding, provider, runtime }
}
async function context(f, agent = f.a, room = f.room, through = 0, roundMessageId) {
  const activityId = await f.repo.ensureActivity(room.id)
  const runId = await f.repo.createRun(agent.id, room.id, activityId, roundMessageId)
  return { agent, conversation: room, activityId, runId, expectedEpoch: room.cancelEpoch,
    seenThrough: through, visibleThrough: through, roundMessageId, input: [],
    openedConversationId: null, remainingPosts: 1, remainingSidePosts: 2 }
}
async function tool(f, ctx, name, args, id = crypto.randomUUID()) {
  return f.runtime.executeTool({ id, name, arguments: args }, ctx)
}
async function check(name, work) {
  console.error(`running: ${name}`)
  // A leaked timer or unsettled promise must fail this check, not hang the run.
  let timer
  try {
    await Promise.race([
      work(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`CHECK TIMEOUT after 60s`)), 60_000) })
    ])
  } finally { clearTimeout(timer) }
  passed.push(name)
}
async function main() {
  await check('A01: private inbox dispatch and natural finish', async () => {
    const f = await fixture()
    const dm = await f.repo.openAgentDirect(f.room.id, f.a.id, f.b.id)
    const ctx = await context(f, f.a, dm)
    await tool(f, ctx, 'message_send', { body: 'private opening' })
    let calls = 0
    responder = () => { calls++; return { calls: [{ name: 'turn_finish', arguments: {} }] } }
    await f.runtime.drainConversation(dm.id)
    assert.equal(calls, 1)
    assert.equal((await f.repo.pendingInbox(f.b.id, undefined, dm.id)).length, 0)
    f.sql.close()
  })
  await check('A02/A06: same-round replies visible; next human excluded from read/search/context', async () => {
    const f = await fixture()
    const human = await f.repo.sendUserMessage(f.room.id, 'FIRST', 'first')
    const ctx = await context(f, f.a, f.room, 1, human.id)
    await f.repo.claimInbox(f.a.id, f.room.id, 1)
    await f.repo.sendUserMessage(f.room.id, 'FUTURE', 'next')
    assert.equal((await tool(f, ctx, 'message_send', { body: 'FIRST REPLY' })).posted, true)
    await f.repo.markInboxHandled(f.a.id, f.room.id, 1, 'done')
    const beta = await context(f, f.b, f.room, 1, human.id)
    const read = await tool(f, beta, 'conversation_read', {})
    assert.match(read.content, /FIRST REPLY/)
    assert.doesNotMatch(read.content, /FUTURE/)
    assert.match(read.content, /id=/)
    assert.doesNotMatch((await tool(f, beta, 'conversation_search', { query: 'FUTURE' })).content, /FUTURE/)
    const input = await f.runtime.buildContext(f.b, f.room, 1, f.binding, human.id)
    assert.match(JSON.stringify(input.input), /FIRST REPLY/)
    assert.doesNotMatch(JSON.stringify(input.input), /FUTURE/)
    f.sql.close()
  })
  await check('A03: foreign and manual memories cannot be deleted by Agent', async () => {
    const f = await fixture(), ctx = await context(f)
    const foreign = await f.repo.saveMemory({ agentId: f.b.id, body: 'private', origin: 'agent' })
    assert.match((await tool(f, ctx, 'memory_remove', { memoryId: foreign.id })).content, /错误/)
    assert.equal((await f.repo.listMemories(f.b.id)).length, 1)
    const manual = await f.repo.saveMemory({ agentId: f.a.id, body: 'manual', origin: 'human' })
    assert.match((await tool(f, ctx, 'memory_remove', { memoryId: manual.id })).content, /错误/)
    f.sql.close()
  })
  await check('A04: stop rejects all old write tools and invalidates summary', async () => {
    const f = await fixture(), ctx = await context(f)
    await f.repo.stopConversation(f.room.id)
    for (const [name, args] of [['memory_write', { body: 'LATE' }], ['direct_open', { targetAgentId: f.b.id }],
      ['group_create', { title: 'LATE', memberIds: [f.b.id] }], ['message_send', { body: 'LATE' }]]) {
      assert.match((await tool(f, ctx, name, args)).content, /CANCELLED/)
    }
    assert.equal((await f.repo.listMemories(f.a.id)).length, 0)
    assert.equal((await f.repo.listWhispers()).length, 0)
    await f.repo.saveSummary({ agentId: f.a.id, conversationId: f.room.id, contentRevision: f.room.contentRevision,
      expectedEpoch: 0, profileVersion: 1, throughSequence: 1, body: 'LATE' })
    assert.equal(await f.repo.summaryFor(f.a.id, f.room.id, f.room.contentRevision), null)
    f.sql.close()
  })
  await check('A05: archived/profile-changed Agent cannot commit stale tools', async () => {
    const f = await fixture(), ctx = await context(f)
    await f.repo.saveAgent({ ...f.a, archived: true, enabled: false })
    assert.match((await tool(f, ctx, 'message_send', { body: 'LATE' })).content, /CANCELLED/)
    assert.match((await tool(f, ctx, 'memory_write', { body: 'LATE' })).content, /CANCELLED/)
    f.sql.close()
  })
  await check('A07: summary coverage is exact and incremental, survives append; deletion invalidates', async () => {
    const f = await fixture()
    for (let n = 1; n <= 450; n++) f.sql.prepare('INSERT INTO messages(id,conversation_id,author_id,author_name,author_kind,body,sequence,request_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(`m${n}`, f.room.id, f.a.id, 'Alpha', 'agent', `body-${n}`, n, `r${n}`, n)
    f.sql.prepare('UPDATE conversations SET next_sequence=451 WHERE id=?').run(f.room.id)
    await f.repo.saveBinding({ ...f.binding, contextTokens: 100000 })
    const ctx = await context(f)
    responder = () => ({ text: 'summary', calls: [] })
    await f.runtime.compactIfNeeded(f.a, f.room, 450, new AbortController(), ctx.runId, ctx.activityId, { ...f.binding, contextTokens: 100000 })
    let summary = await f.repo.summaryFor(f.a.id, f.room.id, f.room.contentRevision)
    assert.equal(summary.throughSequence, 400)
    await f.runtime.compactIfNeeded(f.a, f.room, 450, new AbortController(), ctx.runId, ctx.activityId, { ...f.binding, contextTokens: 100000 })
    summary = await f.repo.summaryFor(f.a.id, f.room.id, f.room.contentRevision)
    assert.equal(summary.throughSequence, 426)
    assert.equal((await f.repo.activityBudget(ctx.activityId)).modelCalls, 2)
    await f.repo.sendUserMessage(f.room.id, 'APPEND', 'append')
    assert.ok(await f.repo.summaryFor(f.a.id, f.room.id, f.room.contentRevision))
    await f.repo.deleteMessage('m100')
    assert.equal(await f.repo.summaryFor(f.a.id, f.room.id, f.room.contentRevision), null)
    f.sql.close()
  })
  await check('A08: HELD and read advance seen; revised reply commits', async () => {
    const f = await fixture()
    await f.repo.sendUserMessage(f.room.id, 'FIRST', 'first')
    const ctx = await context(f, f.a, f.room, 1)
    await f.repo.sendUserMessage(f.room.id, 'NEW PEER', 'second')
    const held = await tool(f, ctx, 'message_send', { body: 'old' })
    assert.match(held.content, /HELD/)
    assert.equal(held.seenThrough, 2)
    const read = await tool(f, ctx, 'conversation_read', {})
    assert.match(read.content, /NEW PEER/)
    ctx.seenThrough = read.seenThrough
    assert.equal((await tool(f, ctx, 'message_send', { body: 'revised' })).posted, true)
    f.sql.close()
  })
  await check('A09: memory, reactions, groups idempotent; changed payload rejected', async () => {
    const f = await fixture(), ctx = await context(f)
    await tool(f, ctx, 'memory_write', { body: 'ONCE' }, 'one')
    await tool(f, ctx, 'memory_write', { body: 'ONCE' }, 'one')
    assert.equal((await f.repo.listMemories(f.a.id)).length, 1)
    assert.match((await tool(f, ctx, 'memory_write', { body: 'CHANGED' }, 'one')).content, /冲突/)
    await tool(f, ctx, 'group_create', { title: 'Title', memberIds: [f.b.id] }, 'group')
    await tool(f, ctx, 'group_create', { title: 'Title', memberIds: [f.b.id] }, 'group')
    const groups = await f.repo.listWhispers()
    assert.equal(groups.length, 1); assert.equal(groups[0].title, 'Title')
    const message = await f.repo.sendUserMessage(f.room.id, 'react', 'react')
    ctx.seenThrough = ctx.visibleThrough = message.sequence
    await tool(f, ctx, 'message_react', { messageId: message.id, emoji: '❤️' }, 'react')
    await tool(f, ctx, 'message_react', { messageId: message.id, emoji: '❤️' }, 'react')
    assert.equal((await f.repo.messageById(message.id)).reactions.length, 1)
    f.sql.close()
  })
  await check('Public reply and private opening use independent quotas, reused private room allowed', async () => {
    const f = await fixture(), ctx = await context(f)
    const opened = await tool(f, ctx, 'direct_open', { targetAgentId: f.b.id })
    ctx.openedConversationId = opened.openedConversationId
    assert.equal((await tool(f, ctx, 'message_send', { body: 'PUBLIC' })).posted, true)
    ctx.remainingPosts = 0
    assert.equal((await tool(f, ctx, 'message_send', { body: 'PRIVATE', conversationId: ctx.openedConversationId })).sidePosted, true)
    assert.equal((await f.repo.listMessages(f.room.id)).length, 1)
    const betaDm = await context(f, f.b, await f.repo.getConversation(ctx.openedConversationId), 1)
    await tool(f, betaDm, 'message_send', { body: 'NEW PRIVATE PEER' })
    const reused = await context(f)
    const reopened = await tool(f, reused, 'direct_open', { targetAgentId: f.b.id })
    reused.openedConversationId = reopened.openedConversationId
    const held = await tool(f, reused, 'message_send', { body: 'STALE PRIVATE', conversationId: reused.openedConversationId })
    assert.match(held.content, /HELD/)
    reused.seenByConversation = new Map([[held.seenConversationId, held.seenThrough]])
    assert.equal((await tool(f, reused, 'message_send', { body: 'FRESH PRIVATE', conversationId: reused.openedConversationId })).sidePosted, true)
    f.sql.close()
  })
  await check('Model tool batch strictly capped at 24, schemas checked, context budget enforced', async () => {
    const f = await fixture()
    const human = await f.repo.sendUserMessage(f.room.id, 'START', 'start')
    responder = () => ({ calls: Array.from({ length: 30 }, (_, n) => ({ name: 'memory_write', arguments: { body: `entry-${n}` } })) })
    await f.runtime.runConversation(f.a, f.room.id, [human], new AbortController(), 1, human.id)
    assert.equal((await f.repo.listMemories(f.a.id)).length, 24)
    assert.throws(() => validateToolCall('memory_write', { body: 'ok', extra: true }))
    assert.throws(() => validateToolCall('memory_write', null))
    assert.throws(() => assertContextFits({ instructions: 'x'.repeat(20000), input: [], maxOutputTokens: 1000 }, 1024))
    f.sql.close()
  })
  await check('New member cannot read history before joining', async () => {
    const f = await fixture()
    await f.repo.sendUserMessage(f.room.id, 'OLD SECRET', 'old')
    const c = await f.repo.saveAgent({ name: 'New' })
    await f.repo.updateMembers(f.room.id, [c.id], [])
    await f.repo.sendUserMessage(f.room.id, 'NEW', 'new')
    const visible = await f.repo.agentMessages(c.id, f.room.id, { through: 100 })
    assert.equal(visible.length, 1); assert.equal(visible[0].body, 'NEW')
    f.sql.close()
  })
  await check('Atomic activity budget rejects call 65', async () => {
    const f = await fixture(), ctx = await context(f)
    for (let n = 0; n < 64; n++) await f.repo.reserveModelCall(ctx.activityId)
    await assert.rejects(f.repo.reserveModelCall(ctx.activityId), /预算/)
    f.sql.close()
  })
  await check('Request gate limits parallelism, cancels queued and pre-aborted requests', async () => {
    const gate = new RequestGate(1), first = new AbortController(), second = new AbortController()
    let release, started = 0
    const pending = gate.run(first.signal, async () => { started++; await new Promise(resolve => { release = resolve }) })
    await new Promise(resolve => setImmediate(resolve))
    const waiting = gate.run(second.signal, async () => { started++ })
    second.abort(); await assert.rejects(waiting, /cancelled/)
    release(); await pending; assert.equal(started, 1)
    await assert.rejects(secureRequest('unused', 'https://audit.invalid/', '{}', second.signal), /cancelled/)
  })
  await check('Both provider protocols complete a real Runtime tool loop', async () => {
    for (const protocol of ['responses', 'chat-completions']) {
      const f = await fixture()
      await f.repo.saveProvider({ ...f.provider, protocol })
      const human = await f.repo.sendUserMessage(f.room.id, 'HELLO', 'hello')
      let hop = 0
      responder = () => ({ calls: [{ name: ++hop === 1 ? 'memory_write' : hop === 2 ? 'message_send' : 'turn_finish',
        arguments: hop === 1 ? { body: 'remember' } : hop === 2 ? { body: 'HELLO BACK' } : {} }] })
      await f.runtime.runConversation(f.a, f.room.id, [human], new AbortController(), 1, human.id)
      assert.equal((await f.repo.listMessages(f.room.id)).at(-1).body, 'HELLO BACK')
      assert.equal((await f.repo.listMemories(f.a.id)).length, 1)
      assert.equal((await f.repo.listModelCalls()).length, 3)
      f.sql.close()
    }
  })
  await check('Live group drain steers correction before accepting a stale reply', async () => {
    const f = await fixture()
    await f.repo.sendUserMessage(f.room.id, 'ROUND ONE', 'one')
    const requests = []
    let injected = false
    responder = async request => {
      const text = JSON.stringify(request.input)
      const alpha = request.instructions.includes('「Alpha」')
      const toolCount = request.input.filter(item => item.type === 'function_call').length
      requests.push({ alpha, text })
      if (alpha && !injected) {
        injected = true
        await f.repo.sendUserMessage(f.room.id, 'ROUND TWO', 'two')
      }
      if (text.includes('已发送')) return { calls: [{ name: 'turn_finish', arguments: {} }] }
      const round = text.includes('ROUND TWO') ? 'TWO' : 'ONE'
      return { calls: [{ name: 'message_send', arguments: { body: `${alpha ? 'A' : 'B'}-${round}` } }] }
    }
    await f.runtime.drainConversation(f.room.id)
    assert.deepEqual((await f.repo.listMessages(f.room.id)).map(m => m.body),
      ['ROUND ONE', 'ROUND TWO', 'A-TWO', 'B-TWO'])
    const firstBeta = requests.find(item => !item.alpha)
    assert.match(firstBeta.text, /A-TWO/)
    assert.match(firstBeta.text, /ROUND TWO/)
    f.sql.close()
  })
  await check('Stop aborts in-flight summary; restart leaves no automatic work replay', async () => {
    const f = await fixture()
    for (let n = 1; n <= 80; n++) await f.repo.sendUserMessage(f.room.id, `history-${n}`, `history-${n}`)
    const human = await f.repo.sendUserMessage(f.room.id, 'RUN', 'run')
    let started
    const requested = new Promise(resolve => { started = resolve })
    responder = async (_request, signal) => {
      started()
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    }
    const work = f.runtime.runInConversation(f.a.id, f.room.id, human.sequence, human.id)
    await requested
    f.runtime.stopConversation(f.room.id)
    await work
    assert.equal((await f.repo.getConversation(f.room.id)).paused, true)
    assert.equal((await f.repo.listModelCalls()).filter(call => call.purpose === 'summary').length, 1)
    assert.equal((await f.repo.listModelCalls())[0].status, 'cancelled')
    let restartCalls = 0
    responder = () => { restartCalls++; return { calls: [] } }
    const restarted = new AgentRuntime(f.repo, () => f.repo.listProviders(), () => f.repo.listBindings())
    await restarted.start()
    assert.equal(restartCalls, 0)
    f.sql.close()
  })
  await check('Background blocks queued drain and does not auto-wake on return', async () => {
    const f = await fixture()
    await f.repo.sendUserMessage(f.room.id, 'queued', 'queued')
    let calls = 0
    responder = () => { calls++; return { calls: [] } }
    f.runtime.setForeground(false)
    await f.runtime.drainConversation(f.room.id)
    f.runtime.setForeground(true)
    assert.equal(calls, 0)
    assert.equal((await f.repo.pendingInbox(f.a.id)).length, 1)
    f.sql.close()
  })
  await check('Same-batch read cannot authorize an old draft before model sees tool result', async () => {
    const f = await fixture()
    const human = await f.repo.sendUserMessage(f.room.id, 'FIRST', 'one')
    let hop = 0
    responder = async () => {
      if (++hop === 1) {
        await f.repo.sendUserMessage(f.room.id, 'NEW PEER', 'two')
        return { calls: [{ name: 'conversation_read', arguments: {} },
          { name: 'message_send', arguments: { body: 'OLD DRAFT' } }] }
      }
      if (hop === 2) return { calls: [{ name: 'message_send', arguments: { body: 'REVISED' } }] }
      return { calls: [{ name: 'turn_finish', arguments: {} }] }
    }
    await f.runtime.runConversation(f.a, f.room.id, [human], new AbortController(), 1)
    const messages = await f.repo.listMessages(f.room.id)
    assert.equal(messages.some(m => m.body === 'OLD DRAFT'), false)
    assert.equal(messages.at(-1).body, 'REVISED')
    f.sql.close()
  })
  await check('Semantic routing elects one responder; group members may remain silent', async () => {
    const f = await fixture()
    await f.repo.sendUserMessage(f.room.id, 'a concrete question', 'question')
    decisionResponder = () => ({ mode: 'one-of-us', primary: f.b.id, actionable: false })
    responder = request => ({ calls: [{ name: JSON.stringify(request.input).includes('已发送') ? 'turn_finish' : 'message_send',
      arguments: JSON.stringify(request.input).includes('已发送') ? {} : { body: 'Beta owns this answer' } }] })
    await f.runtime.drainConversation(f.room.id)
    const replies = (await f.repo.listMessages(f.room.id)).filter(item => item.authorKind === 'agent')
    assert.equal(replies.length, 1); assert.equal(replies[0].authorId, f.b.id)
    const other = await f.repo.createGroup('silence', [f.a.id])
    await f.repo.sendUserMessage(other.id, 'already answered elsewhere', 'silence')
    responder = () => ({ calls: [{ name: 'turn_finish', arguments: { reason: 'already answered' } }] })
    await f.runtime.drainConversation(other.id)
    assert.equal((await f.repo.listRuntimeIssues()).length, 0)
    decisionResponder = () => ({ mode: 'each', actionable: false })
    f.sql.close()
  })
  await check('Agent-only triage can stop a repeated group exchange without invoking main model', async () => {
    const f = await fixture()
    const room = await f.repo.createAgentGroup(f.room.id, f.a.id, [f.b.id], 'discussion')
    const ctx = await context(f, f.a, room)
    await tool(f, ctx, 'message_send', { body: 'Thanks again' })
    let mainCalls = 0
    responder = () => { mainCalls++; return { calls: [] } }
    decisionResponder = () => ({ actionable: false })
    await f.runtime.drainConversation(room.id)
    assert.equal(mainCalls, 0)
    assert.equal((await f.repo.listModelCalls()).filter(call => call.purpose === 'triage').length, 1)
    decisionResponder = () => ({ mode: 'each', actionable: false })
    f.sql.close()
  })
  await check('Per-Agent model override, inheritance and backup round trip', async () => {
    const f = await fixture()
    await f.repo.saveBinding({ ...f.binding, id: 'override', agentId: f.a.id, modelId: 'alpha-model' })
    let bindings = await f.repo.listBindings()
    assert.equal(resolveBinding(bindings, 'main', f.a.id).modelId, 'alpha-model')
    assert.equal(resolveBinding(bindings, 'main', f.b.id).modelId, 'audit')
    assert.equal(resolveBinding(bindings, 'summary', f.a.id).modelId, 'alpha-model')
    const copied = await f.repo.copyAgent(f.a.id)
    assert.equal(resolveBinding(await f.repo.listBindings(), 'main', copied.id).modelId, 'alpha-model')
    assert.equal((await f.repo.listMemories(copied.id)).length, 0)
    const dm = await f.repo.openDirect(f.a.id)
    await f.repo.sendUserMessage(dm.id, 'hello', 'override')
    let models = []
    responder = request => {
      models.push(request.model)
      return { calls: [{ name: JSON.stringify(request.input).includes('已发送') ? 'turn_finish' : 'message_send',
        arguments: JSON.stringify(request.input).includes('已发送') ? {} : { body: 'configured' } }] }
    }
    await f.runtime.drainConversation(dm.id)
    assert.ok(models.length); assert.ok(models.every(model => model === 'alpha-model'))
    const backup = await f.repo.exportBackup()
    await f.repo.importBackup(backup)
    assert.equal(resolveBinding(await f.repo.listBindings(), 'main', f.a.id).modelId, 'alpha-model')
    await f.repo.clearAgentBinding(f.a.id, 'main')
    assert.equal(resolveBinding(await f.repo.listBindings(), 'main', f.a.id).modelId, 'audit')
    f.sql.close()
  })
  await check('Agent queue serializes with priority and cancels pending room work', async () => {
    const queue = new AgentQueue(), order = []
    let release
    const running = queue.enqueue('a', 'active', 0, async () => {
      order.push('active'); await new Promise(resolve => { release = resolve })
    })
    const low = queue.enqueue('a', 'peer', 0, async () => { order.push('peer') })
    const high = queue.enqueue('a', 'human', 3, async () => { order.push('human') })
    const cancelled = queue.enqueue('a', 'cancelled', 5, async () => { order.push('cancelled') })
    queue.cancel('cancelled'); release()
    await Promise.all([running, low, high, cancelled])
    assert.deepEqual(order, ['active', 'human', 'peer'])
  })
  await check('429 receives bounded retry before side effects; authentication failure never retries', async () => {
    const f = await fixture()
    const dm = await f.repo.openDirect(f.a.id)
    await f.repo.sendUserMessage(dm.id, 'retry', 'retry')
    let attempts = 0
    responder = request => {
      attempts++
      if (attempts <= 2) return { httpStatus: 429 }
      return { calls: [{ name: JSON.stringify(request.input).includes('已发送') ? 'turn_finish' : 'message_send',
        arguments: JSON.stringify(request.input).includes('已发送') ? {} : { body: 'recovered' } }] }
    }
    await f.runtime.drainConversation(dm.id)
    assert.equal((await f.repo.listMessages(dm.id)).at(-1).body, 'recovered')
    assert.equal((await f.repo.listModelCalls()).filter(call => call.errorCode === 'http_429').length, 2)
    const second = await f.repo.openDirect(f.b.id)
    await f.repo.sendUserMessage(second.id, 'authentication', 'auth')
    attempts = 0
    responder = () => { attempts++; return { httpStatus: 401 } }
    await f.runtime.drainConversation(second.id)
    assert.equal(attempts, 1)
    const c = await f.repo.saveAgent({ name: 'cancel during backoff' })
    const third = await f.repo.openDirect(c.id)
    await f.repo.sendUserMessage(third.id, 'cancel a retry wait', 'cancel-backoff')
    const record = f.repo.recordModelCall.bind(f.repo)
    f.repo.recordModelCall = async input => {
      await record(input)
      if (input.agentId === c.id && input.errorCode === 'http_429') f.runtime.stopConversation(third.id)
    }
    responder = () => ({ httpStatus: 429 })
    await f.runtime.drainConversation(third.id)
    assert.equal((await f.repo.listModelCalls()).filter(call => call.agentId === c.id).length, 1)
    assert.equal(f.runtime.snapshot().waiting.length, 0)
    f.sql.close()
  })
  await check('Private room reuse inherits the triggering activity; stop follows causal work, not room provenance', async () => {
    const f = await fixture()
    const sourceB = await f.repo.createGroup('independent source', [f.a.id, f.b.id])
    const dm = await f.repo.openAgentDirect(f.room.id, f.a.id, f.b.id)
    const activityA = await f.repo.ensureActivity(f.room.id)
    const activityB = await f.repo.ensureActivity(sourceB.id)
    const rootA = await f.repo.createRun(f.a.id, f.room.id, activityA)
    const rootB = await f.repo.createRun(f.a.id, sourceB.id, activityB)
    const sent = await f.repo.sendAgentMessage({ actionId: 'from-B', runId: rootB, authorId: f.a.id,
      conversationId: dm.id, body: 'B opening in reused room', expectedEpoch: dm.cancelEpoch,
      seenThrough: 0, activityId: activityB })
    assert.equal(sent.status, 'sent')
    assert.equal(await f.repo.ensureActivity(dm.id, sent.message.id), activityB)
    const childB = await f.repo.createRun(f.b.id, dm.id, activityB, null, [sent.message.id])
    const group = await f.repo.createAgentGroup(dm.id, f.b.id, [f.a.id], 'descendant')
    const next = await f.repo.sendAgentMessage({ actionId: 'B descendant', runId: childB, authorId: f.b.id,
      conversationId: group.id, body: 'child opening', expectedEpoch: group.cancelEpoch,
      seenThrough: 0, activityId: activityB })
    const grandchild = await f.repo.createRun(f.a.id, group.id, activityB, null, [next.message.id])
    await f.repo.stopConversation(f.room.id)
    assert.equal(f.sql.prepare('SELECT status FROM runs WHERE id=?').get(rootA).status, 'cancelled')
    assert.equal(f.sql.prepare('SELECT status FROM runs WHERE id=?').get(childB).status, 'running')
    assert.equal((await f.repo.getConversation(dm.id)).paused, false)
    const affected = await f.repo.stopConversation(dm.id)
    assert.ok(affected.runKeys.includes(`${f.a.id}:${group.id}`))
    assert.equal(f.sql.prepare('SELECT status FROM runs WHERE id=?').get(grandchild).status, 'cancelled')
    assert.equal(f.sql.prepare('SELECT status FROM runs WHERE id=?').get(rootB).status, 'running')
    assert.equal((await f.repo.activityBudget(activityB)).status, 'active')
    await f.repo.resumeConversation(dm.id)
    assert.equal((await f.repo.pendingInbox(f.b.id, undefined, dm.id))[0].messages[0].humanTriggered, true)
    responder = () => ({ calls: [{ name: 'turn_finish', arguments: {} }] })
    await f.runtime.drainConversation(dm.id)
    assert.equal(f.sql.prepare(`SELECT a.root_conversation_id FROM runs r
      JOIN activities a ON a.id=r.activity_id ORDER BY r.rowid DESC LIMIT 1`).get().root_conversation_id, dm.id)
    assert.equal((await f.repo.activityBudget(activityB)).status, 'active')
    await f.repo.stopConversation(sourceB.id)
    assert.equal(await f.repo.ensureActivity(dm.id, sent.message.id), activityB)
    await assert.rejects(() => f.repo.reserveModelCall(activityB), /预算/)
    f.sql.close()
  })
  await check('Invalid auxiliary JSON creates one failed ledger entry for one request', async () => {
    const f = await fixture()
    decisionResponder = () => 'not an object'
    assert.equal(await f.runtime.auxiliaryDecision(f.room, undefined, '为群聊选择', '{}'), null)
    const calls = await f.repo.listModelCalls()
    assert.equal(calls.length, 1); assert.equal(calls[0].status, 'failed')
    decisionResponder = () => ({ mode: 'each', actionable: false })
    f.sql.close()
  })
  await check('Encrypted backup authenticates contents and password, while legacy JSON remains readable', async () => {
    const f = await fixture()
    await f.repo.sendUserMessage(f.room.id, 'private backup text', 'backup')
    const backup = await f.repo.exportBackup()
    const encrypted = await encryptBackup(backup, 'audit-password')
    assert.ok(!encrypted.includes('private backup text'))
    assert.deepEqual(await decryptBackup(encrypted, 'audit-password'), JSON.parse(JSON.stringify(backup)))
    await assert.rejects(() => decryptBackup(encrypted, 'wrong password'), /密码/)
    const tampered = JSON.parse(encrypted)
    tampered.ciphertext = (tampered.ciphertext[0] === 'A' ? 'B' : 'A') + tampered.ciphertext.slice(1)
    await assert.rejects(() => decryptBackup(JSON.stringify(tampered), 'audit-password'), /损坏/)
    assert.deepEqual(await decryptBackup(JSON.stringify(backup)), JSON.parse(JSON.stringify(backup)))
    await assert.rejects(() => encryptBackup(backup, 'short'), /密码/)
    f.sql.close()
  })
  await check('Restore rejects incomplete or inconsistent data and rolls back the whole replacement', async () => {
    const f = await fixture()
    await f.repo.sendUserMessage(f.room.id, 'must survive rollback', 'original')
    const backup = await f.repo.exportBackup()
    await assert.rejects(() => f.repo.importBackup({ format: 'yomi-backup', version: 2 }), /缺少/)
    const invalid = structuredClone(backup)
    invalid.messages[0].conversation_id = 'missing-room'
    await assert.rejects(() => f.repo.importBackup(invalid), /关联/)
    assert.equal((await f.repo.listMessages(f.room.id))[0].body, 'must survive rollback')
    assert.equal(f.sql.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    const child = await f.repo.openAgentDirect(f.room.id, f.a.id, f.b.id)
    const reversed = await f.repo.exportBackup()
    reversed.conversations.reverse()
    await f.repo.importBackup(reversed)
    assert.equal((await f.repo.getConversation(child.id)).originConversationId, f.room.id)
    f.sql.close()
  })
  await check('Maintenance drains accepted commands, rejects new writes, and cancels old Agent generation', async () => {
    const gate = new CommandGate(), order = []
    let release
    const accepted = gate.run(async () => {
      await new Promise(resolve => { release = resolve }); order.push('accepted')
    })
    await Promise.resolve()
    const exclusive = gate.exclusive(async () => { order.push('restore') })
    await assert.rejects(() => gate.run(async () => {}), /维护/)
    release(); await Promise.all([accepted, exclusive])
    assert.deepEqual(order, ['accepted', 'restore'])
    const f = await fixture(), dm = await f.repo.openDirect(f.a.id)
    await f.repo.sendUserMessage(dm.id, 'running before restore', 'maintenance')
    let started
    const ready = new Promise(resolve => { started = resolve })
    responder = async (_request, signal) => {
      started()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      return { calls: [{ name: 'message_send', arguments: { body: 'late result' } }] }
    }
    const running = f.runtime.drainConversation(dm.id)
    await ready
    await f.runtime.withMaintenance(async () => {
      assert.equal(f.runtime.snapshot().running.length, 0)
      const issues = await f.repo.listRuntimeIssues()
      assert.equal(issues.length, 1); assert.equal(issues[0].status, 'interrupted')
      AgentRuntime.prototype.wakeConversation.call(f.runtime, dm.id)
      assert.equal(f.runtime.scheduledConversations.size, 0)
      await f.repo.importBackup(await f.repo.exportBackup())
    })
    await running
    assert.equal((await f.repo.listMessages(dm.id)).filter(item => item.authorKind === 'agent').length, 0)
    f.sql.close()
  })
  await check('Automatic memory provenance survives backup and global moves; deleting sources invalidates it', async () => {
    const f = await fixture()
    const source = await f.repo.sendUserMessage(f.room.id, 'a fact with a source', 'memory-source')
    const ctx = await context(f, f.a, f.room, 1)
    await tool(f, ctx, 'memory_write', { body: 'derived fact', sourceMessageIds: [source.id] })
    assert.match((await tool(f, ctx, 'memory_write', { body: 'foreign', sourceMessageIds: ['unknown'] })).content, /来源/)
    let memories = await f.repo.listMemories(f.a.id)
    assert.equal(memories.length, 1)
    await f.repo.moveMemoryScope(memories[0].id, null)
    await f.repo.importBackup(await f.repo.exportBackup())
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM memory_sources').get().n, 1)
    await f.repo.deleteMessage(source.id)
    assert.equal((await f.repo.listMemories(f.a.id)).length, 0)
    const next = await f.repo.sendUserMessage(f.room.id, 'manually confirmed fact', 'human-source')
    const edited = await f.repo.saveMemory({ agentId: f.a.id, conversationId: f.room.id,
      body: 'original', origin: 'agent', sourceMessageIds: [next.id] })
    await f.repo.saveMemory({ ...edited, body: 'user confirmed', origin: 'human' })
    await f.repo.moveMemoryScope(edited.id, null)
    await f.repo.clearConversation(f.room.id)
    memories = await f.repo.listMemories(f.a.id)
    assert.equal(memories.length, 1); assert.equal(memories[0].body, 'user confirmed')
    f.sql.close()
  })
  await check('Usage counts the full ledger; diagnostics omit content; log cleanup preserves active idempotence', async () => {
    const f = await fixture()
    await f.repo.sendUserMessage(f.room.id, 'PRIVATE DIAGNOSTIC SENTINEL', 'diagnostic')
    const done = await context(f, f.a, f.room, 1)
    await tool(f, done, 'memory_write', { body: 'PRIVATE MEMORY SENTINEL' }, 'completed-memory')
    await f.repo.finishRun(done.runId, 'completed')
    const active = await context(f, f.b, f.room, 1)
    await tool(f, active, 'memory_write', { body: 'active memory' }, 'active-memory')
    for (let i = 0; i < 105; i++) await f.repo.recordModelCall({ runId: done.runId, agentId: f.a.id,
      providerId: f.provider.id, modelId: 'PRIVATE MODEL SENTINEL', purpose: 'main', status: 'completed',
      inputTokens: i === 0 ? null : 10, outputTokens: 2, startedAt: Date.now() })
    await f.repo.recordModelCall({ runId: active.runId, agentId: f.b.id, providerId: f.provider.id,
      modelId: 'PRIVATE MODEL SENTINEL', purpose: 'summary', status: 'failed',
      inputTokens: 2, outputTokens: 3, errorCode: 'PRIVATE ERROR SENTINEL', startedAt: Date.now() })
    const totals = await f.repo.usageSummary()
    assert.equal((await f.repo.listModelCalls()).length, 100)
    assert.equal(totals.calls, 106); assert.equal(totals.inputTokens, 1042); assert.equal(totals.unknownCalls, 1)
    const diagnostics = JSON.stringify(await f.repo.diagnostics())
    assert.doesNotMatch(diagnostics, /PRIVATE|audit\.invalid|Alpha|Beta|audit-only-no-real-key/)
    assert.equal((await f.repo.storageStats()).messages, 1)
    await f.repo.clearFinishedLogs()
    assert.equal((await f.repo.usageSummary()).calls, 1)
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM tool_actions WHERE run_id=?').get(active.runId).n, 1)
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM tool_actions WHERE run_id=?').get(done.runId).n, 0)
    assert.equal((await f.repo.listMessages(f.room.id))[0].body, 'PRIVATE DIAGNOSTIC SENTINEL')
    f.sql.close()
  })
  await check('Peer turns have a persistent 30/minute window; human work bypasses it', async () => {
    const f = await fixture()
    for (let i = 0; i < 30; i++) assert.equal(await f.repo.reserveAgentTurn(f.a.id, false), null)
    const retryAt = await f.repo.reserveAgentTurn(f.a.id, false)
    assert.ok(retryAt > Date.now()); assert.ok(retryAt <= Date.now() + 60_000)
    assert.equal(await f.repo.reserveAgentTurn(f.a.id, true), null)
    assert.equal(f.sql.prepare('SELECT turns FROM agent_turn_limits WHERE agent_id=?').get(f.a.id).turns, 30)
    const dm = await f.repo.openAgentDirect(f.room.id, f.b.id, f.a.id)
    const ctx = await context(f, f.b, dm)
    await tool(f, ctx, 'message_send', { body: 'peer work at rate limit' })
    responder = () => { throw new Error('rate-limited Agent must not call model') }
    try {
      await f.runtime.drainConversation(dm.id)
      assert.equal(f.runtime.snapshot().waiting[0].kind, 'rate')
    } finally { f.runtime.cancelRetryWait() }
    f.sql.prepare('UPDATE agent_turn_limits SET window_started_at=? WHERE agent_id=?').run(Date.now() - 60_001, f.a.id)
    assert.equal(await f.repo.reserveAgentTurn(f.a.id, false), null)
    f.sql.close()
  })
  await check('Persistent HTTP retries stop after two delayed attempts; manual recovery clears stale issues', async () => {
    const f = await fixture(), dm = await f.repo.openDirect(f.a.id)
    await f.repo.sendUserMessage(dm.id, 'temporary failure', 'durable-retry')
    let calls = 0
    responder = () => { calls++; return { httpStatus: 503 } }
    try {
      await f.runtime.drainConversation(dm.id)
      const replay = await f.repo.sendUserMessage(dm.id, 'temporary failure', 'durable-retry')
      assert.equal(replay.commandReplayed, true)
      for (let attempt = 1; attempt <= 2; attempt++) {
        assert.equal(f.runtime.snapshot().waiting.length, 1)
        const job = f.runtime.snapshot().waiting[0]
        assert.equal(job.attempt, attempt)
        f.sql.prepare('UPDATE retry_jobs SET due_at=0 WHERE id=?').run(job.id)
        await f.runtime.processRetry(job.id)
        await f.runtime.drainConversation(dm.id)
      }
      assert.equal(calls, 9); assert.equal(f.runtime.snapshot().waiting.length, 0)
      assert.equal(f.sql.prepare('SELECT status FROM retry_jobs').get().status, 'dormant')
      assert.equal((await f.repo.listRuntimeIssues()).length, 1)
      await f.repo.retryRecovery(dm.id)
      responder = request => {
        const sent = request.input.some(item => item.type === 'function_call_output' && item.output.includes('已发送'))
        return { calls: [{ name: sent ? 'turn_finish' : 'message_send', arguments: sent ? {} : { body: 'manually recovered' } }] }
      }
      await f.runtime.drainConversation(dm.id)
      assert.equal((await f.repo.listRuntimeIssues()).length, 0)
      assert.equal((await f.repo.listMessages(dm.id)).at(-1).body, 'manually recovered')
    } finally { f.runtime.cancelRetryWait(); f.sql.close() }
  })
  await check('Restart and background suspend retry work; stopped retry jobs cannot dispatch', async () => {
    const f = await fixture(), dm = await f.repo.openDirect(f.a.id)
    await f.repo.sendUserMessage(dm.id, 'retry lifecycle', 'retry-lifecycle')
    responder = () => ({ httpStatus: 503 })
    try {
      await f.runtime.drainConversation(dm.id)
      const job = f.runtime.snapshot().waiting[0]
      f.runtime.cancelRetryWait()
      const restarted = new AgentRuntime(f.repo, () => f.repo.listProviders(), () => f.repo.listBindings())
      await restarted.start()
      assert.equal(restarted.snapshot().waiting.length, 0)
      assert.equal(f.sql.prepare('SELECT status FROM retry_jobs WHERE id=?').get(job.id).status, 'dormant')
      await f.repo.retryRecovery(dm.id)
      await f.runtime.drainConversation(dm.id)
      const waiting = f.runtime.snapshot().waiting[0]
      f.runtime.setForeground(false)
      await f.repo.listActors()
      assert.equal(f.runtime.snapshot().waiting.length, 0)
      f.sql.prepare('UPDATE retry_jobs SET due_at=0 WHERE id=?').run(waiting.id)
      assert.equal(await f.repo.dispatchRetry(waiting.id), null)
      assert.equal((await f.repo.getConversation(dm.id)).paused, true)
      f.runtime.setForeground(true)
      assert.equal(f.runtime.snapshot().waiting.length, 0)
    } finally { f.runtime.cancelRetryWait(); f.sql.close() }
  })
  await check('Human reactions rearm handled inboxes, reach the model and respect join boundaries', async () => {
    const f = await fixture(), ctx = await context(f, f.a)
    const sent = await tool(f, ctx, 'message_send', { body: 'a message receiving a reaction' })
    assert.equal(sent.posted, true)
    await f.repo.claimInbox(f.b.id, f.room.id, 1)
    await f.repo.markInboxHandled(f.b.id, f.room.id, 1, 'already handled')
    await f.repo.finishRun(ctx.runId, 'completed')
    const c = await f.repo.saveAgent({ name: 'new member' })
    await f.repo.updateMembers(f.room.id, [c.id], [])
    const message = (await f.repo.listMessages(f.room.id))[0]
    assert.equal(await f.repo.toggleReaction(message.id, 'local-user', '❤️'), true)
    assert.equal((await f.repo.pendingInbox(c.id, undefined, f.room.id)).length, 0)
    let mainCalls = 0
    responder = request => {
      mainCalls++; assert.match(JSON.stringify(request.input), /用户的表情互动/)
      assert.match(JSON.stringify(request.input), /❤️/)
      return { calls: [{ name: 'turn_finish', arguments: {} }] }
    }
    await f.runtime.drainConversation(f.room.id)
    assert.equal(mainCalls, 2)
    assert.equal(await f.repo.toggleReaction(message.id, 'local-user', '❤️'), false)
    assert.equal((await f.repo.pendingInbox(f.b.id, undefined, f.room.id)).length, 0)
    f.sql.close()
  })
  await check('Manual continuation preserves replies and write effects; a fresh message starts a new intent', async () => {
    const f = await fixture()
    const human = await f.repo.sendUserMessage(f.room.id, 'complete these actions', 'partial', null, [f.a.id])
    const firstBatch = () => [
      { name: 'memory_write', arguments: { body: 'remember once', kind: 'note' } },
      { name: 'group_create', arguments: { title: 'Continuation group', memberIds: [f.b.id] } },
      { name: 'message_react', arguments: { messageId: human.id, emoji: '⭐' } },
      { name: 'message_send', arguments: { body: 'reply once' } }
    ]
    let hop = 0
    responder = () => ++hop === 1 ? { calls: firstBatch() } : { httpStatus: 401 }
    await f.runtime.drainConversation(f.room.id)
    assert.equal((await f.repo.listMessages(f.room.id)).filter(item => item.authorKind === 'agent').length, 1)
    assert.equal((await f.repo.listRuntimeIssues()).length, 1)
    await f.repo.retryRecovery(f.room.id)
    hop = 0
    responder = request => {
      assert.match(JSON.stringify(request.input), /前次中断处理的继续/)
      return ++hop === 1 ? { calls: firstBatch().map(call => ({ ...call,
        arguments: Object.fromEntries(Object.entries(call.arguments).reverse()) })) }
        : { calls: [{ name: 'turn_finish', arguments: {} }] }
    }
    await f.runtime.drainConversation(f.room.id)
    assert.equal((await f.repo.listMessages(f.room.id)).filter(item => item.authorKind === 'agent').length, 1)
    assert.equal((await f.repo.listMemories(f.a.id)).length, 1)
    assert.equal((await f.repo.listWhispers()).length, 1)
    assert.equal((await f.repo.messageById(human.id)).reactions[0].emoji, '⭐')
    assert.equal((await f.repo.listRuntimeIssues()).length, 0)
    await f.repo.sendUserMessage(f.room.id, 'do the same actions again', 'fresh-intent', null, [f.a.id])
    hop = 0
    responder = () => ++hop === 1 ? { calls: firstBatch() } : { calls: [{ name: 'turn_finish', arguments: {} }] }
    await f.runtime.drainConversation(f.room.id)
    assert.equal((await f.repo.listMessages(f.room.id)).filter(item => item.authorKind === 'agent').length, 2)
    assert.equal((await f.repo.listWhispers()).length, 2)
    f.sql.close()
  })
  await check('Expired activity rejects late writes and cancels a model request at its deadline', async () => {
    const f = await fixture(), ctx = await context(f)
    f.sql.prepare('UPDATE activities SET started_at=?,updated_at=? WHERE id=?').run(Date.now()-180001, Date.now(), ctx.activityId)
    assert.match((await tool(f, ctx, 'memory_write', { body: 'too late' })).content, /CANCELLED/)
    assert.equal((await f.repo.sendAgentMessage({ actionId: 'late', runId: ctx.runId, authorId: f.a.id,
      conversationId: f.room.id, expectedEpoch: f.room.cancelEpoch, seenThrough: 0,
      body: 'too late', activityId: ctx.activityId })).status, 'budget')
    assert.notEqual(await f.repo.ensureActivity(f.room.id), ctx.activityId)
    f.sql.close()
    const timed = await fixture(), dm = await timed.repo.openDirect(timed.a.id)
    await timed.repo.sendUserMessage(dm.id, 'slow request', 'deadline')
    const activity = await timed.repo.ensureActivity(dm.id)
    timed.sql.prepare('UPDATE activities SET started_at=? WHERE id=?').run(Date.now()-179500, activity)
    let calls = 0
    responder = async (_request, signal) => {
      calls++
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      return { calls: [{ name: 'message_send', arguments: { body: 'late response' } }] }
    }
    await timed.runtime.drainConversation(dm.id)
    assert.equal(calls, 1)
    assert.equal((await timed.repo.listMessages(dm.id)).length, 1)
    assert.equal((await timed.repo.activityBudget(activity)).status, 'budget_exhausted')
    assert.match((await timed.repo.listRuntimeIssues())[0].reason, /预算|时限/)
    timed.sql.close()
  })
  await check('Autonomy pause allows direct human requests while deferring peer-driven work', async () => {
    const f = await fixture()
    await f.repo.updateConversation(f.room.id, { autonomyPaused: true })
    await f.repo.sendUserMessage(f.room.id, 'please answer while autonomy is paused', 'autonomy', null, [f.a.id])
    let calls = 0
    responder = request => {
      calls++
      const sent = request.input.some(item => item.type === 'function_call_output' && item.output.includes('已发送'))
      return { calls: [{ name: sent ? 'turn_finish' : 'message_send', arguments: sent ? {} : { body: 'human request answered' } }] }
    }
    await f.runtime.drainConversation(f.room.id)
    assert.equal(calls, 2)
    assert.equal((await f.repo.listMessages(f.room.id)).at(-1).body, 'human request answered')
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM inbox_events WHERE agent_id=? AND reason='自主互动已暂停' AND status='deferred'").get(f.b.id).n, 1)
    await f.repo.updateConversation(f.room.id, { autonomyPaused: false })
    assert.equal((await f.repo.pendingInbox(f.b.id, undefined, f.room.id)).length, 1)
    await f.runtime.drainConversation(f.room.id)
    assert.equal(calls, 2)
    f.sql.close()
  })
  await check('A new human question after a committed reply remains actionable in the next processing pass', async () => {
    const f = await fixture(), dm = await f.repo.openDirect(f.a.id)
    await f.repo.sendUserMessage(dm.id, 'FIRST QUESTION', 'first-question')
    const execute = f.runtime.executeTool.bind(f.runtime)
    let inserted = false
    f.runtime.executeTool = async (call, ctx) => {
      const outcome = await execute(call, ctx)
      if (outcome.posted && !inserted) {
        inserted = true
        await f.repo.sendUserMessage(dm.id, 'SECOND QUESTION', 'second-question')
      }
      return outcome
    }
    responder = request => {
      const sent = request.input.some(item => item.type === 'function_call_output' && item.output.includes('已发送'))
      const second = JSON.stringify(request.input).includes('SECOND QUESTION')
      return { calls: [{ name: sent ? 'turn_finish' : 'message_send', arguments: sent ? {} : { body: second ? 'SECOND ANSWER' : 'FIRST ANSWER' } }] }
    }
    await f.runtime.drainConversation(dm.id)
    assert.deepEqual((await f.repo.listMessages(dm.id)).filter(item => item.authorKind === 'agent').map(item => item.body), ['FIRST ANSWER', 'SECOND ANSWER'])
    assert.equal((await f.repo.pendingInbox(f.a.id, undefined, dm.id)).length, 0)
    f.sql.close()
  })
  await check('Routing claims survive retries and hand off only when the primary has no answer or pending retry', async () => {
    const f = await fixture()
    let routingCalls = 0, phase = 'unavailable'
    decisionResponder = request => request.instructions.includes('为群聊选择')
      ? (routingCalls++, { mode: 'one-of-us', primary: f.a.id }) : { actionable: false }
    const first = await f.repo.sendUserMessage(f.room.id, 'one concrete question', 'routing-retry')
    responder = request => {
      if (phase === 'unavailable') return { httpStatus: 503 }
      if (phase === 'handoff' && request.instructions.includes('角色「Alpha」')) return { httpStatus: 401 }
      const sent = request.input.some(item => item.type === 'function_call_output' && item.output.includes('已发送'))
      return { calls: [{ name: sent ? 'turn_finish' : 'message_send', arguments: sent ? {} : { body: phase === 'handoff' ? 'Beta handoff answer' : 'Alpha recovered answer' } }] }
    }
    try {
      await f.runtime.drainConversation(f.room.id)
      assert.equal(routingCalls, 1)
      assert.deepEqual((await f.repo.routingPlan(first.id)).targets, [f.a.id])
      phase = 'recovered'
      const job = f.runtime.snapshot().waiting[0]
      f.sql.prepare('UPDATE retry_jobs SET due_at=0 WHERE id=?').run(job.id)
      await f.runtime.processRetry(job.id)
      await f.runtime.drainConversation(f.room.id)
      assert.equal(routingCalls, 1)
      assert.equal((await f.repo.listMessages(f.room.id)).at(-1).body, 'Alpha recovered answer')
      phase = 'handoff'
      const second = await f.repo.sendUserMessage(f.room.id, 'a different concrete question', 'routing-handoff')
      await f.runtime.drainConversation(f.room.id)
      assert.equal(routingCalls, 2)
      assert.deepEqual((await f.repo.routingPlan(second.id)).targets, [f.b.id])
      assert.equal((await f.repo.listMessages(f.room.id)).at(-1).authorId, f.b.id)
      assert.equal((await f.repo.listRuntimeIssues()).length, 0)
    } finally { f.runtime.cancelRetryWait(); decisionResponder = () => ({ mode: 'each', actionable: false }); f.sql.close() }
  })
  const report = JSON.stringify({ status: 'passed', checks: passed.length, passed }, null, 2)
  if (process.argv.includes('--report')) require('node:fs').writeFileSync(
    path.join(root, 'docs/08-AGENT-REGRESSION-RESULTS.json'), report + '\n')
  console.log(report)
}
const started = Date.now()
main()
  .catch(error => { console.error(error); process.exitCode = 1 })
  .finally(() => { global.fetch = nativeFetch })
  .finally(() => {
    // Timers left behind by a check keep Node alive; the result is already known.
    console.error(`finished in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    process.exit(process.exitCode ?? 0)
  })
