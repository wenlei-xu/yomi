# Yomi 数据与存储 v1.1

> 本轮功能更新：世界书、生图/语音/表情包和酒馆角色卡导入已实现，见 [功能、兼容范围与数据保留](13-WORLDBOOK-MEDIA-CHARACTER-CARDS.md)。下文旧版“暂无世界书/多媒体”约束已由本轮用户要求更新。

> 后续更新：独立暂存恢复、切库记录、旧库回退、存储维护及全量用量统计已接入，见[最新实现记录](10-STAGED-RESTORE-AND-MAINTENANCE.md)。历史快照中的对应缺口已过时；完整目标仍未全部验收。

> 当前实现更新见 [协作与数据可靠性更新](09-COLLABORATION-AND-DATA.md)。本文保留此前设计与实现快照；其中固定群轮、缺少 triage/角色模型/并发限制、明文备份及备份失败半清库的描述已过时。完整目标仍在推进，不能用历史 verified 直接宣称完成。

日期：2026-10-23（v1.1 修订）。状态：**Android v1 已实现**。schema 版本 2。关联：[总体架构](01-ARCHITECTURE.md)、[运行机制](03-AGENT-RUNTIME.md)。

## 1. 单一数据源与实现约定

一个设备一个活动数据集：SQLite 数据库名 `yomi`（Capacitor SQLite，未加密），加角色头像 data URL（存在 `actors.avatar_data`，没有独立资产目录）。原生 SharedPreferences 只存 Keystore 加密后的凭证容器，`yomi_secure_vault`。内存保存运行中的协调状态（`runs`、`controllers`、`conversationQueues`）。

实际约定：

- ID 为应用生成的 UUID 字符串（`crypto.randomUUID()`）。
- 时间是 UTC 毫秒 INTEGER；排序与边界用 `messages.sequence`，不靠时间。
- 布尔 INTEGER 0/1；枚举列用 CHECK（`kind`、`protocol`、`purpose`、`origin`、`status`）。
- JSON 只用于 `result_json`（工具动作结果）和 `app_settings.value`；没有其他任意 JSON 列。
- SQL 全部参数化；备份导入时列名用 `/^[a-z_]+$/` 白名单过滤。
- `messages.sequence` 只增长，删除消息保留墓碑并清空正文，不复用序号。
- `PRAGMA foreign_keys=ON` 在 `open()` 末尾执行；SQLite 插件默认开启 WAL。
- 单连接由一个 Promise 队列拥有；`Database.write()` 用 `BEGIN IMMEDIATE` 语义（插件 `beginTransaction`），事务内语句通过 Proxy 关闭插件默认的逐语句自动事务。
- `schemaVersion = 2`，`schema_migrations` 记录 `('yomi-v2')`。

与原设计的差异：没有 `datasetId` 数据库命名、没有原生 manifest、没有 `domain_events`、`event_recipients`、`agent_progress`、`runtime_leases`、`scheduled_jobs`、`routing_claims`、`provider_cooldowns`、`run_events`、`memory_sources`、`summary_sources`、`provider_capabilities`、`assets`、`asset_refs`、`conversation_preferences`、`user_profile`。这些表的职责由现有列或省略来承担。

## 2. 实际表结构（schema v2）

```sql
schema_migrations(version, checksum, applied_at)
providers(id, name, protocol, base_url, credential_ref, credential_state,
          enabled, config_version, created_at, updated_at)
model_bindings(id, provider_id REFERENCES providers ON DELETE SET NULL,
               model_id, context_tokens, output_tokens, purpose, revision)
actors(id, kind, name, color, bio, persona, speaking_style, avatar_data,
       enabled, archived, profile_version, allow_private, allow_group,
       created_at, updated_at)
conversations(id, kind, title, topic, direct_key UNIQUE,
              origin_conversation_id REFERENCES conversations ON DELETE SET NULL,
              next_sequence, content_revision, membership_version, cancel_epoch,
              pinned, muted, hidden, paused, autonomy_paused, created_at, updated_at)
conversation_members(conversation_id, actor_id, ordinal, joined_sequence,
                     left_sequence, PRIMARY KEY(conversation_id, actor_id))
user_reads(conversation_id PRIMARY KEY, through_sequence, updated_at)
messages(id, conversation_id, author_id, author_name, author_kind, body, sequence,
         quoted_id, request_id UNIQUE, activity_id, origin_run_id, deleted, created_at,
         UNIQUE(conversation_id, sequence))
message_mentions(message_id, target_actor_id, PRIMARY KEY(message_id, target_actor_id))
reactions(message_id, actor_id, emoji, created_at,
          PRIMARY KEY(message_id, actor_id, emoji))
composer_drafts(conversation_id PRIMARY KEY, body, quoted_id, updated_at)
command_receipts(command_id PRIMARY KEY, command_kind, result_id, created_at)
inbox_events(id UNIQUE, agent_id, conversation_id, message_id, sequence, status,
             reason, updated_at, PRIMARY KEY(agent_id, message_id))
memories(id, agent_id, conversation_id, body, kind, about, pinned, origin,
         version, valid, created_at, updated_at)
summaries(id, agent_id, conversation_id, through_sequence, content_revision, body,
          valid, created_at, UNIQUE(agent_id, conversation_id, through_sequence))
activities(id, root_conversation_id, parent_activity_id, status, cancel_epoch,
           posts, model_calls, started_at, ended_at, updated_at)
runs(id, agent_id, conversation_id, activity_id, status, phase, reason,
     started_at, updated_at, ended_at)
model_calls(id, run_id, agent_id, provider_id, model_id, purpose, status,
            input_tokens, output_tokens, error_code, started_at, ended_at)
tool_actions(action_id PRIMARY KEY, run_id, tool_name, status, result_json, created_at)
app_settings(key PRIMARY KEY, value, updated_at)
```

索引：`messages_page(conversation_id, sequence DESC)`、`messages_search(conversation_id, deleted, created_at DESC)`、`inbox_pending(agent_id, status, sequence)`、`memories_agent(agent_id, pinned, updated_at DESC)`、`runs_active(status, conversation_id)`。

约束要点：

- `model_bindings.purpose` 是 UNIQUE，因此全局只有一个 main、一个 summary、一个 triage 绑定；角色级绑定未实现，所有角色共用 App 默认绑定。
- `conversations.direct_key` 唯一，保证 human-agent 单聊和 agent-agent 私聊各自只有一个会话。
- `conversation_members` 用主键保证同会话同 actor 一条记录；离开用 `left_sequence` 标记，不删行。
- `messages.author_id` 没有外键，删除角色时作者名快照仍可显示。
- `tool_actions.action_id` 主键即模型返回的 tool call id，提供同一次工具调用的幂等读回。

### 2.1 迁移机制

`Database.open()` 的顺序：取/建连接 → `open()` → `SELECT 1` → 探测并回滚残留事务 → `migrateExistingTables()` 对既有表按 `PRAGMA table_info` 补列 → 执行完整 schema（`CREATE TABLE IF NOT EXISTS`）→ 写 `schema_migrations` → 把旧版可能写入的 `credential_ref` 一律清空为 `missing`。

补列清单见 `src/data/database.ts` 的 `additions`。这是“加列式”迁移，没有版本化迁移脚本、没有 checksum 校验、没有降级拒绝；旧 App 打开新库只会因缺列报错。

## 3. 消息与互动

`sendUserMessage` 在同一事务内：查命令回执 → 校验会话/暂停/成员/长度/引用 → 分配 `next_sequence` → 递增 `content_revision` → 插消息 → 插提及（正文含 `@名字` 或 UI 传入的 ID）→ 给除作者和本地用户外的每个成员插 `inbox_events` → 写 `command_receipts` → 删草稿。

`sendAgentMessage` 在同一事务内：读 `tool_actions` 幂等结果 → 校验 `cancel_epoch`、`paused`、成员、activity 预算（posts < 24）→ 新鲜度检查（`seenThrough` 之后是否有他人消息，有则 HELD）→ 近邻重复检查（与最近 8 条中他人正文完全相同则拒绝）→ 插消息 → 插 inbox → 递增 activity.posts → 写 `tool_actions`。

`turn_finish` 在用户参与的会话中被运行时拒绝（每个角色本轮必须发一条）；在角色间会话中允许结束。

分页：`listMessages(conversationId, before?, limit=50)`、`listMessagesThrough(through, limit)`、`messagesAround(messageId, radius=20)`。没有“缺口补读”逻辑，`loadNewer` 是直接重取最新 50 条合并。

删除：`deleteMessage` 把 `deleted=1`、`body=''`，删提及，取消该消息的 pending/claimed inbox，使该会话全部摘要 `valid=0`，递增 `content_revision` 和 `cancel_epoch`。`clearConversation` 删消息、草稿、摘要、会话级记忆并把已读归零。

## 4. 记忆与摘要

`memories`：`conversation_id` 为 NULL 表示该角色全局，非 NULL 表示会话范围。`origin` 区分 `human`（用户在“角色 → 记忆”创建）和 `agent`（`memory_write` 工具写入，只能写当前会话）。`memory_remove` 不能删 `origin='human'` 的记忆。

查询顺序是 `pinned DESC, updated_at DESC LIMIT 100`，上下文注入取前 12 条。关键词检索由工具侧在内存 `includes` 过滤，没有 SQL 级关键词查询。

`summaries`：按 `(agent_id, conversation_id)` 隔离，`through_sequence` 唯一。`compactIfNeeded` 在消息数 ≥ 80 且 `total-24 > 当前 through` 时，用 summary 绑定（缺省继承 main）对前 400 条生成最多 1200 字摘要。摘要成功才写库；失败只记录 `model_calls` 失败，原文仍是权威。任何删除/清空都会 `valid=0`。

没有 `memory_sources`/`summary_sources`，因此“来源消息删除使记忆失效”没有实现；删除消息只让摘要失效。

## 5. 搜索

全局搜索（用户）：`instr(lower(m.body), lower(?))>0`，跨所有会话，按 `created_at DESC LIMIT 100`，返回命中消息与所属会话标题。

Agent 搜索（工具）：同一 SQL，但先校验该 Agent 是会话成员，且只搜该会话，`LIMIT 30`。

没有 FTS5、没有分词、没有中文索引；`instr` 是大小写折叠后的子串匹配。SQLite 的 `lower()` 只折叠 ASCII，中日韩与 emoji 靠精确子串匹配。

## 6. 备份与恢复

`exportBackup()` 在只读事务中导出 12 张表为 JSON：`providers`（`credential_state` 强制为 `missing`）、`model_bindings`、`actors`、`conversations`、`conversation_members`、`user_reads`、`messages`、`message_mentions`、`reactions`、`memories`、`summaries`、`composer_drafts`。格式头 `{format:'yomi-backup', version:2, exportedAt}`。不导出 inbox、runs、activities、model_calls、tool_actions、app_settings、schema_migrations。

`importBackup()` 校验 `format` 和 `version`，然后在单个写事务里按固定顺序 `DELETE FROM` 全部 19 张表，再逐行插入（列名白名单过滤，providers 强制凭证缺失），最后 `ensureLocalUser()`。

已知缺口：

- 明文 JSON，没有加密容器、没有密码、没有 AEAD。
- 整库替换，不是 staging 导入 + manifest 原子切换；中途失败会留下半清空的库（没有 journal 回退）。
- 导入不校验外键、序号连续性、成员关系和资产 hash。
- 备份写 `Directory.Documents`，文件名 `yomi-backup-<ISO>.json`；导入用 `<input type="file">` 读文本，大文件受 WebView 内存限制。
- 恢复后所有连接凭证为 `missing`，用户必须重填 Key；不会自动发任何模型请求。

其他导出：`exportConversation` 产出 `yomi-conversation` v1 JSON 或 Markdown；`exportAgent` 产出 `yomi-character` v1 JSON，只含 name/bio/persona/speakingStyle/color/avatarData，不含记忆、历史或连接。

## 7. 用量与运行记录

`model_calls` 记录每次主模型与摘要调用：`purpose` 为 `main` 或 `summary`，`input_tokens`/`output_tokens` 在服务端未返回时存 NULL（界面显示“部分用量未知”）。`runs` 记录每个 Agent 每次执行的状态与原因，`listRuntimeIssues()` 取每个会话最新的 `failed`/`interrupted` run 用于首页恢复卡片。`tool_actions` 记录工具调用的终态与 `messageId`。

没有保留期清理、没有 `run_events`、没有诊断导出。

## 8. 存储不变量（实现态）

1. 成功消息一定有唯一 `(conversation_id, sequence)`、作者快照和 inbox 事件；UI 提示成功前已提交。
2. 同一 `command_id` 或 `action_id` 至多产生一次本地业务效果；`sendUser` 目前每次生成新 commandId，所以幂等只对重放同一 ID 的场景生效。
3. `cancel_epoch` 递增后，旧 run 的 `message_send` 会因 epoch 不匹配被拒。
4. `user_reads.through_sequence`、`inbox_events.status`、run 内 `through` 三者互不推导。
5. Agent 侧读取（`listMessagesThrough`、`searchMessagesForAgent`、`conversationMembersForAgent`）都先校验成员资格。
6. 删除过的正文不会被摘要恢复：删除时摘要 `valid=0`；但 `messages.body` 已清空，迟到响应也无法写回。
7. 恢复不清除 `runs`/`activities` 旧数据，只重置 inbox 与运行态；导入后没有自动模型调用。
8. 备份不含凭证；`credential_ref` 在 `open()` 时被强制清空。
