# Yomi 决策、默认值与技术依据 v1.1

> 本轮功能更新：世界书、生图/语音/表情包和酒馆角色卡导入已实现，见 [功能、兼容范围与数据保留](13-WORLDBOOK-MEDIA-CHARACTER-CARDS.md)。下文旧版“暂无世界书/多媒体”约束已由本轮用户要求更新。

> 后续更新：独立暂存恢复、切库记录、旧库回退、存储维护及全量用量统计已接入，见[最新实现记录](10-STAGED-RESTORE-AND-MAINTENANCE.md)。历史快照中的对应缺口已过时；完整目标仍未全部验收。

> 当前实现更新见 [协作与数据可靠性更新](09-COLLABORATION-AND-DATA.md)。本文保留此前设计与实现快照；其中固定群轮、缺少 triage/角色模型/并发限制、明文备份及备份失败半清库的描述已过时。完整目标仍在推进，不能用历史 verified 直接宣称完成。

日期：2026-10-23（v1.1 修订）。此文件区分用户已确认事项、实现期决策和未来事项。实现期的取舍不是用户原话，标注为“实现期决策”。

## 1. 用户已确认的产品约束

| 决策 | 来源与结论 |
| --- | --- |
| 独立 App | 用户要求参考 Cumora 多 Agent 架构，重新写自己的 App，暂名 yomi |
| 一次性重写 | 用户设置 goal 后要求全量实现整个 App，不因预算中途停止 |
| 混合移动方案 | Android 优先，未来可能 iOS；不因“重写”改回纯 Java 原生 UI |
| 本地优先 | 聊天存手机、手机直接调模型；SQLite，不依赖 PG/Redis 服务 |
| 第一轮简单群规则 | 用户确认群聊第一轮用点名/顺序各回复一次、后发言可见前文、停止取消剩余、重启保留历史由用户决定重试 |
| 内置聊天工具 | 读/搜聊天、消息/表情/私聊/群互动、记忆、发言协调；不做工作型工具 |
| 不要旧接口适配层 | 重写业务底层；新项目不模拟 Cumora HTTP/WS/CLI |
| 保留聊天使用习惯 | 用户曾明确反对擅自大改原 UI；新工程先保留认可的四入口和交互结构，不拿“独立”当无约束改版授权 |
| 暂无资料库 | 用户明确说资料库暂时不要；交付等办公功能此前也排除 |
| 暂无向量/剧情 | 默认不做向量记忆、不调用 embedding；剧情状态暂不做 |
| 完整交付 | 后续目标内做完已定义 App 范围，不把 demo 或某一页完成当整体完成 |

## 2. 实现期决策与默认值

以下是为使实现可完成而确定的选择，多数与原设计不同；标注“偏离”的条目表示原设计写了但本版没做。

| 决策 | 实现选择 | 与原设计的关系 |
| --- | --- | --- |
| 工程形态 | 单个 Vite 应用，不是 npm workspace monorepo | 偏离：减少搭建成本，模块边界靠目录与 import 约束 |
| 页面状态 | React 局部 state + ersion 计数器 | 偏离：没有 Zustand，没有查询缓存 |
| 群聊规则 | 点名/顺序各回复一次，后发言重取边界 | 用户确认的第一轮规则，取代 triage/自主协作 |
| 角色模型绑定 | 全局唯一 main/summary 绑定，角色不单独绑 | 偏离：model_bindings.purpose UNIQUE |
| 并发 | 无信号量，同 Agent 串行，不同 Agent 由调度自然并发 | 偏离：没有主 2/辅 2/网络 4 的限额 |
| 模型响应 | 原生整包读取，非流式 | 偏离：无 SSE、无分块、无背压 |
| 预算 | run 12 hops/24 tools/用户会话 1 条/角色间 4 条；activity 24 posts/64 calls/180s | 与原设计一致，但 run posts 在用户会话收紧为 1 |
| 记忆 | 文字记忆，会话/全局范围，置顶+近期前 12 条 | 与原设计一致；无 memory_sources 失效链 |
| 备份 | 明文 JSON，12 张表，整库替换 | 偏离：无加密容器、无 staging journal |
| 数据库加密 | 不启用 SQLCipher | 与原设计一致 |
| 分发 | Android APK，debug 签名 | 偏离原设计的 release 可复现要求 |
| 语言 | 中文硬编码在组件里 | 偏离：未做资源化，无 i18n 键值 |

## 3. 关键取舍与替代方案

### D01 独立工程，而不是在 Cumora 上继续加分支

理由：办公/云端/配对模型与本地角色聊天差异大。独立数据模型减少被原源代码结构绑住。代价是需要重做 UI、持久化与验收，不能直接继承原项目的成熟度。

替代：继续 fork 可更快，但不符合用户当前明确选择。本设计保留原型作参考，不删除或迁移其现有数据。

### D02 SQLite + 内存，而不是“所有东西塞 SQLite”或“全内存”

事实、幂等、预算、恢复状态必须持久；typing、seen、HELD、steer、运行对象可重建。短事务保证消息与事件/工具结果一致，内存减少高频协调磁盘写。代价是需要明确恢复与 epoch 协议，不能恢复旧临时令牌。

### D03 一个 Runtime owner，而不是每页一个实例

切页面不影响调度；原生回调与数据库由唯一 owner 负责。跨 run/进程依靠 fencing 和 epoch，不能仅用 boolean busy。未来后台宿主只有在设计原子接管后才加入，v1 不预建第二套调度器。

### D04 标准工具循环，而不是 shell/CLI

聊天工具全部为结构化宿主动作，权限和本地幂等可证明。代价是模型必须有实际工具能力，兼容检测成为必要入口。不会为了“尽量兼容所有模型”偷偷把最终文本当发言成功。

### D05 文字记忆，而不是隐含向量依赖

置顶+近期+关键词满足当前需求，零 embedding。以后需要相关性召回时在记忆 Module 内做有版本扩展，不影响消息事实和当前调用默认。

### D06 前台有界互动，而不是假装等价云端常驻

Android/iOS 生命周期限制是真实平台约束，后台暂停能给出一致解释。代价是切后台可能中断当前回复，用户回前台手动继续；这属于明确产品行为，不是藏起来的缺陷。

### D07 备份导入：原设计要 staging，本版直接替换

原设计要求先导入 staging 库、校验、切 manifest，失败可回退。本版没有实现：importBackup 在当前库上单事务全表删除后逐行插入。代价是导入期间崩溃会留下半清空数据库，且没有回退路径。这是已知限制，不是设计选择。

### D08 行为与机制分别验收

确定性模型可证明事务、取消和调度，不证明真实聊天质量；真实模型可以体现质量，却不能代替竞争故障测试。两类都必须记录，单次 demo 不作为完成标准。

## 4. 参考 Cumora 的范围与注意事项

本地参考工程：`E:/douyin/cumora`；原始源码基线 `12084d3`。该目录有此前本地化改动，故对“原版”的判断应使用 Git 原版文件，不能把改造后的 shared/agent-core 当作上游实现。

值得参考的原始位置：

| 原始源码/文档 | 借鉴问题，不直接作为新工程依赖 |
| --- | --- |
| server/src/agents/scheduler.ts、runtime/pod-agent.ts | 唤醒、每 Agent 串行、pending 合并和收件箱补偿 |
| server/src/agents/triage-core.ts、inbox-triage.ts | 人工输入优先、纯 Agent 循环抑制、辅助判断失败模式 |
| server/src/agents/steer.ts、turn.ts | 安全 hop 边界注入与工具调用/结果配对 |
| server/src/agents/seen-boundary.ts、cli.ts | 已见与已处理分离、HELD、事务内重复检查与短期确认 |
| server/src/agents/turn-compaction.ts、memory-scope.ts | 上下文压缩与记忆来源，不照搬项目作用域 |
| server/src/realtime-outbox.ts | 可靠投递、提交后通知与至少一次消费 |
| src/mobile/MobileWhispers.tsx、MobileTabBar.tsx | 私聊旁观与导航含义 |
| docs/COORDINATION.md | 竞态与模型误判的区别；包含历史 BYOA 参数，不作为当前移动端配置真源 |

本设计不追求 source-level parity。尤其不搬运工作任务 claim、电脑宿主、bash/CLI、云认证、多租户、常驻 Pod 和工作 scanner。HELD 等机制按实际目的重新定义为本地可靠协议。

既有本地原型暴露过的 SQLite reload/原生事务锁、历史缺口补读、原生流跨字节/取消、凭证桥接日志问题，是需要在 Yomi 重复验证的风险清单，不是可无条件复制的实现。

## 5. 官方技术依据

以下资料于 2026-10-23 检索，用于核实平台和协议能力；设计中的并发数、表结构、预算与产品行为是 Yomi 自己的选择，不是官方推荐值。版本、商店政策和提供方模型能力仍需在开工/发行时核验。

- [Capacitor App：生命周期事件](https://capacitorjs.com/docs/apis/app)：将前后台/恢复事件送进唯一应用 owner；事件本身不提供常驻执行保证。
- [Capacitor Community SQLite](https://github.com/capacitor-community/sqlite)：候选原生 SQLite 插件；必须独立验证版本、事务和双端行为，不能仅凭有插件就认为数据库可靠。
- [SQLite transaction](https://sqlite.org/lang_transaction.html)：事务/单写者约束，采用短事务和连接所有权。
- [SQLite WAL](https://sqlite.org/wal.html)、[foreign keys](https://sqlite.org/foreignkeys.html)：WAL/外键设置与一致性导出需实测配置。
- [SQLite FTS5](https://sqlite.org/fts5.html)：trigram 可作为子串检索优化，短词和可用能力必须有正确性回退。
- [Android processes and app lifecycle](https://developer.android.com/guide/components/activities/process-lifecycle)：应用不能直接控制进程寿命，后台可能被终止。
- [Apple extending background execution](https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time)：后台执行受系统限制，不能把 WebView 定时器当永久后台调度。
- [Android Keystore](https://developer.android.com/privacy-and-security/keystore)：用系统管理的密码密钥保护凭证；API Key 本身存加密容器，不把普通字符串当 Keystore 密钥条目。
- [Apple Keychain services](https://developer.apple.com/documentation/security/keychain-services)：iOS 小型秘密存储；未来实现需验证可访问性/设备锁定策略，不默认同步 iCloud。
- [official OpenAI documentation：function calling](https://developers.openai.com/api/docs/guides/function-calling)：工具调用由宿主执行并逐 call_id 回填结果，协议/模型能力不能只依据“兼容”标签判断。

## 6. 实施风险登记与收口情况

| 风险 | 开工时要证明什么 | 不满足时的处理 |
| --- | --- | --- |
| SQLite 插件所有权与 reload | 已收口：单 Promise 队列 + Proxy 关掉逐语句自动事务 + 打开时探测回滚残留事务 | 不再处理 |
| 双端 SQLite 能力/补丁差异 | 未收口：未记录 Android 实际引擎版本与编译选项；搜索用 instr 回退路径，未启用 FTS | iOS 侧需重新核验 |
| 提供方“兼容”不完整 | 部分收口：mock 服务验证了工具调用与多步续传；真实服务商未验证 | 使用前先在“我 → 测试连接”确认；失败时按提示重试 |
| 多角色费用/节奏 | 部分收口：activity 预算覆盖派生房间；没有连接级节流与并发信号量 | 群成员过多时同时发起的请求数不受控 |
| 后台回调不及时 | 已收口：退后台即 stop 全部运行中会话；重启后 interrupted + 用户决定 | 不再处理 |
| 大备份/密码运算 | 未收口：备份是明文 JSON 全量文本，无密码、无分块、无 journal；导入直接覆盖 | 大库导入可能超内存，失败需从原文件重试 |
| 文字搜索中文短词 | 部分收口：instr(lower(...)) 对中文子串正确；未测十万消息规模，无取消 | 大数据量下延迟未测 |
| 删除的派生副本 | 部分收口：删除使摘要失效并清空正文；	ool_actions.result_json 只存 messageId 不存正文；但没有 memory_sources，来源记忆不会因消息删除失效 | 需补来源链 |
| 新代码可维护性 | 部分收口：UI 只走 AppApi；无自动化测试与依赖扫描 | 后续补类型外测试 |
| 缺真实凭证/设备/签名 | 已按约定处理：代码、构建、模拟器验证都完成，剩余项在 05 §4.2、§10 逐条列明 | 需用户提供真实 Key 与真机 |

## 7. 文档之间的解释顺序

用户后续明确指示优先。其后：本文件 §1 的确认约束 → 各专门文档的行为与数据契约 → 本文件 §2 的默认参数 → 示例接口和目录名称。出现真实冲突要修正文档并记录原因，不各自实现一份。

新功能/改变范围需同时更新需求矩阵与受影响的运行/数据/交互文档；性能调参只更新参数记录和测试基线。实现证据另写验证记录，不能把“计划实现”句子直接改成“已经完成”却不给测试结果。

实现已完成并记录在 05-DELIVERY.md。后续新增功能需同步更新本文 §1、§2 与受影响的运行/数据/交互文档，不能只改代码不改文档。
