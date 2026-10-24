import type { Provider } from '../domain/types'
import { secureRequest } from '../platform/secureTransport'

const maxImageBytes = 8 * 1024 * 1024

export class MediaProtocolError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

export type ImageResult = { dataUrl: string; mimeType: string; width: number; height: number }

/**
 * Image generation goes through the provider already configured for chat, using
 * the OpenAI-compatible `/images/generations` endpoint. No separate service is
 * introduced, so nothing is uploaded anywhere the user did not configure.
 */
export async function generateImage(
  provider: Provider,
  modelId: string,
  prompt: string,
  signal: AbortSignal,
  size = '1024x1024'
): Promise<ImageResult> {
  const base = provider.baseUrl.replace(/\/$/, '')
  const url = `${base}/images/generations`
  const response = await secureRequest(provider.id, url, JSON.stringify({
    model: modelId, prompt, n: 1, size,
    response_format: /^(gpt-image|chatgpt-image)/i.test(modelId) ? undefined : 'b64_json'
  }), signal)
  if (response.status < 200 || response.status >= 300) {
    throw new MediaProtocolError(`http_${response.status}`, `${response.status} ${response.body.slice(0, 200)}`)
  }
  let json: Record<string, unknown>
  try { json = JSON.parse(response.body) as Record<string, unknown> } catch {
    throw new MediaProtocolError('invalid_response', '图片服务返回了无法解析的响应')
  }
  const first = (Array.isArray(json.data) ? json.data[0] : undefined) as Record<string, unknown> | undefined
  const base64 = typeof first?.b64_json === 'string' ? first.b64_json : ''
  if (!base64) throw new MediaProtocolError('invalid_response', '图片服务没有返回图片数据')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new MediaProtocolError('invalid_response', '图片编码无效')
  const mimeType = base64.startsWith('/9j/') ? 'image/jpeg' : base64.startsWith('UklGR') ? 'image/webp' : 'image/png'
  const dataUrl = `data:${mimeType};base64,${base64}`
  if (dataUrl.length > maxImageBytes) throw new MediaProtocolError('too_large', '生成的图片过大')
  const [width, height] = size.split('x').map(value => Number(value) || 0)
  return { dataUrl, mimeType, width, height }
}

export type SpeechResult = { dataUrl: string; mimeType: string; durationMs: number }

/** Speech synthesis through the same provider, via `/audio/speech`. */
export async function generateSpeech(
  provider: Provider,
  modelId: string,
  input: string,
  voice: string,
  signal: AbortSignal,
  speed = 1
): Promise<SpeechResult> {
  if (!input.trim() || input.length > 4096) throw new Error('朗读文字需为 1–4096 字')
  const base = provider.baseUrl.replace(/\/$/, '')
  const url = `${base}/audio/speech`
  const response = await secureRequest(provider.id, url, JSON.stringify({
    model: modelId, input, voice: voice || 'alloy', response_format: 'mp3', speed
  }), signal, true)
  if (response.status < 200 || response.status >= 300) {
    throw new MediaProtocolError(`http_${response.status}`, `${response.status} ${response.body.slice(0, 200)}`)
  }
  return { dataUrl: `data:audio/mpeg;base64,${response.body}`, mimeType: 'audio/mpeg', durationMs: 0 }
}

