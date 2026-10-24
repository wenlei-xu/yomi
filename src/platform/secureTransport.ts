import { Capacitor } from '@capacitor/core'
import { SecureVault } from './nativeBridge'

const browserSecrets = new Map<string, string>()
let nativePluginVerified: Promise<boolean> | null = null

export function modelOrigin(baseUrl: string): string {
  const parsed = new URL(baseUrl)
  return `${parsed.protocol}//${parsed.host}`
}

export async function storeCredential(providerId: string, secret: string, origin: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await SecureVault.setWithoutSecret({ providerId, secret: '', origin })
  } else {
    if (!secret.trim()) return
    browserSecrets.set(providerId, secret)
  }
}

export async function verifySecureVault(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return true
  nativePluginVerified ??= SecureVault.set({
    providerId: '__yomi_self_test__',
    secret: crypto.randomUUID(),
    origin: 'https://example.invalid'
  }).then(async () => {
    await SecureVault.remove({ providerId: '__yomi_self_test__' })
    return true
  }).catch(() => false)
  return nativePluginVerified
}

export async function removeCredential(providerId: string): Promise<void> {
  if (Capacitor.isNativePlatform()) await SecureVault.remove({ providerId })
  else browserSecrets.delete(providerId)
}

export async function credentialStatus(providerId: string): Promise<boolean> {
  if (Capacitor.isNativePlatform()) return (await SecureVault.status({ providerId })).stored
  return browserSecrets.has(providerId)
}

export async function secureRequest(
  providerId: string,
  url: string,
  body: string,
  signal: AbortSignal
): Promise<{ status: number; body: string; contentType?: string }>;
export async function secureRequest(
  providerId: string,
  url: string,
  body: string,
  signal: AbortSignal,
  binary: boolean,
  onChunk?: (chunk: string) => void
): Promise<{ status: number; body: string; contentType?: string }>;
export async function secureRequest(
  providerId: string,
  url: string,
  body: string,
  signal: AbortSignal,
  binary = false,
  onChunk?: (chunk: string) => void
): Promise<{ status: number; body: string; contentType?: string }> {
  if (signal.aborted) throw new Error('cancelled')
  if (Capacitor.isNativePlatform()) {
    const requestId = crypto.randomUUID()
    const abort = () => { void SecureVault.cancel({ requestId }) }
    const listener = onChunk ? await SecureVault.addListener('requestChunk', event => {
      if (event.requestId === requestId && !signal.aborted) onChunk(event.chunk)
    }) : null
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (signal.aborted) throw new Error('cancelled')
      return await SecureVault.request({ requestId, providerId, url, body, binary, stream: Boolean(onChunk) })
    } finally {
      signal.removeEventListener('abort', abort)
      await listener?.remove()
    }
  }
  const secret = browserSecrets.get(providerId)
  if (!secret) throw new Error('模型凭证缺失，请重新配置 API Key。')
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body
  })
  if (binary && response.ok) {
    const mime = response.headers.get('content-type') ?? ''
    if (!mime.startsWith('audio/')) throw new Error('语音服务没有返回音频')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length > 8 * 1024 * 1024) throw new Error('音频超过 8 MB')
    let data = ''
    for (let i=0;i<bytes.length;i+=8192) data += String.fromCharCode(...bytes.subarray(i,i+8192))
    return { status: response.status, body: btoa(data) }
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (onChunk && response.ok && contentType.includes('text/event-stream') && response.body) {
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let bodyText = '', bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > 8 * 1024 * 1024) throw new Error('模型响应超过 8 MB')
        const chunk = decoder.decode(value, { stream: true })
        bodyText += chunk; onChunk(chunk)
      }
      const tail = decoder.decode(); bodyText += tail; if (tail) onChunk(tail)
      return { status: response.status, body: bodyText, contentType }
    } catch (error) { await reader.cancel(); throw error }
    finally { reader.releaseLock() }
  }
  return { status: response.status, body: await response.text(), contentType }
}
