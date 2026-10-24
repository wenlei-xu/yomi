# 独立分发与双通道更新

实现日期：2026-10-24。发布入口为 https://stoneapi.me，不依赖应用商店或 GitHub 下载。

## 用户体验

- “我 → 应用更新”显示真实安装版本、检查更新、下载/取消/重试、安装及热更新状态。
- 自动检查可关闭。启动后每天至多自动检查一次 APK 版本，网络失败不阻止聊天。
- 自动检查开启时，页面更新在非计费 Wi-Fi 下静默检查和下载，不弹安装确认，不刷新正在使用的页面。准备好的资源在下次冷启动使用。
- 数据结构或原生功能更新走完整 APK；用户下载后进入系统安装界面。未允许 Yomi 安装应用时先打开系统授权设置，返回后再次点安装。
- 未发布/无权限/网络失败都有可读提示。服务端不接收聊天、角色或 API Key。

## 两条通道

### 完整 APK

固定版本信息地址：`https://stoneapi.me/releases/latest.json`。

元数据包含包名、版本、最低系统、下载 URL、大小、SHA-256、发布时间及更新说明。仅接受当前域名下 releases 目录的 HTTPS APK 地址，不跟随重定向。下载上限 200 MiB；文件进入私有缓存，取消和失败清除临时文件。重试重新下载，不声称支持断点续传或后台永不中断。

下载完成校验大小、SHA-256、包名、版本、系统兼容及与当前 App 一致的签名身份。安装前再次校验缓存文件，交给 Android 系统验证及安装。完整 APK 不做静默安装。

### 签名网页资源包

当前原生版本使用 `https://stoneapi.me/releases/latest-web-2.json`。不同原生版本使用不同入口。

资源描述由 APK 的正式发布私钥进行 SHA256withRSA 签名。原生端使用已安装 APK 签名证书的公钥验证，不信任描述内提供的密钥。资源包限定同一原生 versionCode 与数据库 schemaVersion；不用于新增 Java 插件、权限、原生依赖或数据库升级。

ZIP 下载限 20 MiB，解压限 80 MiB、2000 项，检查 SHA-256、目录越界和重复文件。通过后在 App 私有文件目录独立暂存。下次冷启动先持久记录候选版本再加载；本地数据初始化及 React 提交后确认启动。90 秒内没有确认会回退；进程在确认前退出，则下次启动回退并阻止重复安装同一失败版本。用户也可在设置中指定下次启动回退。

这保证启动失败的回退，不代表能自动识别每一个业务逻辑缺陷。发布前仍需验证兼容性；不允许热更新通过同 schema 编号偷改数据结构。

## 版本与正式签名

`version.json` 是 versionName、versionCode、webVersion、schemaVersion 的统一来源。当前 `1.0.1 / 2`，内置网页版本 1、数据库 schema 12。

正式密钥初始化命令：`npm run signing:init`。密钥及密码配置保存在仓库之外的 `E:\douyin\.local\yomi-signing`，Windows 下目录权限限定当前用户和 SYSTEM。已有密钥不会重新生成；残缺配置会停止而非换钥。

请把该私有目录备份到受保护的位置；上传文件中不含密钥。不支持随意替换发布签名。

旧 debug 测试包与正式签名不一致，不能直接覆盖。迁移时先导出加密备份，确认保存成功，再安装正式版本、恢复备份并重新录入必要的模型凭证。该步骤由用户操作，脚本不会卸载应用或清除数据。正式版后续通过同签名、更高 versionCode 正常覆盖升级。

## 发布操作

### 发布完整版本

1. 增加 `version.json` 中的 versionCode，更新 versionName；确认 schemaVersion 与代码一致。
2. 编辑 `release-notes.txt`。
3. 运行 `npm run release`，生成 release APK，使用 apksigner 校验，输出独立版本目录。
4. 运行 `npm run release:web`，生成对应原生版本的签名网页包。
5. 首次发布先运行 `npm run oss:configure` 配置 OSS RAM 用户凭据，然后运行 `npm run release:upload`。

### 发布无感更新

1. 只增加 webVersion；原生版本与数据库结构保持不变。
2. 验证变更后运行 `npm run release:web`。
3. 运行 `npm run release:upload`。

`npm run release:upload` 会先调用 `release:prepare-upload`，再次检查 APK 签名、文件 hash 以及网页描述签名和 APK 身份是否一致，再依次上传 APK、ZIP、网页描述及 `latest.json`。同名 APK/ZIP 已存在时只接受内容完全相同的对象；上传完成后会从 `stoneapi.me` 下载四个文件并核对大小与 SHA-256。

初次发布也可生成网页版本 1 的描述，供入口检查使用；App 内置同一版本时不会重复下载。

脚本拒绝覆写已生成的版本目录，防止同一个不可变 URL 被不同文件替换。Windows 需要 Java 21、Android SDK 与 ANDROID_HOME；必要时先配置 JAVA_HOME。

## OSS 设置

目标 Bucket：`yomi-xu`，中国香港，域名 `stoneapi.me`。

- 保持 Bucket 私有，只把已发布 APK、ZIP 和对应 JSON 对象设为公共读。不要开放公共写入。
- JSON：`Content-Type: application/json`，`Cache-Control: no-cache, max-age=0, must-revalidate`。
- APK：`Content-Type: application/vnd.android.package-archive`；ZIP：`application/zip`。
- 版本化 APK/ZIP 可以设置 `Cache-Control: public, max-age=31536000, immutable`。
- 先上传安装包/资源包，后上传指向它们的 JSON。不要直接上传整个项目、签名目录或包含私有文件的父目录。
- 上传工具使用 OSS Node.js SDK 的 V4 签名。RAM 用户只需对 `yomi-xu/releases/*` 拥有 `oss:PutObject` 和 `oss:PutObjectAcl`；不要使用主账号 AccessKey，也不要授予公共写权限。
- RAM 授权可在“访问控制 RAM → 权限管理 → 权限策略 → 创建权限策略 → 脚本编辑”中导入 `scripts/oss-upload-policy.json`，再把策略授予专用 RAM 用户。
- `npm run oss:configure` 会通过隐藏输入读取 Secret，并用 Windows 当前用户 DPAPI 加密保存到 `%LOCALAPPDATA%\Yomi`。更换密钥时重新运行此命令。Secret 不写入项目或命令行参数。
- Android 原生更新请求不依赖浏览器 CORS。浏览器开发宿主检查更新可能需要单独配置 CORS。

## 验证入口

- `npm run test:updates`：元数据格式、可信地址、大小/hash、版本及系统条件。
- `scripts/check-updates-ui.cjs`：390×844 下检查、下载、权限设置返回、安装、页面同步和回退；AppApi/原生桥使用替身。
- `node scripts/prepare-update-tests.cjs` 后运行 `:app:connectedDebugAndroidTest` 并指定 `app.yomi.mobile.WebUpdatesTest`：Android 原生签名资源暂存、健康确认、失败启动回退、禁止重试坏版本、签名/ZIP篡改、越界ZIP、schema不兼容、用户回退。
- 既有 Agent、聊天、备份与角色卡回归仍保留。

尚未上传到 OSS 前，不把本地 APK 和签名资源包检查说成真实公网下载升级验收。各品牌真机的安装器、系统电源管理及真实断网场景仍需后续验证。

## 本次交付记录

- 已生成正式签名 APK：1.0.1 / versionCode 2，约 12.5 MiB；apksigner 验证通过，发布密钥 RSA 3072。
- 已生成签名网页基线包：native 2 / web 1，约 334 KiB。描述签名使用 APK 内提取出的实际签名证书公钥复核通过。
- Android API 35 只读模拟器：5 项 WebUpdatesTest 通过；debug App 实际启动无启动失败，原生更新插件返回 1.0.1/2，设置中两个更新入口可见。测试结束关闭该只读模拟器，未改写原 AVD 数据。
- 发布元数据检查、两套手机尺寸 UI 交互检查、39 项 Agent 和消息回归通过。
- `npm run release:upload` 已加入可复用的 OSS 发布流程；当前工作区尚未配置 RAM Secret，因此还没有执行线上上传。
- 上传后仍需验收真实公网下载及正式版覆盖升级。
