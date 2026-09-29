# dsh-chamber-mcp

[![CI](https://github.com/panzeyu2013/dsh-chamber-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/panzeyu2013/dsh-chamber-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/panzeyu2013/dsh-chamber-mcp?display_name=tag)](https://github.com/panzeyu2013/dsh-chamber-mcp/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

**简体中文** ｜ [English](docs/README.en.md)

> **MCP 服务器，按工作区，从 dsh 设置界面管理。**
> 声明一次服务器（stdio 或 Streamable HTTP），再用开关决定 **哪些工作区** 的会话能看见它的工具。默认：一个都不给。

独立的第三方 [dsh](https://github.com/deepseek-ai/deepseek-harness) 插件，一次普通的 `dsh plugin` 安装——dsh-chamber 不预置、不捆绑、不特判。

## 为什么需要它

dsh 自带的 `@deepseek-ai/dsh-mcp-client` 负责把 MCP **桥**进模型，但不负责"管"：

- 一台服务器 = 补丁配置里的一行，增删改都要手编 `cordis.patch.yml`；
- 密钥以字面量（或 `!!js process.env.X`）写在同一个文件里；
- 工具注册在"组合它的那个上下文"里——宿主行落在 **全局层**，于是**每个**会话都背着全部 MCP 工具：既烧上下文，也可能误调。

上游也没有可复用的替代面：*设置 → 插件 → 插件配置*只为"Config 暴露了可编辑字段"的 entry 渲染表单（官方 MCP 客户端一个字段都没有），插件列表只读，`dsh-workspace` 只做项目分组、不注册任何工具——**没有现成机制把"工作区"映射到"一组工具"**。

本插件补的正是这两块：**管理面**（设置界面）和**作用域**（按工作区注入的能力门）。

## 核心优点

| 优点 | 具体表现 |
| --- | --- |
| **设置界面原生管理** | *设置 → MCP 服务器* 里增删改查，不碰 `cordis.patch.yml`；UI 写入提交到**正在运行**的插件上，只重启受影响的服务器，不重启实例 |
| **按工作区注入，默认全关** | 新服务器对**每个**工作区都是关的；新工作区、新会话不会凭空多出 MCP 工具。关掉某工作区 = 从该工作区会话的**工具表**里撤销 `mcp__<serverName>__*`——模型可见层面的变化，不只是执行时拦截 |
| **凭据引用，不是密钥** | 设置文档里只有 ref 名；值存在 dsh 凭据域、**只写不可读**，永远不出现在设置文档、API 响应或日志行里 |
| **MCP 专用转录行** | 调用渲染为插件通过 keyed `tool.call.toolview` 槽注册的 MCP 行：插头标记、`server · tool` 标题、传输标签、运行/成功/失败/中断状态，可展开参数与结果——而不是官方通用卡片 |
| **官方桥接契约** | 命名 `mcp__<serverName>__<tool>`、结果与图像映射、子进程环境清洗、`tools/list_changed` 世代切换、500ms→30s 退避重连，全部对齐官方客户端；MCP **资源**也经官方 `mcpResources` provider 可达 |
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

1. 打开 *设置 → MCP 服务器* → **添加服务器**。两种传输：**stdio**（名称、命令、参数、可选工作目录、环境变量键）与 **Streamable HTTP**（URL、请求头行）。支持粘贴导入（整条命令行、`.env` 行、请求头行）与单服务器 JSON 导入。
2. 新服务器**对每个工作区都是关的**。点卡片上的 **管理工作区 (N 开)** 展开全部工作区逐个打开——这一步就是"这对（服务器 × 工作区）生效"的全部含义；工作区多于一个时还有 **全部开启 / 全部关闭**。服务器名旁的开关是**全局**开关：停用即不启动、哪里都不注册工具，配置留在盘上。
3. 每张卡片带实时状态（connected / connecting / reconnecting / failed / stopped / disabled / unknown）、**连接** / **断开** / **测试**，以及 **工具 (N)**（展开已同步的工具名）；**编辑** 重开表单，**移除** 到处停掉并清掉不再被引用的凭据 ref。分区头有名称过滤与 **刷新状态**。

## 一次会话能拿到什么

| 会话 | 拿到 MCP 工具？ |
| --- | --- |
| 工作区根会话，且该工作区对这台的开关为开 | 是——`mcp__<serverName>__<rawName>` |
| 工作区根会话，但开关是关 | 否——定义被从该 agent 的 scope 撤销 |
| cwd 不在任何已注册工作区的会话 | 否 |
| 子代理 / 委派子会话 | 继承父会话的工作区（`continuable` 再受 `toolFilter` 收窄） |

- **工具就是请求里的普通 tool schema**：计入输入框旁上下文环的 **工具定义** 一项（上下文环只在模型报告过用量后显示）；服务器发布 `instructions` 时另加一段 `### MCP server: <name>` 提示段。
- **名字会归一化**：`mcp__<serverName>__<rawName>` 裁到 ≤64 字符的 `[A-Za-z0-9_-]`；有损归一化时追加 12 位 SHA-256 身份后缀，两个不同 MCP 工具永远不会塌成同一个名字；`tools/call` 里发的是原始 MCP 名。
- **列表有界**：官方 `listMaxPages`(64) + 插件每台 2000 工具上限；不收敛或超限 → 同步失败并保留上一代工具；调用 60s 超时，随 run 的 signal 中止。

## 配置在哪里

配置就是插件自己的 Loader entry Config——profile 用户补丁 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里的一行：

```yaml
- id: mcp-scope
  name: dsh-chamber-mcp
  config:
    servers:                        # serverName 是身份
      - serverName: github
        transport: streamable-http  # 或 stdio：command/args/cwd/envKeys
        url: https://mcp.example.com/x
        headers:
          - name: Authorization
            ref: GITHUB_TOKEN       # 凭据引用，绝不是值
    overrides:                      # 存在 = 该工作区为开（默认关）
      ws-2f1c:
        github: true
```

- **服务器身份** = `serverName`；`overrides` 的值必须恰好是 `true`；跨字段唯一性（重名服务器 / 重复 env 键 / 重复请求头名）由编辑器在写入前拦截，schema 只管形状与命名契约。
- **凭据值**只在凭据域（默认 `$DSH_HOME/.credentials.yaml`）。
- 从 0.1.5/0.1.6 代际升级：首次启动把旧 `settings.yaml` 的 `mcp-scope:` 段导入一次，并把文件改名为 `settings.yaml.imported`。
- 手改若破坏 schema，该 entry 启动时**不激活**：日志点名错误，设置分区显示不可用（没有就地修复表单）。

## 兼容性

| | 版本 |
| --- | --- |
| 编译期锚点 / CI 守卫 | dsh **0.2.0-rc.1** |
| 实机验证 | dsh **0.2.0-rc.1** 与 **0.1.7-rc.2** |
| peer 范围 | `^0.1.7-rc.2 \|\| ^0.2.0-rc.1` |

0.2.0 线仍是 RC 期间同时保留 0.1.7 线；两条线都提供本插件依赖的 Config/volatile 设置模型与官方 `createMcpToolDefinition` 适配器。

## 排障

| 现象 | 处理 |
| --- | --- |
| 设置里没有 *MCP 服务器* 分区 | 装完的客户端模块扫描竞态——重启一次实例 |
| 分区在，但提示设置不可用 | 宿主半边没加载（profile 补丁里的 `mcp-scope` 行）或连接只读；检查该行后重启 profile |
| 工具一直不出现 | 依次确认：会话 cwd 是**已注册工作区**；这台服务器对该工作区是**开**；服务器已连接且列出过工具（实例日志 `mcp-scope(...)`） |
| 手改补丁没生效 | schema 非法会让整个 entry 不激活（分区不可用 + 日志点名）；改用 UI，或修好那一行 |
| 崩过一次后服务器不工作 | 退避重连 500ms→30s、每次中断 10 次；放弃后重载插件或重启实例 |
| 密钥输入框保存后看着是空的 | 设计如此：值只写。徽标只显示 *已配置 / 未配置 / 状态未知* |
| 想临时关掉插件又不卸载 | 用 `dsh web --patch <file>` 覆盖该行：`- id: mcp-scope` 下写 `disabled: true` |

## 卸载

```sh
dsh plugin --profile web remove dsh-chamber-mcp   # 之后重启实例
```

卸载会停掉服务器并移除设置分区；数据仍留在 profile 补丁的 `- id: mcp-scope` 行里（删掉该行即清除），相关 ref 需从 `$DSH_HOME/.credentials.yaml` 手工删除（值只写，UI 读不回来）。

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/README.en.md`](docs/README.en.md) | 本 README 的英文版 |
| [`docs/design.md`](docs/design.md) | 架构：宿主机/浏览器两半、监管器与注入模型、设置文档、上游契约与刻意偏离、UI 布局参考 |
| [`docs/acceptance.md`](docs/acceptance.md) | 需求与裁剪矩阵（R1–R4 / E1–E8 / C1–C6） |
| [`docs/status.md`](docs/status.md) | 当前发布与验证状态、已知限制 |
| [`docs/RELEASE.md`](docs/RELEASE.md) | 发布与 CI 运行手册 |

## License

[MIT](LICENSE)。工具命名、同步/世代切换、执行器与传输语义对齐官方参考实现 `@deepseek-ai/dsh-mcp-client`（Copyright © 2026 DeepSeek, MIT）；署名声明见 `LICENSE`。
