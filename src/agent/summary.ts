/** Older providers can still return a plain cumulative summary. */
export function parseSummaryResult(text: string): { cumulative: string; segment: string } {
  const clean = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1').trim()
  if (!clean) throw new Error('摘要为空')
  if (!clean.startsWith('{')) return { cumulative: clean.slice(0, 12000), segment: '' }
  const parsed: unknown = JSON.parse(clean)
  if (!parsed || typeof parsed !== 'object' || !('cumulative' in parsed)
      || typeof parsed.cumulative !== 'string' || !parsed.cumulative.trim()) throw new Error('累计摘要格式无效')
  return { cumulative: parsed.cumulative.trim().slice(0, 12000),
    segment: 'segment' in parsed && typeof parsed.segment === 'string' ? parsed.segment.trim().slice(0, 6000) : '' }
}
