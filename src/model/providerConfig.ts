import type { ProviderProtocol } from '../domain/types'

export function normalizeProviderAddress(raw: string, protocol: ProviderProtocol) {
  let url: URL
  try { url = new URL(raw.trim()) } catch { throw new Error('请填写完整服务地址，例如 https://api.example.com/v1') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址需使用 HTTP(S)，且不包含账号、密码或查询参数')
  }
  const path = url.pathname.replace(/\/+$/, '')
  const inferred = path.endsWith('/responses') ? 'responses' : path.endsWith('/chat/completions') ? 'chat-completions' : protocol
  url.pathname = path.replace(/\/(?:chat\/completions|responses|models|images\/generations|audio\/speech)$/, '')
  return { baseUrl: url.toString().replace(/\/+$/, ''), protocol: inferred as ProviderProtocol }
}
