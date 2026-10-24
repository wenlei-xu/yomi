import type { ModelInputItem, ModelRequest, ModelResult, Provider, ToolCall } from '../domain/types'
import { secureRequest } from '../platform/secureTransport'
import { ModelStream } from './stream'
import { RequestGate } from '../agent/limits'

const nonStreaming = new Set<string>()

const allRequests = new RequestGate(4)
const providerRequests = new Map<string, RequestGate>()

export class ModelProtocolError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

export async function callModel(provider: Provider, modelId: string, request: ModelRequest, signal: AbortSignal, onProgress?: (text: string) => void, onFallback?: () => Promise<void>): Promise<ModelResult> {
  const url = provider.protocol === 'responses' ? `${provider.baseUrl.replace(/\/$/, '')}/responses` : `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`
  const body = provider.protocol === 'responses'
    ? { model: modelId, instructions: request.instructions, input: responsesInput(request.input), tools: request.tools?.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters })), max_output_tokens: request.maxOutputTokens,
      ...(request.input.some(item => item.role === 'user' && item.images?.length) ? { store: false } : {}) }
    : { model: modelId, messages: chatMessages(request), tools: request.tools?.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })), max_tokens: request.maxOutputTokens }
  let gate = providerRequests.get(provider.id)
  if (!gate) { gate = new RequestGate(2); providerRequests.set(provider.id, gate) }
  const capabilityKey = `${provider.id}:${provider.configVersion}:${url}:${modelId}`
  const streamed = Boolean(onProgress) && !nonStreaming.has(capabilityKey)
  const parser = new ModelStream(provider.protocol, onProgress)
  const payload = { ...body, ...(streamed ? { stream: true } : {}) }
  let response = await allRequests.run(signal, () => gate!.run(signal,
    () => secureRequest(provider.id, url, JSON.stringify(payload), signal, false,
      streamed ? chunk => { try { parser.frames.push(chunk) } catch { /* Final parse reports malformed streams. */ } } : undefined)))
  if (streamed && [400, 422].includes(response.status) && /stream/i.test(response.body) && /unsupported|not.support|not.allowed|unknown|不支持/i.test(response.body)) {
    nonStreaming.add(capabilityKey)
    onProgress?.('')
    await onFallback?.()
    response = await allRequests.run(signal, () => gate!.run(signal,
      () => secureRequest(provider.id, url, JSON.stringify(body), signal)))
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ModelProtocolError(`http_${response.status}`, `${response.status} ${response.body.slice(0, 300)}`)
  }
  let json: Record<string, unknown>
  try {
    if (response.contentType?.includes('text/event-stream') || response.body.trimStart().startsWith('data:')) {
      // Parse the retained body again so correctness never depends on bridge event delivery.
      const complete = new ModelStream(provider.protocol)
      complete.frames.push(response.body)
      json = complete.result()
    } else {
      json = JSON.parse(response.body) as Record<string, unknown>
      if (streamed) nonStreaming.add(capabilityKey)
    }
  } catch {
    throw new ModelProtocolError('invalid_response', '模型响应不完整或无法解析，未执行工具。')
  }
  return provider.protocol === 'responses' ? parseResponses(json) : parseChat(json)
}

export function emptyRequest(instructions: string, input: string, maxOutputTokens = 512): ModelRequest {
  return {
    instructions,
    input: [{ role: 'user', content: input }],
    maxOutputTokens
  }
}

function responsesInput(items: ModelInputItem[]): unknown[] {
  return items.map(item => {
    if (item.role === 'tool') return { type: 'function_call_output', call_id: item.toolCallId, output: item.content }
    if (item.role === 'assistant' && 'toolCalls' in item) return item.toolCalls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }))
    if (item.role === 'user' && item.images?.length) return { role: 'user', content: [
      { type: 'input_text', text: item.content }, ...item.images.map(image_url => ({ type: 'input_image', image_url, detail: 'auto' }))
    ] }
    return { role: item.role === 'assistant' ? 'assistant' : item.role, content: 'content' in item ? item.content : '' }
  }).flat()
}

function chatMessages(request: ModelRequest): unknown[] {
  return [{ role: 'system', content: request.instructions }, ...request.input.map(item => {
    if (item.role === 'tool') return { role: 'tool', tool_call_id: item.toolCallId, content: item.content }
    if (item.role === 'assistant' && 'toolCalls' in item) {
      return { role: 'assistant', content: '', tool_calls: item.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
    }
    if (item.role === 'user' && item.images?.length) return { role: 'user', content: [
      { type: 'text', text: item.content }, ...item.images.map(url => ({ type: 'image_url', image_url: { url, detail: 'auto' } }))
    ] }
    return { role: item.role, content: 'content' in item ? item.content : '' }
  })]
}

function parseResponses(json: Record<string, unknown>): ModelResult {
  if (json.error || (json.status && json.status !== 'completed')) {
    throw new ModelProtocolError('incomplete_response', '模型响应未完整结束，未执行工具')
  }
  const output = Array.isArray(json.output) ? json.output as Record<string, unknown>[] : []
  const text = output.filter(item => item.type === 'message').map(item => {
    const content = item.content as Record<string, unknown>[] | undefined
    return content?.filter(part => part.type === 'output_text').map(part => String(part.text ?? '')).join('') ?? ''
  }).join('')
  const calls = output.filter(item => item.type === 'function_call').map(item => ({
    id: String(item.call_id ?? item.id ?? crypto.randomUUID()),
    name: String(item.name ?? ''),
    arguments: parseJson(String(item.arguments ?? '{}'))
  }))
  return { text, toolCalls: calls, usage: usage(json.usage) }
}

function parseChat(json: Record<string, unknown>): ModelResult {
  const choice = (Array.isArray(json.choices) ? json.choices[0] : undefined) as Record<string, unknown> | undefined
  const message = choice?.message as Record<string, unknown> | undefined
  if (!message || ['length', 'content_filter'].includes(String(choice?.finish_reason))) {
    throw new ModelProtocolError('incomplete_response', '模型响应缺失或被截断，未执行工具')
  }
  const calls = (Array.isArray(message?.tool_calls) ? message.tool_calls : []).map((raw: Record<string, unknown>) => {
    const fn = raw.function as Record<string, unknown> | undefined
    return { id: String(raw.id ?? crypto.randomUUID()), name: String(fn?.name ?? ''), arguments: parseJson(String(fn?.arguments ?? '{}')) }
  })
  return { text: String(message?.content ?? ''), toolCalls: calls, usage: usage(json.usage) }
}

function usage(raw: unknown): ModelResult['usage'] {
  if (!raw || typeof raw !== 'object') return { inputTokens: null, outputTokens: null }
  const value = raw as Record<string, unknown>
  return { inputTokens: numberOrNull(value.input_tokens ?? value.prompt_tokens), outputTokens: numberOrNull(value.output_tokens ?? value.completion_tokens) }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required')
    return parsed as Record<string, unknown>
  } catch { throw new ModelProtocolError('invalid_tool_arguments', '模型返回的工具参数不是有效 JSON 对象') }
}
