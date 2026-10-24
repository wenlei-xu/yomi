import type { Provider, ProviderModel } from '../domain/types'
import { secureGet } from '../platform/secureTransport'
import { normalizeProviderAddress } from './providerConfig'

export function parseProviderModels(payload: unknown): { models: ProviderModel[]; hasMore: boolean; cursor: string } {
  const json = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const items = Array.isArray(payload) ? payload : Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : null
  if (!items) throw new Error('服务未返回可识别的模型列表，仍可手动填写模型 ID')
  const models = new Map<string, ProviderModel>()
  for (const value of items) {
    const row = typeof value === 'string' ? { id: value } : value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const id = typeof row.id === 'string' ? row.id.trim() : typeof row.name === 'string' ? row.name.trim() : ''
    if (!id || id.length > 500) continue
    models.set(id, { id, name: typeof row.name === 'string' ? row.name : id, owner: typeof row.owned_by === 'string' ? row.owned_by : '' })
  }
  return { models: [...models.values()], hasMore: json.has_more === true,
    cursor: typeof json.last_id === 'string' ? json.last_id : [...models.keys()].at(-1) ?? '' }
}

export async function fetchProviderModels(provider: Pick<Provider, 'id' | 'baseUrl' | 'protocol'>, signal?: AbortSignal): Promise<ProviderModel[]> {
  const { baseUrl } = normalizeProviderAddress(provider.baseUrl, provider.protocol)
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timeout = setTimeout(abort, 20000)
  const models = new Map<string, ProviderModel>(), cursors = new Set<string>()
  let cursor = ''
  try {
    for (let page = 0; page < 20; page++) {
      const url = `${baseUrl}/models${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`
      const response = await secureGet(provider.id, url, controller.signal)
      if (response.status === 401) throw new Error('认证失败（401），请检查此连接的 API Key')
      if (response.status === 403) throw new Error('访问被拒绝（403），请检查 Key 的模型权限或服务商限制')
      if ([404, 405, 501].includes(response.status)) throw new Error('此地址不提供兼容的模型列表接口，可检查 Base URL 或手动填写模型 ID')
      if (response.status < 200 || response.status >= 300) throw new Error(`拉取模型失败（${response.status}），请检查服务状态后重试`)
      let payload: unknown
      try { payload = JSON.parse(response.body) } catch { throw new Error('服务没有返回 JSON 模型列表，请检查 API 根地址是否正确') }
      const result = parseProviderModels(payload)
      for (const model of result.models) models.set(model.id, model)
      if (models.size > 10000) throw new Error('服务返回的模型超过 10,000 个，请手动填写模型 ID')
      if (!result.hasMore) return [...models.values()].sort((a, b) => a.id.localeCompare(b.id))
      if (!result.cursor || cursors.has(result.cursor)) throw new Error('模型列表分页信息无效，请手动填写模型 ID')
      cursor = result.cursor; cursors.add(cursor)
    }
    throw new Error('模型列表分页过多，请手动填写模型 ID')
  } catch (error) {
    if (controller.signal.aborted) throw new Error(signal?.aborted ? '已取消拉取模型' : '拉取模型超时，请检查地址与网络后重试')
    if (error instanceof TypeError) throw new Error('无法访问服务，请检查地址与网络；浏览器预览还需要服务商允许跨域访问')
    throw error
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
}

export async function testProviderConnection(provider: Pick<Provider, 'id' | 'baseUrl' | 'protocol'>, signal?: AbortSignal): Promise<string> {
  const { baseUrl } = normalizeProviderAddress(provider.baseUrl, provider.protocol)
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timeout = setTimeout(abort, 15000)
  try {
    const response = await secureGet(provider.id, `${baseUrl}/models`, controller.signal)
    if (response.status === 401) throw new Error('认证失败（401），请检查 API Key')
    if (response.status === 403) throw new Error('访问被拒绝（403），请检查 Key 权限')
    if ([404, 405, 501].includes(response.status)) throw new Error(`渠道可访问，但模型接口返回 ${response.status}；请检查 Base URL`)
    if (response.status < 200 || response.status >= 300) throw new Error(`渠道返回 ${response.status}，请检查服务状态`)
    return '连接成功，认证通过'
  } catch (error) {
    if (controller.signal.aborted) throw new Error(signal?.aborted ? '已取消测试' : '测试超时，请检查地址与网络')
    if (error instanceof TypeError) throw new Error('无法访问渠道，请检查地址与网络；浏览器预览还需要服务商允许跨域访问')
    throw error
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
}
