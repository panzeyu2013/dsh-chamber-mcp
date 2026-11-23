# dsh-chamber-mcp

[![CI](https://github.com/panzeyu2013/dsh-chamber-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/panzeyu2013/dsh-chamber-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/panzeyu2013/dsh-chamber-mcp?display_name=tag)](https://github.com/panzeyu2013/dsh-chamber-mcp/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

**简体中文** ｜ [English](docs/README.en.md)

> **MCP 服务器，按工作区，从 dsh 设置界面管理。**
> 声明一次服务器（stdio 或 Streamable HTTP），再用开关决定 **哪些工作区** 的会话能看见它的工具。默认：一个都不给。

独立的第三方 [dsh](https://github.com/deepseek-ai/deepseek-harness) 插件，一次普通的 `dsh plugin` 安装——dsh-chamber 不预置、不捆绑、不特判。

## 为什么需要它

dsh 自带的 `@deepseek-ai/dsh-mcp-client` 负责把 MCP **桥**进模型；本插件不再自己维护连接层——**每个配置的服务器都以官方 `McpClientHost` 实例挂载**：一个按定义创建的隔离 seat fiber（隔离 `tools`/`systemPrompt`/`mcpResources`/`credentials`/`mcpClientHost`，装四个只捕获的 façade），连接、`${credential:…}` 模板、重连退避、世代切换、instructions 与资源 provider、OAuth 授权的读取/刷新/脱敏都归官方实例。本插件保留**按工作区注入的闸门**、设置界面、状态/动作路由、OAuth 授权动作与转录行。

Web 组合（`dsh-web-app`）自 0.2.2-rc.2 起还挂载官方的 `@deepseek-ai/dsh-mcp-manager`（0.2.3-alpha.2 的 Web 组合仍带 `mcp-manager` 行）——它管的是**宿主全局平面**：

- 官方 manager 的服务器对整个 Host 生效，一台启用后**每个**会话都背着它的全部 MCP 工具：既烧上下文，也可能误调；
- 官方 manager 覆盖 settings 增删改、`${credential:…}` 模板、状态/重启/探测，但**没有"工作区"这个维度**；
- `dsh-workspace` 只做项目分组、不注册任何工具——**上游仍然没有把"工作区"映射到"一组工具"的机制**。

本插件补的正是这个缺口：在官方桥接契约之上加一层**按工作区注入的能力门**，并把**管理面**（自己的设置分区：服务器列表 / 服务器详情 / 工作区视图）做在同一条插件里。同一个 Host 上两层可以并存：全局平面归官方 manager，工作区粒度归本插件。但同一个 `serverName` **不得**同时配在两层——官方 host 按应用根预留名字，本插件把重名映射为 **`failed{conflict}` 硬错误**（只读预检 + 挂载竞态代码兜底），不再是「两个互不相干的注册」。

## 核心优点

| 优点 | 具体表现 |
| --- | --- |
| **设置界面原生管理** | *设置 → MCP 服务器* 里增删改查，不碰 `cordis.patch.yml`；UI 写入提交到**正在运行**的插件上，只重启受影响的服务器，不重启实例 |
| **按工作区注入，默认全关** | 新服务器对**每个**工作区都是关的；新工作区、新会话不会凭空多出 MCP 工具。关掉某工作区 = 从该工作区会话的**工具表**里撤销 `mcp__<serverName>__*`——模型可见层面的变化，不只是执行时拦截 |
| **凭据引用，不是密钥** | 设置文档里只有 `${credential:REF}` 模板字符串（连接时由挂载的官方实例解析，值从不回写）；值存在 dsh 凭据域、**只写不可读**，永远不出现在设置文档、API 响应或日志行里 |
| **MCP 专用转录行** | 调用渲染为插件通过 keyed `tool.call.toolview` 槽注册的 MCP 行：插头标记、`server · tool` 标题、传输标签、运行/成功/失败/中断状态，可展开参数与结果——而不是官方通用卡片 |
| **官方连接层** | 连接、`${credential:…}` 模板、500ms→30s 退避重连、`tools/list_changed` 世代切换、`instructions` 提示段与 `mcpResources` provider **全部由挂载的官方 `McpClientHost` 实例执行**；本插件只做只捕获 façade 与按 agent 回放，命名/结果/图像映射不再自己实现 |
| **按需工具加载** | 每台服务器可选 `toolLoading: on-demand`：模型工具表里只出现加载器 `mcp__<serverName>__load_tools`，目录（catalog）由官方实例渲染；工具被加载时才进入该 agent 的 scope（仍受工作区闸门与子代理 `toolFilter` 约束，可撤销），大服务器不再一次性占满工具表 |
| **OAuth 浏览器授权** | HTTP 服务器可启用官方浏览器授权流程（OAuth O2）：PKCE/DCR/回调由官方 flow 负责，授权记录存凭据域、key 由服务器名派生且界面不显示；详情页提供授权/取消授权/退出登录、五种授权原因提示与可复制的授权链接。仅在本声明线可用，且需要浏览器能直达宿主 origin |
| **手改与 UI 分工清晰** | UI 写入 = 实时、叶子级 YAML diff（注释/锚点/格式保留）；手改补丁行 = 下次启动生效，loader 先校验再运行 |

## 30 秒上手

前置：一个受支持代际的 dsh 实例；`dsh` 在 PATH 上；Node ≥ 24 与 pnpm（`dsh plugin` 的安装工具链，不是插件的运行时要求——插件由 dsh 宿主加载）。

```sh
# 从 GitHub Release 资产安装（npm 发布暂时关闭；<version> 见 Releases 页）
dsh plugin --profile web add \
  https://github.com/panzeyu2013/dsh-chamber-mcp/releases/download/v<version>/dsh-chamber-mcp-<version>.tgz

# 或本地打包安装
npm run pack:tgz
dsh plugin --profile web add file:./.smoke/dsh-chamber-mcp-<version>.tgz

# 装完重启一次实例（profile 的 bundle 列表变了）
```

1. 打开 *设置 → MCP 服务器* → **添加服务器**，或从空状态直接 **从剪贴板导入**。两种传输：**stdio**（名称、命令、参数、可选工作目录、环境变量键）与 **Streamable HTTP**（URL、请求头行）。编辑器支持整条命令行 / `.env` / 请求头行粘贴，以及单服务器或多服务器 JSON（多服务器时先选一个）；保存后自动测试连接。
2. 列表行只显示**状态、范围与工具数**。点一行进入详情：**Workspaces** 区块逐个开关这台服务器的工作区（改动立即生效，可撤销），**Availability** 的 **允许运行** 才是全局开关（不允许 = 不启动、哪里都不注册工具，配置留在盘上）。新服务器默认**对每个工作区都是关的**。
3. 页签 **Workspaces** 反过来回答"这个 workspace 能用哪些服务器"，支持跨服务器批量开启/关闭。详情还包含 **Tools**（搜索、复制）、**Configuration**（定义与凭据引用、复制 JSON）、实时状态 / 诊断、以及 **Danger zone** 的移除（会具体列出受影响的 workspace 和将被清理的凭据）。列表支持名称过滤和状态筛选。

## 一次会话能拿到什么

| 会话 | 拿到 MCP 工具？ |
| --- | --- |
| 工作区根会话，且该工作区对这台的开关为开 | 是——`mcp__<serverName>__<rawName>` |
| 服务器设为按需（on-demand） | 模型工具表里只有 `mcp__<serverName>__load_tools`；工具在模型加载后才进入该 agent 的 scope |
| 工作区根会话，但开关是关 | 否——定义被从该 agent 的 scope 撤销 |
| cwd 不在任何已注册工作区的会话 | 否 |
| 子代理 / 委派子会话 | 继承父会话的工作区（`continuable` 再受 `toolFilter` 收窄） |

- **工具就是请求里的普通 tool schema**：计入输入框旁上下文环的 **工具定义** 一项（上下文环只在模型报告过用量后显示）；服务器发布 `instructions` 时另加一段 `### MCP server: <name>` 提示段。
- **名字会归一化**：`mcp__<serverName>__<rawName>` 裁到 ≤64 字符的 `[A-Za-z0-9_-]`；有损归一化时追加 12 位 SHA-256 身份后缀，两个不同 MCP 工具永远不会塌成同一个名字；`tools/call` 里发的是原始 MCP 名。
- **列表有界**：官方 `listMaxPages`(64) 负责翻页；插件对每台 eager 生成做 2000 工具的捕获上限——超限只截断并标记 `truncated`（不拒绝同步，seam canary 对该代豁免），按需模式不强制走该上限。调用默认 60s 超时，随 run 的 signal 中止。
- **按需模式**：目录文本由挂载的官方实例渲染；目录可能点名子代理 `toolFilter` 排除的工具（eager fan-out 会被过滤、真正加载时 `admit()` 会拒绝，但目录文本是上游格式）。工具列表接口对按需服务器只返回 `mode: catalog` 与数量，不返回定义。

## 配置在哪里

配置就是插件自己的 Loader entry Config——profile 用户补丁 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里的一行：

```yaml
- id: mcp-scope
  name: dsh-chamber-mcp
  config:
    servers:                        # serverName 是身份
      - serverName: github
        transport: streamable-http  # 或 stdio：command/args/cwd/env
        url: https://mcp.example.com/x
        toolLoading: eager          # 或 on-demand（默认 eager）
        headers:
          Authorization: ${credential:GITHUB_TOKEN}   # 凭据模板；值只在凭据域
    overrides:                      # 存在 = 该工作区为开（默认关）
      ws-2f1c:
        github: true
```

- **服务器身份** = `serverName`；`overrides` 的值必须恰好是 `true`；跨字段唯一性（重名服务器 / 重复 env 键 / 重复请求头名）由编辑器在写入前拦截，schema 只管形状与命名契约。
- **连接/工具加载字段**：服务器行还支持 `startupTimeoutMs`、`closeTimeoutMs`、`toolCallTimeoutMs`（旧 `timeoutMs` 仅读兼容）与 `toolLoading: eager / on-demand`；http 行有 `oauth` 块（`clientId`/`scope` 可选，`credentialKey` 一般由插件派生、无需手写）。`reconnect` 是导入透传（schema 保存它、挂载的官方 host 在连接时解析，编辑器不暴露）；`maxInstructionBytes`、`catalogDescriptionMaxLength`、`failOnStartupError` 与 `expandTemplates` 只保留在 schema 里供手改文档，编辑器导入会提示并剥离——不是透传。
- **凭据值**只在凭据域（默认 `$DSH_HOME/.credentials.yaml`）；设置文档只存 `${credential:REF}` 模板字符串，连接时由官方实例解析，值从不持久化回文档。
- 旧 `settings.yaml` 的 `mcp-scope:` 段由 loader 在首次启动时导入一次（导入后文件改名 `settings.yaml.imported`）——这是上游 loader 的旧配置迁移，与本插件的代际支持无关。
- 手改若破坏 schema，该 entry 启动时**不激活**：日志点名错误，设置分区显示不可用（没有就地修复表单）。

## 兼容性

| | 版本 |
| --- | --- |
| 编译期锚点 / dev 固定 | dsh **0.2.3-alpha.2**（cordis **4.2.0-alpha.1**、`cordis-plugin-loader` **1.2.0-alpha.1**、schemastery **~3.20.0-alpha.1**） |
| 唯一声明线（peer 范围） | `^0.2.3-alpha.2`；cordis `~4.2.0-alpha.1`（`dsh-mcp-client` 是必需 peer） |
| 实机验证锚点 | 只有这条线：`DSH_ANCHOR_CLI` / CI 的 `DSH_SMOKE_ANCHORS` 必须指向 **0.2.3-alpha.2** 的 CLI（每条声明线一次 M0/M1） |

**单线支持窗口。** 0.2.6 线只声明**一条**支持线 `^0.2.3-alpha.2`：编译锚点、dev 固定、CI 守卫与实机 smoke 都只对这条线。上一代的多线窗口已经结束——**0.2.5 冻结为旧线末版**（0.2.0/0.2.1/0.2.2 不再声明，也不再编译验证或实机验证）。本仓库不为旧代际保留兼容或 shim：0.2.3-alpha.2 移除了 `ctx.root` 属性，源码三处直接改成 `ctx[Context.root]`（没有 feature-detect 回退）；宿主版本不在 peer 范围内时，运行时的插件兼容预检会在加载前拒绝该行，需先升级 dsh。2026-11-23 的落地门禁：`npm run check` 绿（37 个 spec 文件 / 812 个测试，覆盖率 statements/lines 93.27%、branches 87.27%、functions 89.22%，含打包校验）、`verify-generation 0.2.3-alpha.2` PASS（同代际无需 `--pin`）、alpha.2 M0 实机 smoke PASS（安装/启动、设置写入 → volatile 提交 → reconcile → 连接、重启后路由仍列出工具（按工作区注入本身由真实挂载 seam 测试与 applier 集成套件断言，不由该 headless smoke 断言））。

**0.2.6-alpha.0 是 0.2.6 线的第一个预发布，也是架构 A 的落地版。** 连接层退役进官方 `McpClientHost` 实例（每台服务器一个隔离 seat fiber + 四个只捕获 façade + applier 独占 fan-out），新增按需工具加载与 OAuth 浏览器授权；客户端增加官方 `settings.section.icon` 图标位、OAuth 面板、目录提示与「加载工具」转录行。完整行为变化清单与已延迟项见 `docs/design.md` §5(g)，已知限制见 `docs/acceptance.md`。

## 排障

| 现象 | 处理 |
| --- | --- |
| 设置里没有 *MCP 服务器* 分区 | 装完的客户端模块扫描竞态——重启一次实例 |
| 分区在，但提示设置不可用 | 宿主半边没加载（profile 补丁里的 `mcp-scope` 行）或连接只读；检查该行后重启 profile |
| 工具一直不出现 | 依次确认：会话 cwd 是**已注册工作区**；这台服务器对该工作区是**开**；服务器已连接且列出过工具（连接层日志来自挂载的官方实例 `mcp-client(<server>):`；本插件自己的行仍是 `mcp-scope(...)`） |
| 手改补丁没生效 | schema 非法会让整个 entry 不激活（分区不可用 + 日志点名）；改用 UI，或修好那一行 |
| 崩过一次后服务器不工作 | 挂载的官方实例按 500ms→30s、每次中断 10 次退避重连；放弃后重载插件或重启实例 |
| 服务器显示「名称冲突」 | 同一个 `serverName` 也配在官方 manager 平面：两层只能留一处，本插件报 `failed{conflict}` 且不启动 |
| 授权页打不开 / 回调失败 | OAuth 回调要求浏览器能直达宿主 origin（HTTPS 或回环 HTTP）；反向代理后通常无法完成；另确认组合挂载了 `authorization` + `webServer`，否则动作返回 `oauth-unavailable` |
| 状态一直是「等待授权」 | 点「授权」完成浏览器流程；授权记录提交事件会自动刷新状态，也可「退出登录」后重试 |
| 掉线后显示「清理未完成」 | 上一次连接未能确认关闭：该服务器会阻止重挂载，直到插件或 Host 重启（这是清理守卫，不是配置错误） |
| 密钥输入框保存后看着是空的 | 设计如此：值只写。徽标只显示 *已配置 / 未配置 / 状态未知* |
| 想临时关掉插件又不卸载 | 用 `dsh web --patch <file>` 覆盖该行：`- id: mcp-scope` 下写 `disabled: true` |

## 卸载

```sh
dsh plugin --profile web remove dsh-chamber-mcp   # 之后重启实例
```

卸载会停掉服务器并移除设置分区；数据仍留在 profile 补丁的 `- id: mcp-scope` 行里（删掉该行即清除），相关 ref 需从 `$DSH_HOME/.credentials.yaml` 手工删除（值只写，UI 读不回来）。OAuth 授权记录同样存于凭据域（`mcp-client/` 命名空间），卸载后也需手工删除。

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/README.en.md`](docs/README.en.md) | 本 README 的英文版 |
| [`docs/design.md`](docs/design.md) | 架构：宿主/浏览器两半、官方实例挂载 + 按工作区注入模型、设置文档、启动时序、OAuth O2、wire 词汇、行为变化账本、UI 布局参考 |
| [`docs/acceptance.md`](docs/acceptance.md) | 需求与裁剪矩阵（R1–R4 / E1–E13 / C1–C6）、线路已知限制与 0.2.6-alpha.0 门禁证据 |
| [`docs/RELEASE.md`](docs/RELEASE.md) | 发布与 CI 运行手册 |

## License

[MIT](LICENSE)。本插件取自官方参考实现 `@deepseek-ai/dsh-mcp-client`（Copyright © 2026 DeepSeek, MIT）的是：捕获 façade 与 applier 的胶水代码、`mcp__` 工具命名契约，以及 OAuth 凭据 key / 退出登录语义；transport 与同步/世代切换归挂载的官方实例所有，不再镜像。署名声明见 `LICENSE`。
