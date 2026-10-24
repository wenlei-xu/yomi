import type { LorebookEntry } from '../domain/types'
import { estimateTokens } from '../agent/limits'

export function worldContext(entries: (LorebookEntry & { bookTitle: string })[], visibleText: string, budget: number): string {
  const result: string[] = []
  let used = 0
  for (const e of entries.sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id))) {
    if (!e.enabled) continue
    const source = e.caseSensitive ? visibleText : visibleText.toLowerCase()
    const matches = (keys: string[]) => keys.some(key => key.trim() && source.includes(e.caseSensitive ? key : key.toLowerCase()))
    if (!e.constant && (!matches(e.keywords) || (e.selective && !matches(e.secondaryKeywords)))) continue
    const line = `[${e.bookTitle} / ${e.title || '设定'}]\n${e.content}`
    const cost = estimateTokens(line) + 4
    if (used + cost > budget) continue
    result.push(line); used += cost
  }
  return result.join('\n\n')
}
