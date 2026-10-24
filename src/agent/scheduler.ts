type Job = { conversationId: string; priority: number; enqueuedAt: number;
  run: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void }

export class AgentQueue {
  private readonly queues = new Map<string, Job[]>()
  private readonly active = new Set<string>()

  enqueue(agentId: string, conversationId: string, priority: number, run: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const jobs = this.queues.get(agentId) ?? []
      jobs.push({ conversationId, priority, run, resolve, reject, enqueuedAt: Date.now() })
      this.queues.set(agentId, jobs)
      void this.drain(agentId)
    })
  }

  cancel(conversationId?: string): void {
    for (const [agentId, jobs] of this.queues) {
      const retained = jobs.filter(job => {
        if (conversationId !== undefined && job.conversationId !== conversationId) return true
        job.resolve()
        return false
      })
      this.queues.set(agentId, retained)
    }
  }

  private async drain(agentId: string): Promise<void> {
    if (this.active.has(agentId)) return
    this.active.add(agentId)
    try {
      while (true) {
        const jobs = this.queues.get(agentId) ?? []
        if (!jobs.length) break
        const now = Date.now()
        // Ten seconds waiting outweighs one priority step: peer work cannot starve.
        jobs.sort((a, b) => (b.priority + (now - b.enqueuedAt) / 10000)
          - (a.priority + (now - a.enqueuedAt) / 10000))
        const next = jobs.shift()!
        try { await next.run(); next.resolve() } catch (error) { next.reject(error) }
      }
    } finally { this.active.delete(agentId); this.queues.delete(agentId) }
  }
}
