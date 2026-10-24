const { buildSync } = require('esbuild')
const assert = require('node:assert/strict')
const path = require('node:path')
const compiled = buildSync({ stdin: { contents: `
export * from './src/model/catalog'; export * from './src/model/providerConfig';
export * from './src/model/connectionTest'; export {storeCredential} from './src/platform/secureTransport';`,
  resolveDir: path.resolve(__dirname, '..') }, bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const mod = { exports: {} }
new Function('require', 'module', 'exports', compiled)(require, mod, mod.exports)
const { normalizeProviderAddress, parseProviderModels, fetchProviderModels, testTextConnection, testMediaConnection, storeCredential } = mod.exports
const provider = { id: 'connection-test', name: 'Test', protocol: 'chat-completions', baseUrl: 'https://provider.invalid/v1',
  enabled: true, credentialState: 'stored', credentialRef: '', configVersion: 1, createdAt: 1, updatedAt: 1 }
const nativeFetch = global.fetch
async function main() {
  assert.deepEqual(normalizeProviderAddress(' https://provider.invalid/v1/chat/completions/ ', 'responses'),
    { baseUrl: 'https://provider.invalid/v1', protocol: 'chat-completions' })
  assert.deepEqual(normalizeProviderAddress('https://provider.invalid/custom/responses', 'chat-completions'),
    { baseUrl: 'https://provider.invalid/custom', protocol: 'responses' })
  assert.equal(normalizeProviderAddress('https://provider.invalid/v1/models', 'responses').baseUrl, 'https://provider.invalid/v1')
  assert.throws(() => normalizeProviderAddress('https://user:pass@provider.invalid/v1', 'responses'))
  assert.deepEqual(parseProviderModels({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, {}, null] }).models.map(item => item.id), ['b', 'a'])
  assert.deepEqual(parseProviderModels({ models: ['a', { name: 'b' }] }).models.map(item => item.id), ['a', 'b'])
  assert.throws(() => parseProviderModels({ error: 'bad' }))
  console.log('PASS API root / full endpoint normalization, protocol inference, catalog formats and deduplication')
  await storeCredential(provider.id, 'fixture-only', 'https://provider.invalid')
  const requests = []
  global.fetch = async (url, options) => {
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined)
    assert.equal(options.headers.Authorization, 'Bearer fixture-only')
    requests.push(String(url))
    return new Response(JSON.stringify(String(url).includes('?after=')
      ? { data: [{ id: 'b' }, { id: 'c' }], has_more: false }
      : { data: [{ id: 'b' }, { id: 'a' }], has_more: true, last_id: 'cursor-1' }))
  }
  assert.deepEqual((await fetchProviderModels(provider)).map(item => item.id), ['a', 'b', 'c'])
  assert.equal(requests[1], 'https://provider.invalid/v1/models?after=cursor-1')
  for (const [status, message] of [[401, /认证失败/], [403, /访问被拒绝/], [404, /手动填写/]]) {
    global.fetch = async () => new Response('', { status })
    await assert.rejects(fetchProviderModels(provider), message)
  }
  const controller = new AbortController(); controller.abort()
  global.fetch = async (_url, options) => { if (options.signal.aborted) throw new DOMException('cancelled', 'AbortError') }
  await assert.rejects(fetchProviderModels(provider, controller.signal), /已取消/)
  console.log('PASS authenticated GET, pagination, 401/403/unsupported-list feedback and cancellation')
  for (const protocol of ['chat-completions', 'responses']) {
    let calls = 0
    global.fetch = async (url, options) => {
      calls++; assert.equal(options.method, 'POST')
      const body = JSON.parse(options.body)
      const marker = protocol === 'responses' ? body.input.find(item => item.role === 'user').content : body.messages.find(item => item.role === 'user').content
      const toolResult = protocol === 'responses' ? body.input.some(item => item.type === 'function_call_output') : body.messages.some(item => item.role === 'tool')
      const call = { name: 'yomi_connection_probe', arguments: JSON.stringify({ marker }) }
      return new Response(JSON.stringify(protocol === 'responses'
        ? { status: 'completed', output: toolResult ? [{ type: 'message', content: [{ type: 'output_text', text: marker }] }] : [{ type: 'function_call', call_id: 'test-call', ...call }] }
        : { choices: [{ message: toolResult ? { content: marker } : { content: '', tool_calls: [{ id: 'test-call', type: 'function', function: call }] } }] }))
    }
    assert.match(await testTextConnection({ ...provider, protocol }, 'test-model'), /均通过/)
    assert.equal(calls, 2)
  }
  global.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }))
  await assert.rejects(testTextConnection(provider, 'test-model'), /未通过工具调用/)
  console.log('PASS Chat Completions / Responses tool round trips and rejection of text-only fake successes')
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jIh0AAAAASUVORK5CYII='
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body)
    assert.equal(options.method, 'POST')
    if (String(url).endsWith('/images/generations')) return new Response(JSON.stringify({ data: [{ b64_json: png }] }))
    assert.ok(String(url).endsWith('/audio/speech')); assert.equal(body.voice, 'test-voice')
    return new Response(new Uint8Array([73, 68, 51]), { headers: { 'Content-Type': 'audio/mpeg' } })
  }
  assert.match((await testMediaConnection(provider, 'image-model', 'image')).dataUrl, /^data:image\/png;base64,/)
  assert.match((await testMediaConnection(provider, 'speech-model', 'speech', 'test-voice')).dataUrl, /^data:audio\/mpeg;base64,/)
  console.log('PASS image and speech probes return preview data without writing chats or media records')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { global.fetch = nativeFetch })
