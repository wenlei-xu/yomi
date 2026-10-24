// SSE frames may cross network chunks, including UTF-8 and CRLF boundaries.
export class EventFrames {
  private buffer = ''
  constructor(private readonly receive: (data: string) => void) {}
  push(chunk: string): void {
    this.buffer += chunk
    let match: RegExpExecArray | null
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n')
      if (data) this.receive(data)
    }
  }
}

export function messagePreview(argumentsText: string): string {
  const match = /"body"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(argumentsText)
  if (!match) return ''
  // Discard an incomplete escape until the next delta arrives.
  const value = match[1].replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, '')
  try { return JSON.parse(`"${value}"`) as string } catch { return '' }
}

export class ModelStream {
  private text = ''
  private calls = new Map<number, { id: string; name: string; arguments: string }>()
  private usage: unknown
  private completed: Record<string, unknown> | null = null
  private finished = false
  private failure = ''
  readonly frames: EventFrames

  constructor(private readonly protocol: string, private readonly preview: (text: string) => void = () => {}) {
    this.frames = new EventFrames(data => this.event(data))
  }

  private event(data: string): void {
    if (data === '[DONE]') return
    const event = JSON.parse(data) as Record<string, any>
    if (event.error || /response\.(failed|incomplete)|^error$/.test(event.type ?? '')) {
      this.failure = '流式响应失败或不完整'
      return
    }
    if (this.protocol === 'responses') {
      if (event.type === 'response.completed') this.completed = event.response
      if (event.type === 'response.output_text.delta') { this.text += event.delta ?? ''; this.preview(this.text) }
      if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
        this.calls.set(event.output_index, { id: event.item.call_id, name: event.item.name, arguments: event.item.arguments ?? '' })
      }
      if (event.type === 'response.function_call_arguments.delta') {
        const call = this.calls.get(event.output_index)
        if (call) { call.arguments += event.delta ?? ''; if (call.name === 'message_send') this.preview(messagePreview(call.arguments)) }
      }
      return
    }
    if (event.usage) this.usage = event.usage
    const choice = event.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) {
      this.finished = ['stop', 'tool_calls'].includes(choice.finish_reason)
      if (!this.finished) this.failure = '流式响应被截断'
    }
    this.text += choice.delta?.content ?? ''
    if (choice.delta?.content) this.preview(this.text)
    for (const delta of choice.delta?.tool_calls ?? []) {
      const call = this.calls.get(delta.index) ?? { id: '', name: '', arguments: '' }
      call.id += delta.id ?? ''
      call.name += delta.function?.name ?? ''
      call.arguments += delta.function?.arguments ?? ''
      this.calls.set(delta.index, call)
      if (call.name === 'message_send') this.preview(messagePreview(call.arguments))
    }
  }

  result(): Record<string, unknown> {
    if (this.failure) throw new Error(this.failure)
    if (this.protocol === 'responses') {
      if (!this.completed) throw new Error('流式响应在完成事件之前断开')
      return this.completed
    }
    if (!this.finished) throw new Error('流式响应在完成之前断开')
    return { choices: [{ finish_reason: this.calls.size ? 'tool_calls' : 'stop', message: {
      content: this.text,
      tool_calls: [...this.calls.values()].map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }))
    } }], usage: this.usage }
  }
}
