// Real SQL + queue + protocol checks; never accesses the user's database or a live API.
const { buildSync } = require('esbuild')
const { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const path = require('node:path')
const code = buildSync({ stdin: { contents: `
export { Repository } from './src/data/repository'; export { Database } from './src/data/database';
export { schema } from './src/data/schema'; export { StickerRecognizer } from './src/media/stickerRecognizer';
export { parseStickerMeaning } from './src/media/stickerMeaning'; export { callModel, ModelProtocolError } from './src/model/protocol';
export { storeCredential } from './src/platform/secureTransport'; export { AgentRuntime } from './src/agent/runtime';
export { validateToolCall } from './src/agent/tools';`, resolveDir: path.resolve(__dirname, '..') },
  bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const mod = { exports: {} }
new Function('require', 'module', 'exports', code)(require, mod, mod.exports)
const { Repository, Database, schema, StickerRecognizer, parseStickerMeaning, callModel, ModelProtocolError, storeCredential, AgentRuntime, validateToolCall } = mod.exports
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9E0AAAAASUVORK5CYII='
const image = suffix => 'data:image/png;base64,' + Buffer.concat([Buffer.from(png.split(',')[1], 'base64'), Buffer.from(suffix)]).toString('base64')
const meaning = { description: '小猫趴在枕头上准备睡觉', text: '晚安', tags: ['困', '晚安'], situations: ['睡前道别', '想休息'] }
const databases = []
const recognizers = []
const originalFetch = global.fetch
const passed = []
const until = async predicate => {
  const deadline = Date.now() + 3000
  while (!await predicate()) {
    if (Date.now() > deadline) throw Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 8))
  }
}
async function check(name, work) { await work(); passed.push(name); console.log('PASS ' + name) }
function fixture() {
  const sql = new DatabaseSync(':memory:'); sql.exec(schema); databases.push(sql)
  const db = new Database()
  db.db = { query: async (q, v = []) => ({ values: sql.prepare(q).all(...v) }), run: async (q, v = []) => sql.prepare(q).run(...v),
    execute: async q => sql.exec(q), isTransactionActive: async () => ({ result: sql.isTransaction }),
    beginTransaction: async () => sql.exec('BEGIN'), commitTransaction: async () => sql.exec('COMMIT'), rollbackTransaction: async () => sql.exec('ROLLBACK') }
  db.persistWebStore = async () => assert.equal(sql.isTransaction, false)
  return { sql, db, repo: new Repository(db) }
}
async function configure(f, options = {}) {
  const provider = await f.repo.saveProvider({ id: crypto.randomUUID(), name: 'Vision fixture', protocol: 'chat-completions',
    baseUrl: 'https://vision.example.test/v1', enabled: true, credentialState: 'stored', credentialRef: '', configVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), ...options })
  await f.repo.saveProviderChannelKind(provider.id, 'text')
  const settings = await f.repo.saveStickerRecognitionSettings({ enabled: true, providerId: provider.id, modelId: 'vision-fixture' }, true)
  return { provider, settings }
}
function worker(f, recognize, prepare = async data => [data]) {
  const service = new StickerRecognizer(f.repo, prepare, () => {}, recognize)
  recognizers.push(service); return service
}

async function main() {
  await check('strict bounded semantic JSON, code-fence tolerance, malformed output rejection', async () => {
    assert.deepEqual(parseStickerMeaning('```json\n' + JSON.stringify(meaning) + '\n```'), meaning)
    assert.throws(() => parseStickerMeaning('{}'))
    assert.throws(() => parseStickerMeaning('looks like a cat'))
    const huge = parseStickerMeaning(JSON.stringify({ ...meaning, description: 'x'.repeat(1000), tags: ['困', '困', ...Array.from({ length: 50 }, (_, i) => String(i))] }))
    assert.equal(huge.description.length, 240); assert.equal(huge.tags.length, 8)
  })

  await check('disabled by default; origin-bound explicit upload consent; generation-only channels rejected', async () => {
    const f = fixture(); let calls = 0
    await f.repo.saveSticker('IMG_001', png)
    const service = worker(f, async () => { calls++; return { meaning, usage: { inputTokens: 12, outputTokens: 30 } } })
    await service.start(); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(calls, 0)
    const { provider, settings } = await configure(f)
    const pending = (await f.repo.listStickers())[0]
    await service.retry(pending.id)
    await until(async () => (await f.repo.listStickers())[0].analysisStatus === 'ready')
    assert.equal(calls, 1)
    await service.withPaused(async () => f.repo.saveProvider({ ...provider, baseUrl: 'https://different.example.test/v1' }))
    await assert.rejects(f.repo.saveStickerRecognitionSettings({ ...settings, enabled: true }), /首次启用/)
    await f.repo.saveProviderChannelKind(provider.id, 'image')
    await assert.rejects(f.repo.saveStickerRecognitionSettings({ ...settings, enabled: true }, true), /不是生图模型/)
    await service.withPaused(async () => f.repo.saveStickerRecognitionSettings({ ...settings, enabled: false }))
  })

  await check('auto queue, atomic content deduplication, completed-cache reuse across legacy duplicates and restarts', async () => {
    const f = fixture(); await configure(f); let calls = 0
    const [first, duplicate] = await Promise.all([f.repo.saveSticker('IMG_A', png), f.repo.saveSticker('IMG_B', png)])
    assert.equal(first.id, duplicate.id)
    const service = worker(f, async () => { calls++; return { meaning, usage: { inputTokens: 12, outputTokens: 30 } } })
    await service.start()
    await until(async () => (await f.repo.listStickers()).every(item => item.analysisStatus === 'ready'))
    f.sql.prepare('INSERT INTO stickers(id,name,data_url,created_at) VALUES (?,?,?,?)').run('legacy-copy', 'legacy', png, Date.now())
    service.kick()
    await until(async () => (await f.repo.listStickers()).every(item => item.analysisStatus === 'ready'))
    await until(async () => (await f.repo.usageSummary()).calls === 1)
    assert.equal(calls, 1)
    assert.equal((await f.repo.usageSummary()).purposes[0].purpose, 'sticker-analysis')
    const restarted = worker(f, async () => { throw Error('must not repeat') })
    await restarted.start(); await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(calls, 1)
    assert.equal((await f.repo.recognizedStickers('晚安'))[0].analysis.text, '晚安')
    assert.equal((await f.repo.recognizedStickers('生气')).length, 0)
  })

  await check('bad vision model / transient failures pause paid work, redact responses, require explicit retry', async () => {
    const f = fixture(); await configure(f); let calls = 0, fail = true
    const first = await f.repo.saveSticker('bad', image('a'))
    const second = await f.repo.saveSticker('later', image('b'))
    const service = worker(f, async () => {
      calls++; if (fail) throw new ModelProtocolError('http_400', 'SECRET_ECHO data:image/png;base64,PRIVATE_IMAGE')
      return { meaning, usage: { inputTokens: 1, outputTokens: 2 } }
    })
    await service.start()
    await until(async () => (await f.repo.listStickers()).some(item => item.analysisStatus === 'failed'))
    assert.equal(calls, 1)
    assert.equal((await f.repo.listStickers()).find(item => item.id === second.id).analysisStatus, 'pending')
    service.kick(); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(calls, 1)
    assert.doesNotMatch(JSON.stringify(await f.repo.exportBackup(true)), /SECRET_ECHO|PRIVATE_IMAGE/)
    assert.equal((await f.repo.recognizedStickers()).length, 0)
    fail = false; await service.retry(first.id)
    await until(async () => (await f.repo.listStickers()).every(item => item.analysisStatus === 'ready'))
    assert.equal(calls, 3)
  })

  await check('revocation aborts an in-flight upload, preserves manual sending, never auto-retries ambiguous work', async () => {
    const f = fixture(); const { settings } = await configure(f)
    const sticker = await f.repo.saveSticker('cancel', image('cancel'))
    let called = 0, aborted = false
    const service = worker(f, async (_provider, _model, _images, signal) => {
      called++
      return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Error('cancelled')) }, { once: true }))
    })
    await service.start(); await until(() => called === 1)
    await service.withPaused(() => f.repo.saveStickerRecognitionSettings({ ...settings, enabled: false }))
    assert.equal(aborted, true)
    assert.equal((await f.repo.listStickers())[0].analysisStatus, 'failed')
    service.kick(); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(called, 1)
    await f.repo.ensureLocalUser(); const actor = await f.repo.saveAgent({ name: '甲' }); const room = await f.repo.openDirect(actor.id)
    assert.ok((await f.repo.sendSticker(room.id, sticker.id, 'manual-send')).mediaId)
  })

  await check('preparation / GIF decoder failure makes no paid calls; stale completion tokens cannot overwrite or resurrect', async () => {
    const f = fixture(); await configure(f); let calls = 0
    const sticker = await f.repo.saveSticker('bad-file', image('decode'))
    const service = worker(f, async () => { calls++; throw Error('must not call') }, async () => { throw Error('decoder unavailable') })
    await service.start(); await until(async () => (await f.repo.listStickers())[0].analysisStatus === 'failed')
    assert.equal(calls, 0); assert.equal((await f.repo.usageSummary()).calls, 0)
    await f.repo.retryStickerRecognition(sticker.id)
    const old = await f.repo.claimStickerRecognition(sticker.id)
    await f.repo.finishStickerRecognition(sticker.id, old.analysisToken, null, 'failed', 'vision')
    await f.repo.retryStickerRecognition(sticker.id)
    const fresh = await f.repo.claimStickerRecognition(sticker.id)
    await f.repo.finishStickerRecognition(sticker.id, old.analysisToken, meaning, '', 'old')
    assert.equal((await f.repo.listStickers())[0].analysisStatus, 'analyzing')
    await f.repo.deleteSticker(sticker.id)
    await f.repo.finishStickerRecognition(sticker.id, fresh.analysisToken, meaning, '', 'new')
    assert.equal((await f.repo.listStickers()).length, 0)
  })

  await check('model sees semantic meanings; pure role sticker sends persist correctly, survive branch / backup, deleted favorites keep snapshots', async () => {
    const f = fixture(); await f.repo.ensureLocalUser(); await configure(f)
    const actor = await f.repo.saveAgent({ name: '甲' }), room = await f.repo.openDirect(actor.id)
    const sticker = await f.repo.saveSticker('IMG_1234', png)
    const claimed = await f.repo.claimStickerRecognition(sticker.id)
    await f.repo.finishStickerRecognition(sticker.id, claimed.analysisToken, meaning, '', 'vision')
    const human = await f.repo.sendUserMessage(room.id, '晚安', 'human')
    const runtime = new AgentRuntime(f.repo, () => f.repo.listProviders(), () => f.repo.listBindings())
    runtime.wakeConversation = () => {}
    const context = { agent: actor, conversation: await f.repo.getConversation(room.id), runId: 'fixture', expectedEpoch: 0,
      remainingPosts: 1, seenThrough: human.sequence, visibleThrough: human.sequence, input: [] }
    const list = await runtime.executeToolAction({ id: 'list', name: 'sticker_list', arguments: { query: '晚安' } }, context, f.repo)
    assert.match(list.content, /睡前道别/); assert.doesNotMatch(list.content, /base64|IMG_1234/)
    validateToolCall('message_send', { stickerId: sticker.id })
    const result = await runtime.executeToolAction({ id: 'send', name: 'message_send', arguments: { stickerId: sticker.id } }, context, f.repo)
    assert.equal(result.posted, true)
    const posted = (await f.repo.listMessages(room.id)).at(-1)
    assert.equal(posted.sticker, true); assert.match(posted.body, /小猫/)
    const snapshot = await f.repo.exportBackup()
    const copy = fixture(); await copy.repo.importBackup(snapshot)
    assert.equal((await copy.repo.listStickers())[0].analysis.description, meaning.description)
    assert.equal((await copy.repo.stickerRecognitionSettings()).enabled, false)
    assert.equal((await copy.repo.stickerRecognitionSettings()).consentedOrigin, '')
    const nextHuman = await f.repo.sendUserMessage(room.id, '还有呢', 'human-next')
    await f.repo.sendAgentMessage({ actionId: 'reply-2', runId: 'fixture-2', conversationId: room.id, authorId: actor.id,
      body: '明天见', expectedEpoch: (await f.repo.getConversation(room.id)).cancelEpoch, seenThrough: nextHuman.sequence })
    const nextReply = (await f.repo.listMessages(room.id)).at(-1)
    const branch = await f.repo.regenerateBranch(nextReply.id)
    assert.equal((await f.repo.listMessages(branch)).find(item => item.mediaId === posted.mediaId).sticker, true)
    await f.repo.deleteSticker(sticker.id)
    assert.equal(await f.repo.mediaData(posted.mediaId), png)
    assert.match((await f.repo.agentMessages(actor.id, room.id, { through: 99 })).find(item => item.mediaId === posted.mediaId).body, /晚安/)
  })

  await check('legacy additive migration retains files / messages; interrupted recognition never silently repeats', async () => {
    const f = fixture()
    f.sql.exec('DROP TABLE stickers; CREATE TABLE stickers(id TEXT PRIMARY KEY,name TEXT NOT NULL,data_url TEXT NOT NULL,created_at INTEGER NOT NULL)')
    f.sql.prepare('INSERT INTO stickers VALUES (?,?,?,?)').run('old', 'legacy', png, 1)
    await f.db.migrateExistingTables(); f.sql.exec(schema)
    assert.equal((await f.repo.listStickers())[0].dataUrl, png)
    assert.equal((await f.repo.listStickers())[0].analysisStatus, 'pending')
    const claimed = await f.repo.claimStickerRecognition('old')
    await f.repo.resetInterruptedStickerRecognition()
    assert.equal((await f.repo.listStickers())[0].analysisStatus, 'failed')
    await f.repo.finishStickerRecognition('old', claimed.analysisToken, meaning, '', 'late')
    assert.equal((await f.repo.listStickers())[0].analysisStatus, 'failed')
  })

  await check('Chat Completions and Responses encode real image parts, text-only conversations remain compatible', async () => {
    const provider = { id: 'vision-protocol', baseUrl: 'https://vision.example.test/v1', protocol: 'chat-completions' }
    await storeCredential(provider.id, 'fixture-only-key', 'https://vision.example.test')
    const payloads = []
    global.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body); payloads.push(payload)
      return new Response(JSON.stringify(provider.protocol === 'responses'
        ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(meaning) }] }] }
        : { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(meaning) } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const request = { instructions: 'analyze', input: [{ role: 'user', content: '图片', images: [png, png] }], maxOutputTokens: 700 }
    assert.equal(JSON.parse((await callModel(provider, 'vision', request, new AbortController().signal)).text).text, '晚安')
    assert.equal(payloads[0].messages[1].content[1].type, 'image_url')
    assert.equal(payloads[0].messages[1].content[1].image_url.url, png)
    provider.protocol = 'responses'
    await callModel(provider, 'vision', request, new AbortController().signal)
    assert.equal(payloads[1].input[0].content[1].type, 'input_image')
    assert.equal(payloads[1].input[0].content[1].image_url, png)
    assert.equal(payloads[1].store, false)
    await callModel(provider, 'vision', { ...request, input: [{ role: 'user', content: 'text-only' }] }, new AbortController().signal)
    assert.equal(payloads[2].input[0].content, 'text-only')
    global.fetch = originalFetch
  })

  await check('complete default recognizer performs one real protocol request with images, caches semantics and usage', async () => {
    const f = fixture(); const { provider } = await configure(f)
    await storeCredential(provider.id, 'fixture-only-key', 'https://vision.example.test')
    const sticker = await f.repo.saveSticker('PRIVATE_FILENAME', image('pipeline'))
    let calls = 0
    global.fetch = async (_url, options) => {
      calls++
      const payload = JSON.parse(options.body)
      assert.equal(payload.messages[1].content[1].image_url.url, sticker.dataUrl)
      assert.doesNotMatch(payload.messages[0].content + payload.messages[1].content[0].text, /PRIVATE_FILENAME/)
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(meaning) } }],
        usage: { prompt_tokens: 123, completion_tokens: 45 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const service = new StickerRecognizer(f.repo, async data => [data], () => {})
    recognizers.push(service); await service.start()
    await until(async () => (await f.repo.usageSummary()).calls === 1)
    assert.equal((await f.repo.listStickers())[0].analysis.text, '晚安')
    assert.equal((await f.repo.usageSummary()).inputTokens, 123)
    service.kick(); await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(calls, 1)
    global.fetch = originalFetch
  })
  console.log(JSON.stringify({ checks: passed.length, status: 'passed', liveProviderCalls: 0 }))
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  global.fetch = originalFetch
  for (const service of recognizers) await service.withPaused(async () => service.setForeground(false))
  for (const database of databases) database.close()
})
