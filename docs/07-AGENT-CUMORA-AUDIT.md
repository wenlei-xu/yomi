# Yomi 与 Cumora Agent 层对照审计

> 后续修复：本报告保留审计时的缺陷证据。A01–A09 已完成代码修复并通过行为回归；最新状态见[Agent 修复记录](08-AGENT-FIXES.md)，不要把下列历史缺陷当成当前状态。

审计日期：2026-10-23。结论：**当前 Yomi 是采用工具调用的多角色聊天实现，尚未完整重建 Cumora 的 Agent 协调机制，也没有达到原设计的功能完成状态。** APK 能启动、类型检查通过，不能证明协作层完成。

本次只添加审计报告与可复现脚本，不修改业务行为。README 与 docs/01–06 中此前的“已实现/verified”记录不能覆盖本报告发现的问题。

## 1. 基准与证据范围

- Yomi：当前 `src/agent`、`src/data`、`src/model`、`src/platform`、`src/app/bootstrap.ts`、Android `SecureVaultPlugin.java`。
- Cumora：本地已有上游提交 `12084d30343b37b9806ce6848b2d0ade09533b1e`（简称 `12084d3`），来自 `yetone/cumora`。全部上游结论通过 `git show 12084d3:<path>` 核对；不是声称 GitHub 最新版本。
- Cumora 工作目录含此前本地改造，`shared/agent-core` 是未跟踪的新增目录，**不能当成上游 Agent 实现**。本次没有改动 Cumora。
- 按用户要求，检查以源码和少量关键复现为主，不跑真实模型、真机或完整故障矩阵。
- `scripts/audit-agent.cjs` 编译当前 TS，调用实际 Repository SQL 和 Runtime 方法，在 Node 内存 SQLite 中复现 9 项问题。网络及原生桥接不在这个脚本的验证范围；没有对外模型请求，不修改用户数据库。
- 直接调用私有方法仅用于检查对应边界，不等同整机 E2E。例如“停止后写记忆”验证的是工具入口没有持久取消屏障，并不声称每次正常点击停止必然触发竞态。

复现命令（Node 22.19.0，使用内置 `node:sqlite`）：

```powershell
node scripts/audit-agent.cjs
npm run typecheck
```

脚本成功退出表示**复现到了现有缺陷**，不是修复回归通过。

## 2. 已复现的问题（按风险排序）

### A01 · P1：角色间私聊和角色小组没有接上执行入口

Yomi `runtime.ts:184` 的 `drainConversation` 无条件调用 `pendingHumanRound`；`repository.ts:1161` 只选 human 作者的 pending 消息。`agent_direct` 和 `agent_group` 不含 human，因此发给对方的 inbox 即使已落库，调度也立即返回。

复现：Alpha 给私聊发 `hello`，Beta 的 pending inbox 有记录；调用实际 drain 后启动次数为 0。不是“模型选择沉默”，是没有调用模型。点击继续依然经过同一入口。

另一个独立问题：普通聊天中 `postLimit=1`，发到派生私聊也计入 posts。如果角色先私聊就会消耗当前公开回复名额；发完公开回复则 run 退出，没有独立私聊阶段。

Cumora `private_chat.ts` 的 opening message 走正常消息事件；`runtime/pod-agent.ts` 的 drain 按 Agent 收件箱执行，没有必须先找到 human 消息的前提。`triage-core.ts` 对 agent↔agent DM 默认 engage，每 8 条检查一次是否陷入空转。

修复方向：按会话类型分发，人类轮次与 agent-only inbox 分开；公开回复和派生互动使用独立额度与因果标识。

### A02 · P1：连续用户输入时，后发言角色看不到已完成的同轮回复

位置：`runtime.ts:212`、`repository.ts:1175`。

复现序列：human FIRST #1 → Alpha 开始 → human SECOND #2 → Alpha 回复 #3。`pendingHumanRound` 为隔离下一轮而返回 `through=1`，Beta 因而无法读取 #3。上一轮补做的“每个角色轮到时刷新上界”仍不能解决这个顺序。

仅用一个 `sequence <= through` 无法同时表达“排除下一轮人类输入”与“包含发生在该输入之后的本轮角色回复”。应该使用 roundId/activityId + 显式消息集合，而不是继续调单一上界。

Cumora 是持续 inbox + steer + 提交前新鲜度协议，不采用 Yomi 这套 human-round 截止方式。因此这是 Yomi 轮次模型带来的问题，不是把云端换成 SQLite 的必然结果。

### A03 · P1：memory_remove 缺少角色归属校验

位置：`runtime.ts:573`、`repository.ts:924`。

工具调用把 memoryId 直接交给 `deleteMemory(id, false)`，SQL 只判断 origin 是否 human，没有 `agent_id=当前Agent`。复现：Alpha 提交已知的 Beta 自动记忆 ID，Beta 的记录被删除，工具还返回“已删除自己记录的记忆”。

这不是自动枚举漏洞：前提是获得目标 ID；但宿主仍必须拒绝跨角色删除，不能用 UUID 难猜代替权限。

Cumora 记忆读写按 Agent 的 workspace/身份定界，`runtime/inproc-client.ts` 读取记忆显式限制 `agent_id`。Yomi 需要在删除事务内同样绑定身份。

### A04 · P1：停止屏障没有覆盖全部有副作用工具

位置：`runtime.ts:560`、`:573`、`repository.ts:874`。

`message_send` 有 `cancel_epoch` 检查，`memory_write`、`memory_remove`、建房间、表情等工具没有统一的 run/epoch 授权检查。复现：先 stop 当前会话，再将旧执行上下文送入 `memory_write`，记忆依然入库。

正常路径有 AbortController 和工具前检查，可减少触发；但 stop 与异步数据库操作交错时，不能保证这些副作用被拒绝。应给每个写工具提供统一执行凭据，并在同一事务校验。

这条是 Yomi 自身停止语义的漏洞；本报告不把 Cumora 的云端停止行为推定成手机端“停止并手动恢复”的等价物。

### A05 · P1：停用或归档角色，旧 run 仍可发言

位置：`repository.ts:110`、`:510`。

`saveAgent` 改 enabled/archived 但不建立取消屏障；`sendAgentMessage` 只检查成员和会话 epoch，没有检查 enabled/archived/profileVersion。复现：角色停用并归档后，旧参数发言仍返回 `sent`。

Cumora 的身份检查依托活跃 participant、host 和成员资格；本地重写应把对应约束落实为本地身份版本及事务检查，而不只在调度起点过滤一次。

### A06 · P1：搜索绕过本轮可见范围

位置：`runtime.ts:460`、`repository.ts:768`。

`conversation_read` 受 seenThrough 限制，`conversation_search` 却查询会话所有匹配记录，不接收轮次边界。复现：context.seenThrough=1，仍搜出下一轮 #2 的 `FUTURE SECRET`。

如果保留严格轮次隔离，所有读取、摘要与搜索都必须使用同一可见范围。若恢复 Cumora 的实时 steer，则应明确允许新内容进入模型，不能一边宣称隔离、一边通过搜索泄漏。

### A07 · P1：长会话摘要声明的覆盖范围大于实际来源

位置：`runtime.ts:623`、`repository.ts:865`。

复现：450 条消息，摘要声明 through=426，实际来源受 `LIMIT 400` 限制，只含 #1–400。成功摘要会被标为覆盖 #426，后续上下文还会过滤 `sequence <= summary.throughSequence`。当该摘要被选中时，#401–426 既不在摘要来源，也不在原文中。用 count 推算 sequence 在清空后序号不重置的场景也不成立。

此外，摘要精确绑定 contentRevision，而每次追加消息都会递增 revision；摘要异步生成时很容易刚完成就失效，无法稳定续接。

Cumora `turn-compaction.ts` 按真实 history 项和 token 估算压缩，保留完整工具 call/output 组；不是“消息数量减24，再只取最早400条”。

### A08 · P2：HELD 后已见边界不推进，重读后仍可能一直被拦

位置：`runtime.ts:279`、`:454`、`:507`。

`through` 在整个 run 中固定；HELD 虽把新消息返回给模型，却不推进 seen，`conversation_read` 仍只读旧 through。复现：首次 send 得到 HELD，重读看不到新消息，换正文再次发送仍 HELD。

普通群聊把 freshnessThrough 设成 through，又会把这个新鲜度检查基本限制在旧快照内。即：一条路径挡不住新内容，另一条路径挡住后不能正确恢复。

Cumora `seen-boundary.ts` + `cli.ts` 在**内容实际展示**后单调推进 seen，HELD 凭据绑定所见 peer 序号；新 peer 到来才再次拦截。需要迁移的是这套状态语义，不一定是 Redis 或 CLI 接口。

### A09 · P2：除发送消息以外，工具副作用没有统一幂等

位置：`runtime.ts:560`、`repository.ts:874`、`:1590`。

同一 tool call id 两次调用 `memory_write` 会新增两条记录（已复现）。`tool_actions` 目前主要包住 `message_send`；反应采用 toggle，重复执行甚至会反向取消；group_create 会重复建群，且模型传来的 title 被忽略，实际标题由成员名拼成。

不能把“存在 tool_actions 表”当成所有工具幂等已实现。需要同一 run/callId 下原子记录结果并与副作用一起提交。Cumora 也不能被概括为所有工具天然 exactly-once；此项按 Yomi 自己的原始幂等设计判为缺失。

## 3. 额外静态问题（未做整机故障复现）

| 问题 | 代码证据与影响 |
| --- | --- |
| 摘要请求不受停止控制 | `runtime.ts:293` fire-and-forget；`:634` 新建 controller 不加入 controllers；停止主回复后摘要仍可能请求并记录用量；它的 runId 为空，也不计入 activity.model_calls |
| 24 tools 并非严格上限 | `runtime.ts:304` 只在 hop 外层检查 toolCount，`:357` 内层只是递增；一次响应返回超过24个调用，仍会继续执行整批 |
| 上下文设置未生效 | contextTokens 仅表单和数据库读写使用；runtime 没读它。36条×32KiB消息，加12条记忆和工具结果，可能超过配置窗口；没有按token裁剪 |
| 新鲜度和入群历史权限不统一 | listMessagesThrough 无身份/加入边界参数；Agent搜索只查活跃成员，不限制 joined_sequence。新增角色能读此前历史；是否允许应明确，不宜留下无效权限字段 |
| 暂停、后台与请求取消有空档 | appStateChange 仅停止 snapshot.running 中的会话，不拦350ms待启动队列；secureRequest 未检查 signal 已经 aborted；原生 cancel 若早于 activeRequests.put，取消可能落空 |
| 连接测试只测文本 | bootstrap.ts:217 请求明确“不要调用工具”，不能据此标定多步工具兼容。两个协议有编码/解析实现，但不代表所有供应商和模型都可用 |
| 工具数据缺少可操作ID | conversation_read/search 返回 #sequence + 作者正文，不给 messageId；message_react 与引用参数却要 messageId，模型无法可靠引用/反应该结果 |
| 工具输入只有形式schema | tools.ts 声明 JSON Schema，执行端未做统一运行时验证；parseJson 可返回 null/数组/数字；参数长度和未知字段不能完全依赖供应商执行schema |

## 4. 与 Cumora 的整体差异

以下 Cumora 指锁定的上游提交，不指“所有版本都如此”。

| 维度 | Cumora 上游 | Yomi 当前 | 性质 |
| --- | --- | --- | --- |
| 执行宿主 | scheduler + Pod/BYOA 等运行路径 | 手机进程内 TS runtime | 平台取舍，合理 |
| PG/Redis | PG持久数据；Redis wake/seen/hold/速率等协调 | SQLite持久数据；Map/队列即时协调 | 方向合理；部分语义未重建 |
| 工作入口 | 按 Agent drain inbox，busy 时 pendingRerun | 按会话找 human round，再逐角色执行 | 核心行为差异，导致A01 |
| 人类消息triage | human DM/group快速engage，群里最终仍可判断是否发言 | 无triage；human会话强制每个目标发一条 | 缺自主判断，非等价实现 |
| 无点名群消息 | 路由 each / one-of-us，支持主应答者选择与claims | 全员固定顺序 | 产品行为变化 |
| 角色间消息 | 默认响应、周期triage和循环保护 | 存inbox但常规入口不执行 | 功能断链 |
| 调度与限速 | wake扇出Semaphore、每Agent每分钟30次turn令牌、低优先级预算、持久重试 | 每Agent串行；无全局/每连接请求gate | 机制缺失；多群和摘要可能放大请求 |
| 处理中补充 | 有界steer队列，hop边界注入；有条数/字节/次数限制 | human路径查询<=through再过滤>through，无法注入更晚消息 | 声称steer与实际不符 |
| Seen / HELD | 实际呈现推进seen；hold token有TTL和peer高水位 | 单个固定through + held返回文本 | 未完成迁移 |
| 工具循环 | Responses内部流解析；完整call/output配对；最多200 hops | Responses/Chat Completions整包；12 hops；每人1条 | 手机预算可收紧，不能丢协调语义 |
| 用户可见回复 | 工具成功发布整条，不把内部推理作为气泡 | 同样通过message_send整条发布 | 基本思路一致；Cumora内部流≠UI逐字回复 |
| 协作工具 | dm_with/pull_group、状态与CLI/FS/工作工具等 | 11个聊天/记忆工具 | 移除工作型工具符合要求；聊天工具仍有缺口 |
| 角色模型 | persona model覆盖默认；辅助用途强制support model | 所有角色共享main；summary可继承main；purpose全局唯一 | 模型选择与费用控制退化 |
| 长上下文 | token估算 + usage触发压缩；保留成对工具历史 | 36条历史 + 异步前缀摘要 | 当前有A07；contextTokens无运行约束 |
| 文字记忆 | workspace文件式；project来源与scope；pinned语义 | SQLite记录式；conversation/global；pin不扩大scope | 有意重建，范围更适合本地角色聊天 |
| 向量记忆 | **有实现**：pgvector可用且query非空时用embedding；否则回退近期 | 无向量/embedding；置顶+近期+关键词 | 按用户要求暂缓；不能说原版没有 |
| 向量默认使用情况 | 取决于pgvector是否安装、Key与运行环境 | 确定不调用 | 代码可证明有路径，不能证明原主部署日常是否启用 |
| 后台 | 常驻云执行、空闲/扫描唤醒 | 前台执行、后台停、重启人工决定 | 手机产品取舍，合理；当前后台屏障仍不完整 |
| 错误与观测 | turn/LLM事件账本、流用量、分类错误、有限provider连接重试 | runs/model_calls；失败deferred；人工重试 | 有基础，但排障与重试能力较少 |

补充协议事实：上游 turn.ts 为 sub2api 兼容，**也有意不重放 reasoning/text items**，仅重建function_call再配对输出。因此不能把“Yomi未续传reasoning”单列成它相对这份Cumora基准的独有退化。是否需支持特定提供方的附件，应另做协议测试。

## 5. 文档结论需要纠正

1. docs/01–06被改写成了“现状”，但原始要求不能因此缩小。01 §1.1仍明确“自主判断与协作、不简化成固定轮询”，而03/06又称“固定轮询是最终用户确认”。这两者冲突；不能把实现期简化冒称已获得最终授权。
2. docs/05中Y-27全部工具、Y-28私聊、Y-33停止、Y-36生命周期等verified结论过宽；本次分别复现了权限、私聊断链、停止副作用及其他问题。
3. 此前说“备份失败会留下半清空数据库”也不准确：Database.write包住清空与插入且失败rollback；SQLite事务可以保证原库回滚。真正缺失的是更充分的预检、运行时维护屏障、加密及独立恢复方案；没有staging不等于事务内部分提交。本次不以错误描述作为继续改造依据。
4. Yomi目录无Git元数据，docs/01“原设计见git历史”不可依赖。本报告保留已知原设计约束，不能继续通过覆盖规格来宣称实现完成。

## 6. 修复顺序

1. **先补运行正确性**：agent-only inbox入口；显式轮次或真实steer；所有工具统一权限/取消/幂等；停用归档版本检查。
2. **再恢复协作语义**：把实际已见、已处理、用户已读分离；修HELD进度与搜索范围；补语义路由和合理沉默。是否保留临时简单群轮规则应如实标为产品策略，不能称完全复刻Cumora。
3. **补上下文与费用边界**：摘要真实覆盖位置、token预算、摘要取消与计费、统一请求gate、严格工具预算。
4. **最后更新验收状态**：以修复后的关键用例为证据，真实模型/真机按原指示不扩展成大矩阵。现有审计脚本届时应改为断言正确行为，不能保留“缺陷复现成功”当回归绿灯。

不需要恢复PG、Redis、Pod或CLI才能解决这些问题；需要在平台无关TS和SQLite事务里重写相应的协调规则。当前目标应保持未完成。
