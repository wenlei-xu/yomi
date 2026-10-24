# Agent 层修复记录

> 后续更新：独立暂存恢复、切库记录、旧库回退、存储维护及全量用量统计已接入，见[最新实现记录](10-STAGED-RESTORE-AND-MAINTENANCE.md)。历史快照中的对应缺口已过时；完整目标仍未全部验收。

> 当前实现更新见 [协作与数据可靠性更新](09-COLLABORATION-AND-DATA.md)。本文保留此前设计与实现快照；其中固定群轮、缺少 triage/角色模型/并发限制、明文备份及备份失败半清库的描述已过时。完整目标仍在推进，不能用历史 verified 直接宣称完成。

日期：2026-10-23。对应 [Cumora 对照审计](07-AGENT-CUMORA-AUDIT.md)。本记录更新 Agent 层状态，不把其他 App 功能的历史声明当作本次验收依据。

## 修复结果

| 审计项 | 修复 | 回归证据 |
| --- | --- | --- |
| A01 私聊不运行 | agent_direct/agent_group 从其 Agent inbox 调度；公开回复和派生私聊分别计额度，默认 message_send 明确发当前会话 | 私聊真实 drain 启动对方并自然结束；公开/私聊分别落库 |
| A02 同轮可见性 | runs.round_message_id 标记归属；历史读取由固定起点与本轮回复组成，不再用一个递增上界表达两件事 | 实际群调度中穿插第二条用户消息；Beta 看见 A-ONE，看不见 ROUND TWO |
| A03 记忆删除越权 | 删除事务同时校验当前 Agent ID 与 origin，禁止删除其他角色或人工记忆 | 两种越权均拒绝，记录保留 |
| A04 停止屏障 | 所有工具通过同一个事务入口核验 run、profileVersion、会话epoch、暂停、成员和activity；摘要共享 run AbortController，保存前再检查版本 | 停止后旧写工具均被拒；停止能取消正在等待的摘要请求 |
| A05 归档后旧回复 | 工具事务检查 enabled/archived/profileVersion；角色资料更新使旧摘要失效 | 归档/停用后旧发言与记忆写入均被拒 |
| A06 搜索越界 | 搜索和读取共用 agentMessages 的轮次/成员加入范围，返回明确 messageId | 下一轮内容不出现在搜索/读取/初始上下文 |
| A07 摘要覆盖错误 | 分批增量摘要，实际选中最后一条的sequence才是覆盖上界；保留前次摘要；新增消息不再更改破坏性contentRevision；保存时验证当前版本与epoch | 450条记录首次实际覆盖400、第二次覆盖426；追加后仍可用、删除后失效 |
| A08 HELD无法恢复 | HELD展示内容、显式读取的实际范围返回seenThrough，运行时在结果进入模型后更新；按本轮可见消息检查peer | HELD后读到新消息并能提交修订回复 |
| A09 工具不幂等 | runId+callId 作为统一幂等键，参数hash冲突拒绝；副作用和结果同事务；群title生效 | 同调用重复写记忆、toggle反应、建群均只生效一次 |

工具授权与幂等在 `Repository.agentTool` 内完成。内部 Repository 复用当前 SQLite 事务，不递归开启事务。缓存不保存读取工具输出；含 HELD 消息增量的结果不存入通用幂等缓存。

## 额外修复

- 全局最多4个模型请求、每连接最多2个；连接测试和摘要也经过同一请求gate，排队期间可取消。
- activity 模型调用在启动前原子预留，摘要也计入64次上限；24次工具限制在每个调用前检查。
- 主上下文与摘要均检查配置的contextTokens，保守估算混合文本token，超预算有明确错误；按完整消息裁剪，不截断工具call/output对。历史取样明确标注为有界历史。
- 退后台即时阻断调度，并取消运行中和已排队会话；回前台不自动唤醒。调度期间的新唤醒记录rerun，避免取消后立即继续丢唤醒。
- 工具参数在宿主端执行JSON Schema子集校验，拒绝null/数组、未知字段、超长文本、非法数字和数组长度。
- 读取与搜索结果提供messageId；新加入角色不读取加入前历史。
- 连接测试升级为无副作用探针：工具调用参数正确，并且模型能收到工具结果后返回验证标记。只会文本的连接会明确失败。
- 不完整Responses状态或Chat Completions截断结果不执行工具。
- 原生请求在进入executor前登记；cancel可标记未启动请求，并记录提前到达的取消标记；预先取消的JS请求直接拒绝。原生线程池固定4个线程。

## 数据升级

- schemaVersion 2 → 3，为runs补round_message_id，不清空角色、聊天或记忆。
- 首次升级使旧摘要失效，避免继续使用此前错误覆盖位置；原始消息保留。
- 新增消息只推进sequence与更新时间；删除、成员变化等破坏性更改仍推进contentRevision并让旧摘要失效。
- 备份仍为版本2：未导出runs，因此无需改变备份格式。
- 已在现有模拟器数据库验证升级，schema_migrations同时保留2和3、runs具有新增列，PRAGMA integrity_check返回ok。

## 验证与限制

执行 `npm run test:agent`，使用实际Database串行事务、Repository SQL、Runtime调度与模型协议；模型网络由本地fetch替身接管，不联系外部端点。共18项关键检查通过，涵盖两种协议完整工具循环、跨轮输入、工具权限/幂等/取消、摘要、预算与后台；额外确认同批次的读取结果不会让模型尚未见过的新内容提前通过提交检查。结果记录在 `08-AGENT-REGRESSION-RESULTS.json`。

`npm run typecheck`、`npm run android`通过，新的debug APK已安装到emulator-5554并启动，v2→v3数据库升级通过。

这次保持现有四导航UI与群聊顺序发言策略。Cumora的语义路由、triage自主沉默、每角色模型覆盖、SSE内部流、向量记忆等架构差异，不因这次修复就宣称已经等价。真实提供方工具表现和Android真机取消时序未做外部实测；本次不使用模拟结果冒充这些验证。
