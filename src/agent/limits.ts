import type { ModelRequest } from '../domain/types'

export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  let total = 0
  for (const char of text) total += char.charCodeAt(0) < 128 ? 0.3 : 2
  return Math.ceil(total)
}

export function assertContextFits(request: ModelRequest, contextTokens: number): void {
  if (!Number.isSafeInteger(contextTokens) || contextTokens < 1024 ||
    !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens! < 1) {
    throw new Error('模型上下文或输出上限配置无效')
  }
  if (estimateTokens(request) + request.maxOutputTokens! + 256 > contextTokens) {
    throw new Error('上下文超过配置窗口，请缩短人设、消息或调大上下文设置')
  }
}

type Waiter = { signal: AbortSignal; resolve: () => void; reject: (error: Error) => void; abort: () => void }

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('cancelled'))
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('cancelled')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export class RequestGate {
  private active = 0
  private queue: Waiter[] = []
  constructor(private readonly limit = 2) {}

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new Error('cancelled')
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { signal, resolve, reject, abort: () => {
        this.queue = this.queue.filter(item => item !== waiter)
        reject(new Error('cancelled'))
      } }
      this.queue.push(waiter)
      signal.addEventListener('abort', waiter.abort, { once: true })
      this.drain()
    })
    try {
      if (signal.aborted) throw new Error('cancelled')
      return await work()
    } finally { this.active--; this.drain() }
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length) {
      const next = this.queue.shift()!
      next.signal.removeEventListener('abort', next.abort)
      if (next.signal.aborted) { next.reject(new Error('cancelled')); continue }
      this.active++
      next.resolve()
    }
  }
}
