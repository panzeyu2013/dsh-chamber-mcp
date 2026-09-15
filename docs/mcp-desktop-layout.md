# Settings → MCP servers — desktop layout reference (0.0.3)

> Structural reference for the shipped browser half, derived from the actual
> components and style seat — not a pixel screenshot. Open the live GUI and go
> to *Settings → MCP servers* for the rendered result. A companion wireframe
> image lives at [`mcp-desktop-layout.svg`](mcp-desktop-layout.svg).
> Chinese labels below follow the zh locale; the en locale is key-for-key
> identical (`src/client/locales.ts`).

## Where it lives

The section is registered into the official settings shell through the
`settings.section` slot (`id: mcp-scope`, `order: 25`). It renders as a single
**column, max-width 720 px, gap 12 px**, inside the settings panel; it declares
no child slots and never replaces the shell.

```
┌──────────────────────── dsh Web GUI / chamber desktop ────────────────────────┐
│ ┌──────────┐ ┌──────────────────── Settings ────────────────────────────────┐ │
│ │ sidebar  │ │ ┌───────────┐ ┌──────────── MCP 服务器 ──────────────────┐ │ │
│ │          │ │ │ settings  │ │  标题      [刷新状态]  [+ 添加服务器]      │ │ │
│ │ …        │ │ │ nav       │ │  [筛选服务器]                             │ │ │
│ │ 设置 ◀   │ │ │ 通用      │ │  ── 卡片列表 / 表单（本文档以下部分）──   │ │ │
│ │          │ │ │ 模型      │ │                                           │ │ │
│ │          │ │ │ 插件      │ │                                           │ │ │
│ │          │ │ │ MCP 服务器◀│ │                                           │ │ │
│ └──────────┘ │ └───────────┘ └───────────────────────────────────────────┘ │ │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Section surface (list state)

Order of elements exactly as rendered:

```
MCP 服务器                                          [刷新状态]  [+ 添加服务器]
┌─ 筛选服务器 ────────────────────────────────────────────────────────────┐
└─────────────────────────────────────────────────────────────────────────┘
✓ 已添加 github                                                  (role=status)

╔═ 卡片（article, aria-busy） ════════════════════════════════════════════╗
║ (◉) github   [Streamable HTTP]   1 header · Off in 2 workspaces  [移除][编辑] ║  ← 卡头
║ ● 已连接 · 12 个工具                        [断开] [测试] [工具 (12)]   ║  ← 状态行
║ ┌ 工具 ──────────────────────────────────────────────────────────────┐ ║
║ │ search_issues — Search issues       (code 11px, 悬停显示描述)      │ ║
║ │ 共 120 个工具，显示前 2 个。                                        │ ║
║ └────────────────────────────────────────────────────────────────────┘ ║
║ ┌ 删除确认（按下“移除”后替换操作行） ────────────────────────────────┐ ║
║ │ 移除服务器？ 服务器将全面停止，配置被删除。        [确认] [取消]      │ ║
║ └────────────────────────────────────────────────────────────────────┘ ║
║ npx -y @modelcontextprotocol/server-github        (definition code)     ║
║ 工作目录：/srv/github                                                   ║
║ Authorization  AUTH_TOKEN  已配置  [清除]            ← 凭据徽标行       ║
║ 默认开启，除非在此关闭                                                  ║
║  ● alpha  (switch) 开启        ● beta  (switch) 关闭                    ║
║                     [全部开启] [全部关闭]        ← ≥2 个 workspace 时   ║
║ 新建 workspace 默认开启                                                 ║
╚═════════════════════════════════════════════════════════════════════════╝

（卡片按文档顺序纵向排列；表单打开时渲染在列表上方，列表保留，删除类操作禁用）
```

### Card anatomy — vertical order (top → bottom)

| # | Element | States / notes |
|---|---|---|
| 1 | **Card header** `styles.cardHead` | enable switch (writable only) · server name (focus target after save) · transport tag (`stdio` / `Streamable HTTP`) · summary `N env keys / N headers · 已停用 · Off in N workspaces` · **移除**(danger) / **编辑**(outline), hidden while the remove confirm is open |
| 2 | **Status row** `styles.statusRow` | 8 px dot (state tone) · phase label (`已连接/连接中…/重连中…/失败/已停止/已停用/状态未知`) · `N 个工具` (connected) · `第 i/max 次尝试` (reconnecting) · spacer · **断开|连接** (pending 文案) · **测试** · **工具 (N)** — runtime actions only when a runtime view exists; disabled-server actions hidden |
| 3 | Runtime failure line | localized fixed code (never remote text) |
| 4 | No-channel hint | `运行时状态不可用` / `运行时状态刷新失败` |
| 5 | Test note (role=status) | transient `测试通过 · N 个工具` |
| 6 | Runtime action alert (role=alert) | transient, dismissible |
| 7 | Tools disclosure | loading / empty / rows (`rawName — description`, true total when truncated) |
| 8 | Save failure alert (role=alert) | transient, dismissible |
| 9 | Remove confirmation `styles.confirm` | danger-tinted block, Esc cancels, focus returns to 移除 |
| 10 | Definition details | command line **or** URL in `code`, plus cwd hint |
| 11 | Credential badges | configured (ok) / unset (warn) / unknown (neutral); **清除** only when configured |
| 12 | Workspace block `styles.wsBlock` | `默认开启…` hint · lifecycle states (loading / error / no workspaces) · per-workspace switch rows (`开启` / `关闭`) · all-on/all-off (≥2 workspaces) · `新建 workspace 默认开启` |

## Add / Edit form (rendered above the list)

```
┌─ 添加 MCP 服务器 / 编辑 MCP 服务器（form, bg-module-platform, r12） ─────┐
│ [导入 JSON…]                                                            │
│ ┌ 导入 MCP 服务器 JSON（role=dialog） ────────────────────────────────┐ │
│ │ 粘贴 mcpServers / opencode 片段中的单个服务器。                     │ │
│ │ ┌ textarea（code 字体, min-height 96） ──────────────────────────┐  │ │
│ │ └────────────────────────────────────────────────────────────────┘  │ │
│ │ [从剪贴板粘贴]                       [填入表单]                     │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ 服务器名称 *                                                            │
│ [__________________________]  工具将以 mcp__<名称>__* 命名              │
│ (◉) 启用     停用的服务器保留配置，但不会运行，也不会暴露任何工具。      │
│ 传输方式    ( stdio )  ( Streamable HTTP )        ← Pill 单选           │
│                                                                         │
│ ── stdio 分支 ───────────────────────────────────────────────────────  │
│ 命令 *                                                                  │
│ [____________________________________]  该命令以此实例用户身份执行     │
│ [粘贴命令]                                                              │
│ 参数                                                                    │
│ [  参数 1  ] [移除]                                                     │
│ [  参数 2  ] [移除]        [+ 添加参数]                                 │
│ 工作目录（可选）    [_______________________________]                   │
│ 环境变量 / 凭据键                                                       │
│ 这些条目会注入服务器进程的环境。                                        │
│ [粘贴 .env]                                                             │
│ [KEY 1] [值（仅写入）] [移除]                                           │
│ [+ 添加环境变量]                                                        │
│                                                                         │
│ ── Streamable HTTP 分支 ─────────────────────────────────────────────  │
│ URL（端点） *                                                           │
│ [____________________________________]                                  │
│ 请求头                                                                  │
│ 每次 MCP 请求都会带上这些请求头。                                       │
│ [粘贴请求头]                                                            │
│ [Authorization] [AUTH_TOKEN] [值（仅写入）] [移除]                      │
│ [+ 添加请求头]                                                          │
│                                                                         │
│ ── 两个分支共用 ─────────────────────────────────────────────────────  │
│ 超时（毫秒）    [__________]  留空使用默认 60 秒。                       │
│                                                                         │
│ ┌ 放弃未保存的修改？（仅 dirty 时，点关闭后出现） ────────────────────┐ │
│ │                               [放弃修改] [继续编辑]                  │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│                                        [取消]            [保存]         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Runtime state matrix

| Host phase | Dot | Label (zh) | Actions shown (runtime available) |
|---|---|---|---|
| `connected` | 绿 `state-success-primary` | 已连接 + `N 个工具` | 断开 · 测试 · 工具 (N) |
| `connecting` | 黄 `state-warn-primary` | 连接中… | 断开 · 测试 |
| `reconnecting` | 黄 | 重连中… + `第 i/max 次尝试` | 断开 · 测试 |
| `failed` | 红 `state-error-primary` | 失败 | 连接 · 测试 |
| `stopped` | 灰 `border-l3` | 已停止 | 连接 · 测试 |
| `disabled` | 灰 + 卡片 60% 不透明 | 已停用 | （无运行时动作；用卡头开关启用） |
| `unknown` | 灰 | 状态未知 | 连接 · 测试 |
| no runtime view | 灰 + hint | 状态未知 + `运行时状态不可用`/`刷新失败` | （无运行时动作） |

## Metrics (source of truth: `src/client/styles.ts`)

| Part | Metric |
|---|---|
| Section column | max-width 720 px · gap 12 px · label-primary text |
| Title | 16/24 px, weight 500 |
| Header actions | `Button size=sm` capsule: 28 px high, radius 14 px, 0 10 px padding, 12/18 text |
| Card | padding 12 16 14 · 0.5 px `border-l4` hairline · radius 16 · `bg-layer-3` · hover border `label-dimmed` · disabled opacity .6 |
| Status dot | 8 × 8 px · radius 50% · `corner-shape: round` · `state-*-primary` / `border-l3` |
| Form | padding 14/16 · radius 12 · `bg-module-platform` |
| Field label | 13/20 px, weight 500 |
| Input | height 34 px · radius 8 · 0.5 px `border-l4` · `bg-layer-1` · 13/20; focus border `brand-primary`; disabled opacity .5 |
| Textarea | min-height 96 px · radius 8 · code font 12/18 · resize vertical |
| Import dialog | padding 10/12 · radius 10 · 0.5 px `border-l4` · `bg-layer-2` |
| Switch | track 36 × 20, radius 10, thumb 16, `brand-primary` when on |
| Tag / badge | 999 px pill · 11/17 · `corner-shape: round` |
| Tool rows | code font 11/17 · raw name label-primary · description label-secondary |

## Interactions worth knowing

- **Form placement**: Add/Edit renders *above* the card list; the list stays visible and
  destructive card actions are disabled while a form is open.
- **Dirty guard**: 取消 (footer), the header `取消`, and unmount-adjacent paths all route
  through the same close request; a dirty form shows the inline discard confirm.
- **Search**: filters by server name when no form is open; a zero-match query shows
  `没有匹配“…”的服务器` instead of the empty-state copy.
- **Polling**: the runtime snapshot is fetched once per document revision, on
  `connection/reset`, and every 5 s while the panel is visible; with zero servers
  configured the poll is skipped entirely (the header refresh action still works).
- **Degradation**: no runtime channel (headless host / missing route) hides the runtime
  actions and shows the unavailable hint; all document features keep working.

## Evidence

- Components: `src/client/section.tsx`, `src/client/server-card.tsx`,
  `src/client/add-form.tsx`; style seat: `src/client/styles.ts`.
- Render/flow tests: `tests/client/section-render.spec.tsx`; style-token gate:
  `tests/client/styles.spec.tsx` (S1–S7 + class map/CSS coverage).
- Wireframe: [`mcp-desktop-layout.svg`](mcp-desktop-layout.svg).
