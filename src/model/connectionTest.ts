import type { ModelTestResult, Provider } from '../domain/types'
import { generateImage, generateSpeech, MediaProtocolError } from '../media/generate'
import { callModel, emptyRequest, ModelProtocolError } from './protocol'

async function timedTest<T>(signal: AbortSignal | undefined, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = setTimeout(abort, timeoutMs)
  try { return await work(controller.signal) }
  catch (error) {
    if (controller.signal.aborted) throw new Error(signal?.aborted ? '已取消测试' : '模型测试超时，请检查服务状态后重试')
    if (error instanceof ModelProtocolError || error instanceof MediaProtocolError) {
      if (error.code === 'http_401') throw new Error('认证失败（401），请检查此连接的 API Key')
      if (error.code === 'http_403') throw new Error('访问被拒绝（403），请检查模型权限与服务商限制')
      if (error.code === 'http_404') throw new Error('未找到模型或接口（404），请检查 Base URL、协议与模型 ID')
      if (error.code === 'http_429') throw new Error('服务限流或额度不足（429），请检查账户状态后重试')
    }
    if (error instanceof TypeError) throw new Error('无法访问模型服务，请检查网络与地址；浏览器预览需要服务商允许跨域访问')
    throw error
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

export function testTextConnection(provider: Provider, modelId: string, signal?: AbortSignal): Promise<string> {
  return timedTest(signal, 30000, async requestSignal => {
    const marker = crypto.randomUUID()
    const request = {
      ...emptyRequest('连接能力测试：先调用 yomi_connection_probe，将用户给出的 marker 原样作为参数。收到工具结果后，只回复结果中的 marker。', marker, 1024),
      tools: [{ name: 'yomi_connection_probe', description: '验证工具调用和结果续传，不产生任何聊天副作用。',
        parameters: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false } }]
    }
    const result = await callModel(provider, modelId, request, requestSignal)
    if (result.toolCalls.length !== 1 || result.toolCalls[0].name !== 'yomi_connection_probe' || result.toolCalls[0].arguments.marker !== marker) {
      throw new Error('模型未通过工具调用测试，请检查所选模型和接口协议')
    }
    const call = result.toolCalls[0]
    const continuation = await callModel(provider, modelId, { ...request, input: [...request.input,
      { role: 'assistant', toolCalls: result.toolCalls },
      { role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify({ marker }) }] }, requestSignal)
    if (continuation.toolCalls.length || continuation.text.trim() !== marker) throw new Error('模型未通过工具结果续传测试，请检查协议和模型兼容性')
    return '认证、工具调用和结果续传均通过'
  })
}

export function testMediaConnection(provider: Provider, modelId: string, kind: 'image' | 'speech', voice = 'alloy', signal?: AbortSignal): Promise<ModelTestResult> {
  return timedTest(signal, 90000, async requestSignal => {
    const started = Date.now()
    const result = kind === 'image'
      ? await generateImage(provider, modelId, 'A small blue circle on a plain white background. Simple geometric icon.', requestSignal)
      : await generateSpeech(provider, modelId, '你好，这是一条 Yomi 语音连接测试。', voice, requestSignal)
    return { kind, dataUrl: result.dataUrl, latencyMs: Date.now() - started,
      message: kind === 'image' ? '图片生成接口已通过，预览仅用于本次测试' : '语音合成接口已通过，试听仅用于本次测试' }
  })
}
