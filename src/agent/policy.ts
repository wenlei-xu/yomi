import type { ModelBinding } from '../domain/types'

export function resolveBinding(bindings: ModelBinding[], purpose: ModelBinding['purpose'], agentId?: string): ModelBinding | undefined {
  const exact = bindings.find(item => item.purpose === purpose && item.agentId === agentId)
    ?? bindings.find(item => item.purpose === purpose && !item.agentId)
  if (exact || purpose === 'main') return exact
  if (purpose === 'triage') return resolveBinding(bindings, 'summary', agentId)
  return resolveBinding(bindings, 'main', agentId)
}

export function parseDecision(text: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const value: unknown = JSON.parse(cleaned)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('判断结果必须是对象')
  return value as Record<string, unknown>
}
