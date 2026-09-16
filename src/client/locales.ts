/**
 * Flat bilingual dictionary of the `mcp-scope.settings` locale namespace.
 * One key union; both built-in locales must carry the same key set
 * (compile-enforced at the `ctx.locale.register(NS, { zh, en })` site, and
 * asserted again by tests/client/locales.spec.ts).
 *
 * Template values interpolate `{name}` parameters (locale translate contract).
 * English plural count forms live as `.one`/`.other` key pairs resolved by
 * the `countKey` helper (zh has no plural forms; its `.one`/`.other` mirrors
 * are identical so key parity holds).
 */

export const en = {
  // nav / section identity
  nav: 'MCP servers',

  // lifecycle / page-level state
  'state.loading': 'Loading…',
  'state.saving': 'Saving…',
  'state.clearing': 'Clearing…',
  'state.unavailable': 'MCP server settings are unavailable here (namespace not served to this client or connection is read-only).',
  'state.readonly': 'This document is read-only here; changes cannot be saved.',

  // empty states
  'empty.servers': 'No MCP servers configured yet.',
  'workspaces.empty': 'No workspaces yet',
  'workspaces.loading': 'Loading workspaces…',
  'workspaces.error': 'Failed to load the workspace list.',

  // transport names
  'transport.stdio': 'stdio',
  'transport.http': 'Streamable HTTP',

  // MCP tool row (transcript lane; registered through `tool.call.toolview`)
  'tool.running': 'Running…',
  'tool.failed': 'Failed',
  'tool.stopped': 'Interrupted',
  'tool.input': 'Input',
  'tool.output': 'Output',
  'tool.noOutput': 'No output',
  'tool.normalized': 'Name was normalized to fit the tool-name limit',

  // server card summary (plural forms resolved through countKey)
  'server.envKeys.one': '{count} env key',
  'server.envKeys.other': '{count} env keys',
  'server.headers.one': '{count} header',
  'server.headers.other': '{count} headers',
  'server.enabledWorkspaces.one': 'On in {count} workspace',
  'server.enabledWorkspaces.other': 'On in {count} workspaces',
  'server.notEnabled': 'Not on in any workspace',
  'server.edit': 'Edit',
  'server.remove': 'Remove',
  'server.removeConfirmTitle': 'Remove server?',
  'server.removeConfirmBody': 'The server stops everywhere and its configuration is deleted. Credentials that no remaining server references are cleared as well.',
  'server.defaultOff': 'Off by default — enable it in the workspaces you want',
  'server.cwd': 'Working directory: {path}',

  // per-workspace rows
  'row.on': 'On',
  'row.off': 'Off',

  // credential badges / secret controls (tri-state: configured / unset / unknown)
  'secret.configured': 'Configured',
  'secret.unset': 'Not configured',
  'secret.unknown': 'Status unknown',
  'secret.clearing': 'Clearing…',
  'secret.clear': 'Clear',
  'secret.clearHint': 'Removes the stored value; the reference stays on the server.',

  // actions
  'action.save': 'Save',
  'action.cancel': 'Cancel',
  'action.confirm': 'Confirm',
  'action.dismiss': 'Dismiss',

  // add/edit-server form
  'add.add': 'Add server',
  'add.title': 'Add MCP server',
  'edit.title': 'Edit MCP server',
  'add.added': 'Added {name}',
  'edit.saved': 'Saved changes to {name}',
  'add.serverName': 'Server name',
  'add.transport': 'Transport',
  'add.command': 'Command',
  'add.args': 'Arguments',
  'add.argAdd': 'Add argument',
  'add.argRemove': 'Remove argument',
  'add.cwd': 'Working directory (optional)',
  'add.url': 'URL (endpoint)',
  'add.envKey': 'Env var / credential key',
  'add.envAdd': 'Add env key',
  'add.envRemove': 'Remove env key',
  'add.credentialRef': 'Credential ref (env var name)',
  'add.headerName': 'Header name',
  'add.headerAdd': 'Add header',
  'add.headerRemove': 'Remove header',
  'add.secretValueLabel': 'Value (write-only, never shown again)',
  'add.secretPlaceholder': 'Value',
  'add.headerNamePlaceholder': 'Authorization',
  'add.credentialRefPlaceholder': 'AUTH_TOKEN',
  'add.ellipsis': '…',
  'add.envSectionHint': 'These entries are injected as environment variables into the server process.',
  'add.headerSectionHint': 'Headers are sent with each MCP request. Values are write-only: a blank input keeps the stored value.',
  'add.commandUserHint': "This command runs as this dsh instance's user.",
  'add.toolPrefixHint': 'Tools are exposed as mcp__{name}__*',
  'add.enabled': 'Allow server',
  'add.enabledHint':
    'A server is allowed by default and still runs nowhere: MCP is off until a workspace enables the pair, so this switch only decides whether the server may run at all.',
  'add.timeout': 'Timeout (ms)',
  'add.timeoutHint': 'Leave blank for the default 60 s; applies to tool calls and tool-list sync.',
  'add.pasteCommand': 'Paste command',
  'add.pasteCommandHint': 'Paste a full command line; it is split into command and arguments.',
  'add.pasteEnv': 'Paste .env',
  'add.pasteHeaders': 'Paste headers',
  'add.pasteHeadersHint': 'Paste "Name: value" or "Name=value" lines; values stay write-only.',
  'add.importJson': 'Import JSON…',
  'import.title': 'Import MCP server JSON',
  'import.hint': 'Paste a server section (mcpServers / VS Code servers / opencode mcp): a whole config file or one entry, comments and trailing commas included. The first server fills the form, the others are listed; secret values go to the write-only fields.',
  'import.textareaLabel': 'MCP JSON snippet',
  'import.parse': 'Fill form',
  'import.paste': 'Paste from clipboard',
  'import.error': 'No MCP server could be read from that JSON',
  'import.errorNoServer': 'That JSON is readable but holds no MCP server entry (expected mcpServers, VS Code servers, opencode mcp, or a single server object)',
  'import.multiple': 'Using "{name}"; also found: {others}',
  'import.more': ' (+{count} more)',
  'paste.envImported': 'Imported {count} variables',
  'paste.headersImported': 'Imported {count} headers',
  'paste.argsImported': 'Imported {count} arguments',
  'paste.noneFound': 'No KEY=VALUE pairs found',
  'clipboard.readFailed': 'Clipboard read failed; paste into the field manually',

  // dirty-form protection
  'dirty.confirm': 'Discard unsaved changes?',
  'dirty.discard': 'Discard',
  'dirty.keepEditing': 'Keep editing',

  // section list controls
  'search.placeholder': 'Filter servers',
  'search.none': 'No server matches "{query}"',
  'row.allOn': 'All on',
  'row.allOff': 'All off',
  'row.manage': 'Manage workspaces ({count} on)',
  'row.manageHide': 'Hide workspaces',
  'row.allOffDefault.one': 'This workspace is off by default ({count} in total)',
  'row.allOffDefault.other': 'All {count} workspaces are off by default',
  'server.enableToggle': 'Allow server',
  'server.disabledTag': 'Disabled',

  // runtime status + connection actions
  'status.connected': 'Connected',
  'status.connecting': 'Connecting…',
  'status.reconnecting': 'Reconnecting…',
  'status.failed': 'Failed',
  'status.stopped': 'Stopped',
  'status.disabled': 'Disabled',
  'status.unknown': 'Status unknown',
  'status.retry': 'attempt {attempt}/{max}',
  'status.tools': '{count} tools',
  'action.connect': 'Connect',
  'action.disconnect': 'Disconnect',
  'action.connecting': 'Connecting…',
  'action.disconnecting': 'Disconnecting…',
  'action.test': 'Test',
  'action.testing': 'Testing…',
  'action.testOk': 'Test OK · {count} tools',
  'action.retry': 'Retry',
  'runtime.unavailable': 'Runtime status is unavailable here (no connection route in this deployment).',
  'runtime.error': 'Runtime status could not be refreshed.',
  'runtime.stale': 'Status may be out of date',
  'runtime.error.connection-failed': 'Connection failed',
  'runtime.error.gave-up': 'Reconnect attempts exhausted',
  'runtime.error.reconnect-disabled': 'Connection lost and reconnect is disabled',
  'runtime.error.generation-stuck': 'Previous connection generation did not close',
  'runtime.error.forbidden': 'The server rejected the credentials (HTTP 401/403)',
  'runtime.error.timeout': 'The connection or request timed out',
  'runtime.error.spawn-failed': 'The server command could not be started',
  'runtime.error.protocol': 'The server returned an invalid response',
  'runtime.refresh': 'Refresh status',
  'tools.title': 'Tools',
  'tools.loading': 'Loading…',
  'tools.empty': 'No tool list synced yet.',
  'tools.truncated': 'Showing {count} of {total} tools.',

  // validation messages
  'validation.namePattern': 'Use 1–32 letters, digits, underscores or hyphens',
  'validation.duplicateName': 'A server with this name already exists',
  'validation.commandRequired': 'Command is required',
  'validation.urlRequired': 'URL is required',
  'validation.invalidUrl': 'Invalid URL: must be an http(s) address',
  'validation.refPattern': 'Env-style name: starts with a letter, then letters, digits or underscores',
  'validation.refDuplicate': 'Another row already claims this credential ref',
  'validation.headerNameEmpty': 'Header name must not be empty',
  'validation.envKeyDuplicate': 'Duplicate env key',
  'validation.headerNameDuplicate': 'Duplicate header name',
  'validation.nameReserved': 'This name is reserved and cannot be used.',
  'validation.headerNameToken': 'Not a valid HTTP field name.',
  'validation.timeout': 'Whole number between 1000 and 600000',

  // save errors / failures
  'error.conflict': 'Not saved: your change was not applied (the settings document changed elsewhere; the latest version was reloaded).',
  'error.conflictKeptRefs': 'Credential value(s) for {refs} were already updated and stay stored.',
  'error.saveFailed': 'Save failed, please retry.',
  'error.secretWriteFailed': 'Failed to write credential(s): {refs}',
  'error.unexpected': 'Unexpected error.',

  // registered-tools notice (conversation lane)
  'injection.title': 'MCP tools registered',
  'injection.entry': '{name} ({count})',
  'injection.total': '{count} tools registered',
  'injection.omitted': '…and {count} more not listed',
} as const satisfies Record<string, string>

export type SettingsKey = keyof typeof en

/**
 * Plural count-key resolution for the summarized count strings. English
 * carries `.one`/`.other` dictionary pairs; the `countKey` helper picks the
 * right one (other locales carry identical mirrors for key parity).
 */
export function countKey(
  kind: 'server.envKeys' | 'server.headers' | 'server.enabledWorkspaces' | 'row.allOffDefault',
  count: number,
): SettingsKey {
  return `${kind}.${count === 1 ? 'one' : 'other'}` as SettingsKey
}

/** Dictionary namespace registered by this plugin (`mcp-scope.settings`). */
export const NS = 'mcp-scope.settings'

export const zh: Record<SettingsKey, string> = {
  // nav / section identity
  nav: 'MCP 服务器',

  // lifecycle / page-level state
  'state.loading': '加载中…',
  'state.saving': '保存中…',
  'state.clearing': '清除中…',
  'state.unavailable': 'MCP 服务器设置当前不可用（命名空间未注册到本客户端，或连接为只读）。',
  'state.readonly': '当前文档为只读，无法保存修改。',

  // empty states
  'empty.servers': '尚未配置 MCP 服务器。',
  'workspaces.empty': '暂无 workspace',
  'workspaces.loading': '正在加载 workspace 列表…',
  'workspaces.error': 'workspace 列表加载失败。',

  // transport names
  'transport.stdio': 'stdio',
  'transport.http': '流式 HTTP',

  // MCP 工具行（会话流；通过 tool.call.toolview 注册）
  'tool.running': '运行中…',
  'tool.failed': '失败',
  'tool.stopped': '已中断',
  'tool.input': '参数',
  'tool.output': '结果',
  'tool.noOutput': '无输出',
  'tool.normalized': '名称已按工具名长度上限规范化',

  // server card summary (zh has no plural forms; mirrors carry identical text)
  'server.envKeys.one': '{count} 个环境变量键',
  'server.envKeys.other': '{count} 个环境变量键',
  'server.headers.one': '{count} 个请求头',
  'server.headers.other': '{count} 个请求头',
  'server.enabledWorkspaces.one': '已在 {count} 个 workspace 开启',
  'server.enabledWorkspaces.other': '已在 {count} 个 workspace 开启',
  'server.notEnabled': '未在任何 workspace 开启',
  'server.edit': '编辑',
  'server.remove': '移除',
  'server.removeConfirmTitle': '移除服务器？',
  'server.removeConfirmBody': '该服务器将在所有 workspace 停止并删除配置；其余服务器不再引用的凭据也会一并清除。',
  'server.defaultOff': '默认关闭：仅在下面显式开启的 workspace 中注入工具',
  'server.cwd': '工作目录：{path}',

  // per-workspace rows
  'row.on': '开启',
  'row.off': '已关闭',

  // credential badges / secret controls (tri-state: configured / unset / unknown)
  'secret.configured': '已配置',
  'secret.unset': '未配置',
  'secret.unknown': '状态未知',
  'secret.clearing': '清除中…',
  'secret.clear': '清除',
  'secret.clearHint': '清除已存值；服务器上的引用保持不变。',

  // actions
  'action.save': '保存',
  'action.cancel': '取消',
  'action.dismiss': '关闭',
  'action.confirm': '确认',

  // add/edit-server form
  'add.add': '添加服务器',
  'add.title': '添加 MCP 服务器',
  'edit.title': '编辑 MCP 服务器',
  'add.added': '已添加 {name}',
  'edit.saved': '已保存对 {name} 的修改',
  'add.serverName': '服务器名称',
  'add.transport': '传输方式',
  'add.command': '命令',
  'add.args': '参数',
  'add.argAdd': '添加参数',
  'add.argRemove': '移除参数',
  'add.cwd': '工作目录（可选）',
  'add.url': 'URL（端点）',
  'add.envKey': '环境变量键/凭据键',
  'add.envAdd': '添加环境变量键',
  'add.envRemove': '移除环境变量键',
  'add.credentialRef': '凭据引用（环境变量名）',
  'add.headerName': '请求头名称',
  'add.headerAdd': '添加请求头',
  'add.headerRemove': '移除请求头',
  'add.secretValueLabel': '值（仅写入，不会再次显示）',
  'add.secretPlaceholder': '值',
  'add.headerNamePlaceholder': 'Authorization',
  'add.credentialRefPlaceholder': 'AUTH_TOKEN',
  'add.ellipsis': '…',
  'add.envSectionHint': '以下条目将以环境变量的形式注入该服务器进程。',
  'add.headerSectionHint': '请求头随每次 MCP 请求发送；值仅写入——留空输入框即保留已存值。',
  'add.commandUserHint': '该命令将以此 dsh 实例的用户身份直接执行。',
  'add.toolPrefixHint': '工具将以 mcp__{name}__* 命名',
  'add.enabled': '允许使用该服务器',
  'add.enabledHint':
    '默认允许，但仍不会在任何 workspace 运行：MCP 需要 workspace 显式开启，因此这个开关只决定该服务器是否被允许运行。',
  'add.timeout': '超时（毫秒）',
  'add.timeoutHint': '留空使用默认 60 秒；作用于工具调用与工具列表同步。',
  'add.pasteCommand': '粘贴命令',
  'add.pasteCommandHint': '粘贴完整命令行，将自动拆分为命令与参数。',
  'add.pasteEnv': '粘贴 .env',
  'add.pasteHeaders': '粘贴请求头',
  'add.pasteHeadersHint': '粘贴 “名称: 值” 或 “名称=值” 行；值仅写入，不会回显。',
  'add.importJson': '导入 JSON…',
  'import.title': '导入 MCP 服务器 JSON',
  'import.hint': '粘贴服务器片段（mcpServers / VS Code servers / opencode mcp）：整份配置文件或单个条目均可，支持注释与尾随逗号。第一个服务器填入表单，其余会列出；密钥值进入仅写入字段。',
  'import.textareaLabel': 'MCP JSON 片段',
  'import.parse': '填入表单',
  'import.paste': '从剪贴板粘贴',
  'import.error': '无法从该 JSON 中解析出 MCP 服务器',
  'import.errorNoServer': '该 JSON 可以解析，但没有找到 MCP 服务器条目（支持 mcpServers、VS Code servers、opencode mcp，或单个服务器对象）',
  'import.multiple': '已使用“{name}”；同时发现：{others}',
  'import.more': ' 等共 {count} 个',
  'paste.envImported': '已导入 {count} 个环境变量',
  'paste.headersImported': '已导入 {count} 个请求头',
  'paste.argsImported': '已导入 {count} 个参数',
  'paste.noneFound': '未找到 KEY=VALUE 条目',
  'clipboard.readFailed': '读取剪贴板失败，请手动粘贴到输入框',

  // dirty-form protection
  'dirty.confirm': '放弃未保存的修改？',
  'dirty.discard': '放弃修改',
  'dirty.keepEditing': '继续编辑',

  // section list controls
  'search.placeholder': '筛选服务器',
  'search.none': '没有匹配“{query}”的服务器',
  'row.allOn': '全部开启',
  'row.allOff': '全部关闭',
  'injection.title': 'MCP 工具已注册',
  'injection.entry': '{name}（{count}）',
  'injection.total': '共注册 {count} 个工具',
  'injection.omitted': '……还有 {count} 个未列出',

  'row.manage': '管理 workspace（已开启 {count}）',
  'row.manageHide': '收起 workspace',
  'row.allOffDefault.one': '该 workspace 默认关闭（共 {count} 个）',
  'row.allOffDefault.other': '全部 {count} 个 workspace 默认关闭',
  'server.enableToggle': '允许使用该服务器',
  'server.disabledTag': '已停用',

  // runtime status + connection actions
  'status.connected': '已连接',
  'status.connecting': '连接中…',
  'status.reconnecting': '重连中…',
  'status.failed': '失败',
  'status.stopped': '已停止',
  'status.disabled': '已停用',
  'status.unknown': '状态未知',
  'status.retry': '第 {attempt}/{max} 次尝试',
  'status.tools': '{count} 个工具',
  'action.connect': '连接',
  'action.disconnect': '断开',
  'action.connecting': '连接中…',
  'action.disconnecting': '断开中…',
  'action.test': '测试',
  'action.testing': '测试中…',
  'action.testOk': '测试通过 · {count} 个工具',
  'action.retry': '重试',
  'runtime.unavailable': '当前部署未提供运行时状态通道。',
  'runtime.error': '运行时状态刷新失败。',
  'runtime.stale': '状态可能过期',
  'runtime.error.connection-failed': '连接失败',
  'runtime.error.gave-up': '重连次数已耗尽',
  'runtime.error.reconnect-disabled': '连接丢失且未启用重连',
  'runtime.error.generation-stuck': '上一代连接未能正常关闭',
  'runtime.error.forbidden': '服务器拒绝了凭据（HTTP 401/403）',
  'runtime.error.timeout': '连接或请求超时',
  'runtime.error.spawn-failed': '服务器命令无法启动',
  'runtime.error.protocol': '服务器返回了无效响应',
  'runtime.refresh': '刷新状态',
  'tools.title': '工具',
  'tools.loading': '加载中…',
  'tools.empty': '尚未同步工具列表。',
  'tools.truncated': '共 {total} 个工具，显示前 {count} 个。',

  // validation messages
  'validation.namePattern': '1–32 位，仅限字母、数字、下划线或连字符',
  'validation.duplicateName': '已存在同名服务器',
  'validation.commandRequired': '请填写命令',
  'validation.urlRequired': '请填写 URL',
  'validation.invalidUrl': 'URL 无效：需为 http(s) 地址',
  'validation.refPattern': '需为环境变量名：字母开头，后可含字母、数字、下划线',
  'validation.refDuplicate': '该凭据引用已被其他行占用',
  'validation.headerNameEmpty': '请求头名称不能为空',
  'validation.envKeyDuplicate': '环境变量键重复',
  'validation.headerNameDuplicate': '请求头名称重复',
  'validation.nameReserved': '该名称被保留，无法使用。',
  'validation.headerNameToken': '不是合法的 HTTP 请求头名称。',
  'validation.timeout': '需为 1000–600000 的整数',

  // save errors / failures
  'error.conflict': '未保存：你的修改未生效（设置文档已在别处变化，已重新载入最新版本）。',
  'error.conflictKeptRefs': '凭据 {refs} 的值已被覆盖更新并继续保留。',
  'error.saveFailed': '保存失败，请重试',
  'error.secretWriteFailed': '凭据写入失败：{refs}',
  'error.unexpected': '发生未知错误',
}