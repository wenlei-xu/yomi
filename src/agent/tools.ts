import type { ToolDefinition } from '../domain/types'

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'conversation_read',
    description: '读取当前会话最近消息，用于回应前核对上下文。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 30 } },
      additionalProperties: false
    }
  },
  {
    name: 'conversation_search',
    description: '在当前会话中按关键词搜索自己有权阅读的消息。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'conversation_members',
    description: '读取当前会话成员及其公开身份信息。',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'message_send',
    description: '以当前角色发送正式消息。文字可穿插小表情。也可使用 sticker_list 返回的真实 ID 发送图片表情包；纯表情包不必填写正文。',
    parameters: {
      type: 'object',
      properties: {
        body: { type: 'string', minLength: 1, maxLength: 32768, description: '正文可自然穿插 [微笑]、[捂脸]、[旺柴]、[裂开] 等微信式小表情，会显示为行内图片。图片表情包使用 stickerId，不要编造表情包 ID。' },
        quotedMessageId: { type: 'string' },
        stickerId: { type: 'string', description:'可选，sticker_list 返回的已识别表情 ID；按含义和场景选择，不能编造。' },
        conversationId: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  { name:'sticker_list',description:'查找本机已理解含义的表情包，返回 ID、画面含义、配字及适用场景。可按情绪或场景查询；不返回尚未识别的图片。',
    parameters:{type:'object',properties:{query:{type:'string',maxLength:80,description:'可选，简短情绪或场景关键词，例如：晚安、开心、无语'}},additionalProperties:false} },
  {
    name: 'message_react',
    description: '对当前会话中的一条消息添加或取消一个表情。',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        emoji: { type: 'string', minLength: 1, maxLength: 16 }
      },
      required: ['messageId', 'emoji'],
      additionalProperties: false
    }
  },
  {
    name: 'direct_open',
    description: '与当前会话中另一名角色打开一对一私聊。只在确有交流需要时使用。',
    parameters: {
      type: 'object',
      properties: { targetAgentId: { type: 'string' } },
      required: ['targetAgentId'],
      additionalProperties: false
    }
  },
  {
    name: 'group_create',
    description: '邀请当前会话中的角色建立一个角色小组，自己会自动加入。可用返回的 ID 随后发送首条消息。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 100 },
        memberIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 7
        }
      },
      required: ['title', 'memberIds'],
      additionalProperties: false
    }
  },
  {
    name: 'memory_read',
    description: '读取自己的文字记忆，可按关键词筛选。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 200 } },
      additionalProperties: false
    }
  },
  {
    name: 'memory_write',
    description: '记录一条当前会话范围的文字记忆。',
    parameters: {
      type: 'object',
      properties: {
        body: { type: 'string', minLength: 1, maxLength: 16384 },
        kind: { type: 'string', maxLength: 40 },
        about: { type: 'string', maxLength: 200 },
        sourceMessageIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 }
      },
      required: ['body'],
      additionalProperties: false
    }
  },
  {
    name: 'memory_remove',
    description: '删除自己自动记录的一条记忆；不能删除用户手工记忆。',
    parameters: {
      type: 'object',
      properties: { memoryId: { type: 'string' } },
      required: ['memoryId'],
      additionalProperties: false
    }
  },
  {
    name: 'turn_finish',
    description: '结束当前处理。用户单聊须先回复；群聊在无需补充、别人已回答或点名其他成员时可直接结束并保持沉默。角色间会话也可直接结束。',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', maxLength: 200 } },
      additionalProperties: false
    }
  }
]

export function validateToolCall(name: string, args: unknown): asserts args is Record<string, unknown> {
  const definition = toolDefinitions.find(tool => tool.name === name)
  if (!definition) throw new Error('未知工具')
  validate(definition.parameters, args)
}

function validate(schema: Record<string, unknown>, value: unknown): void {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工具参数必须是对象')
    const object = value as Record<string, unknown>
    const properties = schema.properties as Record<string, Record<string, unknown>>
    for (const required of (schema.required ?? []) as string[]) {
      if (!(required in object)) throw new Error(`工具缺少参数：${required}`)
    }
    for (const [key, entry] of Object.entries(object)) {
      if (!properties[key]) throw new Error(`未知工具参数：${key}`)
      validate(properties[key], entry)
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < Number(schema.minLength ?? 0) ||
      value.length > Number(schema.maxLength ?? Infinity)) throw new Error('工具文本参数类型或长度无效')
  } else if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < Number(schema.minimum ?? -Infinity) ||
      value > Number(schema.maximum ?? Infinity)) throw new Error('工具整数参数无效')
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < Number(schema.minItems ?? 0) ||
      value.length > Number(schema.maxItems ?? Infinity)) throw new Error('工具数组参数无效')
    for (const item of value) validate(schema.items as Record<string, unknown>, item)
  }
}
