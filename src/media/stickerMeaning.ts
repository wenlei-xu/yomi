import type { StickerMeaning } from '../domain/types'

export function parseStickerMeaning(raw: string): StickerMeaning {
  let value: unknown
  try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) }
  catch { throw new Error('识图结果不是有效 JSON，请重试或更换识图模型') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('识图结果格式无效')
  const item = value as Record<string, unknown>
  const short = (value: unknown, length: number) => typeof value === 'string' ? value.trim().slice(0, length) : ''
  const list = (value: unknown) => Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string').map(entry => short(entry, 40)).filter(Boolean))].slice(0, 8) : []
  const result = { description: short(item.description, 240), text: short(item.text, 160), tags: list(item.tags), situations: list(item.situations) }
  if (!result.description || !result.tags.length || !result.situations.length) throw new Error('识图结果缺少含义或适用场景，请重试')
  return result
}

export function stickerMeaningText(meaning: StickerMeaning): string {
  return `${meaning.description}${meaning.text ? `；配字：${meaning.text}` : ''}；情绪：${meaning.tags.join('、')}；适用：${meaning.situations.join('、')}`
}

export async function stickerContentHash(dataUrl: string): Promise<string> {
  const encoded = dataUrl.split(',')[1] ?? ''
  const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
