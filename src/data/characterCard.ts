import type { Actor, LorebookEntry } from '../domain/types'

type Json = Record<string, unknown>
export const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

export interface ImportedCharacter {
  profile: Partial<Actor> & { name: string }
  sourceJson: string
  sourcePng: string
  warnings: string[]
  greetings: string[]
  book: ImportedBook | null
}
export interface ImportedBook {
  title: string
  description: string
  entries: Omit<LorebookEntry, 'id' | 'lorebookId' | 'createdAt' | 'updatedAt'>[]
}

export function parseWorldBook(value: unknown, fallback = '导入的世界书'): ImportedBook {
  const book = object(value)
  if (!book.entries || typeof book.entries !== 'object') throw new Error('世界书缺少条目列表')
  const entries = Array.isArray(book.entries) ? book.entries : Object.values(object(book.entries))
  if (entries.length > 2000) throw new Error('世界书最多支持 2000 条条目')
  return {
    title: string(book.name) || string(book.title) || fallback,
    description: string(book.description),
    entries: entries.map((raw, index) => {
      const e = object(raw)
      const content = string(e.content)
      if (!content.trim() || content.length > 65536) throw new Error(`世界书第 ${index + 1} 条内容为空或过长`)
      return {
        title: string(e.name) || string(e.comment) || string(e.title), content,
        keywords: strings(e.keys ?? e.key ?? e.keywords),
        secondaryKeywords: strings(e.secondary_keys ?? e.keysecondary ?? e.secondaryKeywords),
        enabled: e.enabled !== false && e.disable !== true,
        constant: e.constant === true, selective: e.selective === true,
        caseSensitive: e.case_sensitive === true || e.caseSensitive === true,
        ordinal: typeof (e.insertion_order ?? e.order ?? e.ordinal) === 'number'
          ? Number(e.insertion_order ?? e.order ?? e.ordinal) : index,
        sourceJson: JSON.stringify(e)
      }
    })
  }
}

export function parseCharacterCard(raw: string, sourcePng = ''): ImportedCharacter {
  if (raw.length > 16_000_000) throw new Error('角色卡内容不能超过 16 MB')
  let parsed: unknown
  try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch { throw new Error('角色卡不是有效 JSON') }
  const root = object(parsed)
  if (root.spec !== undefined && !['chara_card_v2', 'chara_card_v3'].includes(String(root.spec))) {
    throw new Error('不支持此角色卡版本；支持 V1、V2、V3 的 JSON 和 PNG')
  }
  const data = root.spec ? object(root.data) : root
  const name = string(data.name).trim()
  if (!name || name.length > 100) throw new Error('角色名称需为 1–100 字')
  const persona = [string(data.description), string(data.scenario) ? `场景：\n${data.scenario}` : '',
    string(data.mes_example) ? `对话示例：\n${data.mes_example}` : ''].filter(Boolean).join('\n\n')
  if (persona.length > 200000 || string(data.personality).length > 65536) throw new Error('角色设定过长')
  const warnings = ['原始角色卡的全部字段已保存，可在角色编辑页导出原卡。',
    '酒馆宏仅替换 {{char}} 和 {{user}}；脚本、正则、特殊注入位置及其他扩展仅保留。']
  if (data.system_prompt || data.post_history_instructions) warnings.push('卡片的系统提示与历史后指令保留在原卡中，未覆盖 Yomi 的运行指令。')
  if (data.character_book) warnings.push('附带世界书已导入并限定该角色使用；高级触发扩展仅保留。')
  return {
    profile: { name, bio: '', persona, speakingStyle: string(data.personality), avatarData: sourcePng,
      color: '#7c3aed', enabled: true, archived: false, allowPrivate: true, allowGroup: true },
    sourceJson: JSON.stringify(root), sourcePng, warnings,
    greetings: [string(data.first_mes), ...strings(data.alternate_greetings)].filter(Boolean),
    book: data.character_book ? parseWorldBook(data.character_book, `${name} 的世界书`) : null
  }
}

export function replaceCardMacros(value: string, char: string, user: string): string {
  return value.replace(/\{\{char\}\}/gi, () => char).replace(/\{\{user\}\}/gi, () => user)
}

/** Read standard UTF-8/base64 tEXt chunks; CCv3 takes precedence over chara. */
export function readPngCard(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) throw new Error('不是有效 PNG 文件')
  const view = new DataView(buffer)
  const found = new Map<string, string>()
  let offset = 8, ended = false
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset), end = offset + 12 + length
    if (end > bytes.length) throw new Error('PNG 文件已截断')
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8))
    if (type === 'tEXt') {
      const chunk = bytes.subarray(offset + 8, offset + 8 + length)
      const zero = chunk.indexOf(0)
      const keyword = new TextDecoder().decode(chunk.subarray(0, zero)).toLowerCase()
      if (zero > 0 && (keyword === 'chara' || keyword === 'ccv3')) {
        found.set(keyword, new TextDecoder().decode(chunk.subarray(zero + 1)))
      }
    }
    offset = end
    if (type === 'IEND') { ended = true; break }
  }
  if (!ended) throw new Error('PNG 缺少结束标记')
  const encoded = found.get('ccv3') ?? found.get('chara')
  if (!encoded) throw new Error('图片没有酒馆角色卡数据')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0))) }
  catch { throw new Error('PNG 角色卡数据损坏') }
}
