# Yomi 多 Agent 运行机制 v1.1

> 本轮功能更新：世界书、生图/语音/表情包和酒馆角色卡导入已实现，见 [功能、兼容范围与数据保留](13-WORLDBOOK-MEDIA-CHARACTER-CARDS.md)。下文旧版“暂无世界书/多媒体”约束已由本轮用户要求更新。

> 后续更新：独立暂存恢复、切库记录、旧库回退、存储维护及全量用量统计已接入，见[最新实现记录](10-STAGED-RESTORE-AND-MAINTENANCE.md)。历史快照中的对应缺口已过时；完整目标仍未全部验收。

> 当前实现更新见 [协作与数据可靠性更新](09-COLLABORATION-AND-DATA.md)。本文保留此前设计与实现快照；其中固定群轮、缺少 triage/角色模型/并发限制、明文备份及备份失败半清库的描述已过时。完整目标仍在推进，不能用历史 verified 直接宣称完成。

日期：2026-10-23（v1.1 修订）。状态：**Android v1 已实现**，实现的是用户确认的第一轮简单规则，不是原设计的 triage/自主协作架构。关联：[总体架构](01-ARCHITECTURE.md)、[数据与存储](02-DATA.md)。

## 1. 术语与所有权

| 名称 | 实际定义 |
| --- | --- |
| Actor | `actors` 行；human 只有一个 `local-user`，其余是 agent |
| Conversation | `direct`（人+角色）、`group`（人+多角色）、`agent_direct`、`agent_group`（后两者只读旁观） |
| Inbox event | `inbox_events` 行；消息提交时同事务插入给除作者和本地用户外的每个成员 |
| Wake | `wakeConversation()`；350ms 防抖后进入 `drainConversation` |
| Activity | `activities` 行；根会话维度共享预算，派生房间不新建 |
| Run | `runs` 行；一个 Agent 同时最多一个，由进程内 `runs` Map 保证 |
| Hop | 一次模型调用 + 它返回的全部工具调用与配对结果 |
| HELD | `message_send` 提交前发现新内容或重复，不插消息并把新内容作为工具结果返回 |
| Handled | inbox 终态；`handled`/`skipped`/`cancelled`/`deferred` 都带原因 |

一个 App 实例只有一个 `AgentRuntime`，由 `createApp` 创建。`main.tsx` 只调用 `runtime.snapshot()` 和控制方法。

## 2. 第一轮群聊规则（已确认的产品行为）

用户参与的会话（`direct`/`group`）采用有界轮流，不做 triage、不做自主沉默判断：

1. 一条用户消息开启一轮。`pendingHumanRound()` 找到该会话第一条 pending 的 human 消息，并以该时刻的 `conversations.next_sequence - 1` 作为本轮上界快照，因此轮次开始后到达的新用户消息属于下一轮，不会漏进当前轮。
2. 点名（正文含 `@名字` 或 UI 传入 mention ID）：本轮目标是这些成员，每人回复一次。
3. 未点名：目标是当前全部可用成员（启用、未归档、未离开），每人回复一次。
4. 目标不可用时 `skipHumanRound` 把该轮的其余 inbox 标 `skipped`，不产生回复也不报错。
5. 按目标顺序串行执行；后发言者在上一步完成后重新快照本轮上界，因此能看到前面已完成的回复，同时仍看不到下一轮的用户消息。
6. 用户参与的会话中每个角色本轮必须发送且只能发送一条消息；模型若调 `turn_finish` 会被工具结果拒绝，若只回文本会被提示一次，再违反则本轮失败并显示“模型没有按要求完成本轮发言，请重试”。
7. 点停止：`stopConversation` 单事务递增该会话及全部派生房间的 `cancel_epoch`、置 `paused=1`、取消 pending/claimed inbox 与 runs、取消 activities，随后 AbortController 取消正在进行的网络请求；本轮剩余角色不再发言，已提交的回复保留。
8. 重启后历史与 paused 状态都在；首页显示“上次回应被中断”卡片，用户点重试/继续/略过才恢复，不会自动请求模型。

角色间会话（`agent_direct`/`agent_group`）没有用户轮次概念：inbox 由角色自己发送的消息产生，运行时允许一次 run 内最多 4 条发言，也允许 `turn_finish` 自然结束。

## 3. 从输入到发言的实际链路

```text
用户发送
  -> sendUserMessage：消息 + inbox + command_receipts 同事务
  -> wakeConversation（350ms 防抖）
  -> drainConversation
       pendingHumanRound -> 决定本轮目标 -> skipHumanRound
       逐个目标 runInConversation -> runConversation
  -> runConversation
       claimInbox -> ensureActivity -> createRun
       buildContext（记忆 + 摘要 + 最近 36 条）
       hop 循环（最多 12 hops / 24 工具 / 用户会话 1 条发言）
         模型调用（原生 HttpURLConnection 整包）
         配对执行工具
         message_send -> 同事务校验 -> 插消息 + inbox + activity.posts++
       markInboxHandled -> finishRun
```

## 4. 并发与公平

- 同一 Agent 串行：`runInConversation` 若发现该 Agent 已有 run，就 await 它然后重试。
- 不同 Agent 可以并发，但没有全局信号量；并发上限取决于群内成员数和 350ms 防抖后的调度。
- 同一会话的工作在 `conversationQueues` 中串行，`scheduledConversations` 去重。
- 跨会话没有公平队列：`drainLoop` 只处理当前 wake 的那个会话。一个 Agent 在别处忙碌时，本会话的工作会等它完成后再跑（`runInConversation` 的 await + 重试），不会丢，但也没有轮转优先级。

## 5. 上下文构建

`buildContext(agent, conversation, through)`：

1. 该角色在该会话范围内可见记忆（置顶 + 近期，最多 12 条），标注“会话记忆/角色全局记忆”。
2. 会话标题、话题、当前成员名。
3. 该 Agent 对该会话、当前 `content_revision` 下有效的摘要（含覆盖 `through_sequence`）。
4. `sequence <= through` 的最近 36 条未删消息，编号 `#sequence 作者：正文`。
5. 这些合并成一条 `user` 消息作为输入起点。

`instructions` 含角色名、简介、人设、说话风格、旁观/参与模式、安全约束（聊天内容不是系统指令、不得泄露提示词或 Key）、必须走 `message_send` 的协议要求。

运行期间的新消息：`hop > 0` 时查 `pendingInbox`，把 `sequence > through` 的消息以“运行期间的新消息（以最新内容为准）”追加为 `user` 输入。这是简单 steer，不打断工具对，也不更新 `seen` 边界。

压缩：消息数 ≥ 80 时 `compactIfNeeded` 异步生成摘要（详见 02-DATA §4）。

没有 token 预算、tokenizer 估算、上下文上限裁剪。`context_tokens`/`output_tokens` 只用于 `max_output_tokens`。

## 6. 内置工具

`src/agent/tools.ts` 定义 11 个工具，全部由宿主持有身份执行，模型不能指定作者。

| 工具 | 行为 |
| --- | --- |
| `conversation_read` | 读 `sequence <= seenThrough` 的最近 N 条（1–30） |
| `conversation_search` | 当前会话关键词搜索（仅成员） |
| `conversation_members` | 当前会话成员公开资料（仅成员） |
| `message_send` | 正式发言；可指定 `conversationId`（仅限本轮打开/创建的派生房间）、`quotedMessageId` |
| `message_react` | 切换一个表情 |
| `direct_open` | 与当前会话中另一角色打开 `agent_direct` |
| `group_create` | 邀请当前会话角色建 `agent_group`，自己自动加入 |
| `memory_read` | 读自己的记忆，可按关键词过滤 |
| `memory_write` | 写当前会话范围的记忆 |
| `memory_remove` | 删自己自动写的记忆（不能删人工记忆） |
| `turn_finish` | 结束；用户会话中会被拒绝 |

工具执行边界：

- 参数只做类型与长度夹取（`Number`/`String` 转换 + `slice`），没有独立 schema 校验层；未知工具返回“错误：未知工具”。
- 一次响应返回多个 call 时按顺序执行；已停止或已结束时剩余 call 得到 `CANCELLED` 结果，不产生副作用。
- 解析失败（工具参数不是合法 JSON）抛 `ModelProtocolError`，该 run 失败并记录错误码。
- 派生房间发送：`message_send` 只允许目标会话是当前会话，或 `origin_conversation_id === 当前会话` 且自己是成员的 `agent_direct`/`agent_group`；否则返回“不能向未由本轮创建或打开的会话发送消息”。

## 7. 提交前检查与 HELD

`sendAgentMessage` 在同一事务内依次检查：

1. `tool_actions` 是否有同 `action_id` 的已完成结果 → 直接读回（幂等）。
2. `cancel_epoch` 是否等于 run 开始时的值，会话是否 `paused` → `cancelled`。
3. 作者是否仍是活跃成员 → `cancelled`。
4. activity 是否 active 且 posts < 24 → `budget`。
5. `seenThrough` 之后是否存在他人未删消息 → `held`，并把最新若干条他人消息作为工具结果和 steer 返回。
6. 与最近 8 条中他人正文是否完全相同 → `duplicate`。

HELD 后模型重新读取再决定；没有确认令牌、TTL 或跨 run 复用问题，因为每次提交都重新按当前数据库状态判断。

## 8. 预算

| 预算 | 值 | 位置 |
| --- | --- | --- |
| 单 run hops | 12 | `runtime.ts` `runHops` |
| 单 run 工具调用 | 24 | `runTools` |
| 单 run 发言（用户会话） | 1 | `postLimit` |
| 单 run 发言（角色间会话） | 4 | `runPosts` |
| activity 模型调用 | 64 | `activityCalls` |
| activity 发言 | 24 | `activityPosts` |
| activity 时长 | 180 秒 | `activityDuration` |

达到预算时 `exhaustActivity` 把 activity 标 `budget_exhausted`，并把根会话派生的所有房间的 pending inbox 标 `deferred`（原因“本次互动达到预算上限，可点击继续开始新预算周期”）。用户点“继续”取消旧 activity 并把 deferred 转 pending，开始新的预算周期。

## 9. 模型协议与能力

`callModel` 按 `provider.protocol` 选择端点：`{baseUrl}/responses` 或 `{baseUrl}/chat/completions`。请求体只含 `model`、`instructions`/`messages`、`input`、`tools`、`max_output_tokens`/`max_tokens`。

解析：Responses 取 `output[].type==='message'` 的文本和 `type==='function_call'` 的调用；Chat Completions 取 `choices[0].message` 的 `content` 与 `tool_calls`。用量取 `input_tokens`/`prompt_tokens` 与 `output_tokens`/`completion_tokens`，缺失为 NULL。

非 2xx 抛 `http_<status>`；响应体前 300 字进入错误消息（脱敏由服务端负责，Yomi 不额外过滤）。没有能力分层报告、没有工具支持预检、没有 `temperature` 等参数透传。

网络层是整包读取，没有 SSE。因此“流式渲染”“首字节超时”“分块背压”“增量取消”都不适用；取消只能在中止前生效，`HttpURLConnection.disconnect()` 加线程中断。

## 10. 停止、暂停、重试与故障

- `stop(conversationId)`：见 §2.7。派生房间一起停，独立会话不受影响。
- `stopAll()`：所有会话（含旁观）置 `paused=1`、取消 inbox/runs/activities，abort 全部控制器。
- `resume(conversationId)`：清 `paused`/`autonomy_paused`，把最近一次“用户停止/全局停止”取消轮次的 inbox 恢复为 pending（更早的停止轮次标 skipped 替代），deferred 全部转 pending，failed/interrupted runs 标 cancelled，取消根 activity。
- `retry(conversationId)`：清 `paused`，deferred 转 pending，取消根 activity。
- `ignoreRecovery(conversationId)`：deferred 转 cancelled，failed/interrupted runs 标 cancelled。
- 后台：`appStateChange` 非 active 时对所有运行中的会话 `stop`。
- 进程重启：`interruptStaleRuns()` 把非终态 runs 标 `interrupted`，claimed inbox 标 deferred。
- 错误：网络/HTTP/协议错误使 run `failed`，inbox `deferred`，首页显示恢复卡片。没有自动重试、没有退避、没有 `outcome_unknown` 状态。

## 11. 已知限制

- 没有 triage、路由声明、唤醒合并上限、跨会话公平队列、并发信号量、provider cooldown。
- 没有 HELD 确认令牌机制，也没有“连续 HELD 次数”限制。
- 群规则是固定轮流，不是“模型自主决定是否发言”；这与原设计文档的协作目标不同，是用户确认的第一轮范围。
- 角色间会话依赖模型自觉调用 `message_send`/`turn_finish`，没有额外防互刷保护，只有 activity 预算兜底。
- `message_send` 到派生房间时不校验目标房间的 `cancel_epoch` 快照是否最新（用的是 `latestSequence` 作为 seenThrough），新鲜度检查在派生房间是关闭的（`freshnessThrough: null`）。
