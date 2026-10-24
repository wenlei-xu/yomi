# Yomi

> 记忆更新：摘要时间线、分段记录及按角色定向关联会话已实现，见[实现与验证](docs/16-SUMMARY-TIMELINE-AND-LINKED-MEMORY.md)。当前 1.0.2 / schema v13，需使用完整 APK 升级。

> 发布与更新：已有正式签名 APK、应用内更新入口、签名网页资源静默更新和启动回退，见 [独立分发与双通道更新](docs/15-DISTRIBUTION-AND-UPDATES.md)。本地生成发布文件不等于已上传 OSS。

> 聊天功能更新：消息编辑与历史版本、分支重新生成、撤回事件、Android/浏览器 SSE、多表情与分页筛选搜索已补充，见 [实现与验证](docs/14-CHAT-INTERACTIONS-AND-STREAMING.md)。该轮 schema 为 v12。

> 调度更新：自主限速、持久重试、停止/重启屏障及表情唤醒已补充，见[最新记录](docs/11-DURABLE-SCHEDULING.md)。原设计的其他未完成项继续保留。

> 后续更新：独立暂存恢复、切库记录、旧库回退、存储维护及全量用量统计已接入，见[最新实现记录](docs/10-STAGED-RESTORE-AND-MAINTENANCE.md)。历史快照中的对应缺口已过时；完整目标仍未全部验收。

> 最新协作与数据更新见[实现记录](docs/09-COLLABORATION-AND-DATA.md)。34 项关键回归通过，已有可安装 APK；完整 App 目标仍在推进，尚未宣称与 Cumora 全面对齐。

本地优先的多 Agent 角色聊天 App。Android 核心功能已实现，已产出 debug 与正式签名 APK，完整目标尚有未完成条目；iOS 只保留共用核心的设计，不在本版交付。

聊天事实保存在设备 SQLite，回复由用户自己配置的模型服务生成。没有账号体系、没有官方服务端、没有云端同步。界面沿用 Cumora 的四个底部入口与信息结构，品牌、数据模型和业务行为是 Yomi 自己的实现。

## 当前状态

| 项目 | 状态 |
| --- | --- |
| Android v1 代码 | 核心功能已实现，剩余项见最新记录 |
| 类型检查 | 通过（`npm run typecheck`） |
| debug APK | 已构建（`npm run android`） |
| 模拟器验收 | 已通过：四入口、建角色、单聊、三人群聊顺序发言、停止与重启恢复、Keystore 凭证、mock 模型的工具调用 |
| 真实外部模型 | 未验证，因为没有真实 API Key |
| iOS | 未交付，仅共用核心与 schema 的设计 |
| release 签名 | 已配置独立正式密钥；`npm run release` 生成并校验发布文件 |
| OSS 发布 | `npm run oss:configure` 配置本机凭据；`npm run release:upload` 校验并上传版本文件 |

## 快速开始

```powershell
npm install
npm run typecheck
npm run dev        # 浏览器开发宿主，5188 端口
npm run android    # vite build + cap sync + assembleDebug
```

APK 路径：`android/app/build/outputs/apk/debug/app-debug.apk`。debug 签名只用于本机测试，不要对外分发。

安装到已连接设备或模拟器：

```powershell
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## 首次使用

1. 打开 App，进"我" → "提供商"，选择文字、图片或语音，再点"添加提供商"。三类提供商分别管理。
2. 在"配置"页填写名称、API Base URL 和 API Key；文字接口支持 OpenAI Chat Completions 与 Responses。可在保存前点"测试连接"验证当前填写的地址和 Key。
3. 切到"模型"页，点"拉取模型"并勾选需要的模型；也可以手动添加模型 ID。点底部唯一的"保存"完成配置。
4. 回到"我" → "默认模型"，为文字、图片和语音选择已勾选的模型，选择后自动保存。上下文与输出上限可在"文字模型参数"中调整。
5. 到"角色"新建角色，点卡片进入单聊；或"建群"选多个角色进群聊。

Android 的 API Key 通过原生安全输入框录入，由 Android Keystore 加密存放，网页层不接收，数据库和备份都不保存明文。浏览器预览的 Key 仅在当前页面会话暂存，刷新后需重新输入。

群聊支持点名、语义选择主答或全员参与，角色可判断无需补充而保持沉默。后发言者能看到已完成回复，生成期间的补充在工具边界进入模型；停止取消相关因果链，重启后由用户决定是否重试。角色编辑页可分别覆盖主、辅助判断与摘要模型。

## 文档

| 文档 | 内容 |
| --- | --- |
| [总体架构](docs/01-ARCHITECTURE.md) | 已实现的技术选择、目录与模块职责、原生边界、生命周期 |
| [数据与存储](docs/02-DATA.md) | 当前 schema v6、事务协议、搜索、备份格式与已知缺口 |
| [多 Agent 运行机制](docs/03-AGENT-RUNTIME.md) | 群轮规则、inbox、工具循环、预算、HELD、停止恢复与限制 |
| [页面与交互](docs/04-PRODUCT-UX.md) | 四个入口的实际页面、控件与状态，以及与原始设计的差异 |
| [实施与验收](docs/05-DELIVERY.md) | Y-01 至 Y-50 逐条状态、验证证据、已知限制 |
| [决策与技术依据](docs/06-DECISIONS.md) | 实现期决策、偏离原设计的理由、后续工作 |

## 本版明确的边界

- 只用 SQLite，没有 PostgreSQL、Redis，也没有任何服务端组件。
- 没有向量记忆、不发 embedding 请求；记忆是角色私有的文字记录。
- 内置工具只服务聊天、记忆和角色互动，没有 shell、CLI、浏览器或工作型工具。
- 没有剧情状态机；世界书、图片生成、语音合成、消息编辑和分支重新生成已实现，具体兼容范围见最新实现记录。
- 主回复支持 SSE 生成预览，完整响应校验后执行工具；明确不支持流式的接口会回退。单次响应保留有界大小限制。
- 新备份使用密码加密，旧明文 JSON 仍可恢复。恢复有维护屏障、独立暂存库、事务校验、持久切换记录和旧库回退入口。
- Android 7.0（API 24）以上；iOS 需要单独的原生实现与验收。
