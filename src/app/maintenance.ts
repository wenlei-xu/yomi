/** Wait for accepted commands before replacing data; reject commands during replacement. */
export class CommandGate {
  private blocked = false
  private readonly pending = new Set<Promise<unknown>>()

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.blocked) return Promise.reject(new Error('正在维护本地数据，请稍后再试'))
    const job = Promise.resolve().then(work)
    this.pending.add(job)
    const remove = () => { this.pending.delete(job) }
    void job.then(remove, remove)
    return job
  }

  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.blocked) throw new Error('正在维护本地数据，请稍后再试')
    this.blocked = true
    try {
      await Promise.allSettled([...this.pending])
      return await work()
    } finally { this.blocked = false }
  }
}
