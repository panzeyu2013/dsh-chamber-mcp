/**
 * Flat bilingual dictionary of the `mcp-scope.settings` locale namespace.
 * One key union; both built-in locales must carry the same key set
 * (compile-enforced at the `ctx.locale.register(NS, { zh, en })` site, and
 * asserted again by tests/client/locales.spec.ts).
 *
 * Template values interpolate `{name}` parameters (locale translate contract).
 */

export const en = {
  // nav / section identity
  nav: 'MCP servers',

  // lifecycle / page-level state
  'state.loading': 'Loading…',
  'state.saving': 'Saving…',
  'state.unavailable': 'MCP server settings are unavailable here (namespace not served to this client or connection is read-only).',
  'state.readonly': 'This document is read-only here; changes cannot be saved.',

  // empty states
  'empty.servers': 'No MCP servers configured yet.',
  'workspaces.empty': 'No workspaces yet',

  // transport names
  'transport.stdio': 'stdio',
  'transport.http': 'Streamable HTTP',

  // server card summary
  'server.envKeys': '{count} env keys',
  'server.headers': '{count} headers',
  'server.offWorkspaces': 'Off in {count} workspaces',
  'server.remove': 'Remove',
  'server.removeConfirmTitle': 'Remove server?',
  'server.removeConfirmBody': 'The server stops everywhere and its configuration is deleted. Credentials that no remaining server references are cleared as well.',
  'server.defaultOn': 'On by default unless turned off here',
  'server.newWorkspaceDefault': 'New workspaces default to on',

  // per-workspace rows
  'row.on': 'On (default)',
  'row.off': 'Off',

  // credential badges / secret controls
  'secret.configured': 'Configured',
  'secret.unset': 'Not configured',
  'secret.clear': 'Clear',
  'secret.clearHint': 'Removes the stored value; the reference stays on the server.',

  // actions
  'action.save': 'Save',
  'action.cancel': 'Cancel',
  'action.confirm': 'Confirm',

  // add-server form
  'add.add': 'Add server',
  'add.title': 'Add MCP server',
  'add.serverName': 'Server name',
  'add.transport': 'Transport',
  'add.command': 'Command',
  'add.args': 'Arguments',
  'add.argAdd': 'Add argument',
  'add.cwd': 'Working directory (optional)',
  'add.url': 'URL (endpoint)',
  'add.envKey': 'Env var / credential key',
  'add.credentialRef': 'Credential ref (env var name)',
  'add.headerName': 'Header name',
  'add.secretValueLabel': 'Value (write-only, never shown again)',
  'add.secretPlaceholder': 'Value',
  'add.envSectionHint': 'These entries are injected as environment variables into the server process.',
  'add.headerSectionHint': 'Headers are sent with each MCP request. Values are write-only: a blank input keeps the stored value.',
  'add.commandUserHint': "This command runs as this dsh instance's user.",
  'add.toolPrefixHint': 'Tools are exposed as mcp__{name}__*',

  // validation messages
  'validation.namePattern': 'Use 1–32 letters, digits, underscores or hyphens',
  'validation.duplicateName': 'A server with this name already exists',
  'validation.commandRequired': 'Command is required',
  'validation.urlRequired': 'URL is required',
  'validation.invalidUrl': 'Invalid URL: must be an http(s) address',
  'validation.refPattern': 'Env-style name: starts with a letter, then letters, digits or underscores',
  'validation.headerNameEmpty': 'Header name must not be empty',
  'validation.envKeyDuplicate': 'Duplicate env key',
  'validation.headerNameDuplicate': 'Duplicate header name',

  // save errors / failures
  'error.conflict': 'The settings were changed elsewhere; review them and try again.',
  'error.saveFailed': 'Save failed, please retry.',
  'error.secretWriteFailed': 'Failed to write credential(s): {refs}',
  'error.unexpected': 'Unexpected error.',
} as const satisfies Record<string, string>

export type SettingsKey = keyof typeof en

/** Dictionary namespace registered by this plugin (`mcp-scope.settings`). */
export const NS = 'mcp-scope.settings'

export const zh: Record<SettingsKey, string> = {
  // nav / section identity
  nav: 'MCP 服务器',

  // lifecycle / page-level state
  'state.loading': '加载中…',
  'state.saving': '保存中…',
  'state.unavailable': 'MCP 服务器设置当前不可用（命名空间未注册到本客户端，或连接为只读）。',
  'state.readonly': '当前文档为只读，无法保存修改。',

  // empty states
  'empty.servers': '尚未配置 MCP 服务器。',
  'workspaces.empty': '暂无 workspace',

  // transport names
  'transport.stdio': 'stdio',
  'transport.http': '流式 HTTP',

  // server card summary
  'server.envKeys': '{count} 个环境变量键',
  'server.headers': '{count} 个请求头',
  'server.offWorkspaces': '在 {count} 个 workspace 中已关闭',
  'server.remove': '移除',
  'server.removeConfirmTitle': '移除服务器？',
  'server.removeConfirmBody': '该服务器将在所有 workspace 停止并删除配置；其余服务器不再引用的凭据也会一并清除。',
  'server.defaultOn': '默认开启，除非在此关闭',
  'server.newWorkspaceDefault': '新 workspace 默认开启',

  // per-workspace rows
  'row.on': '开启（默认）',
  'row.off': '已关闭',

  // credential badges / secret controls
  'secret.configured': '已配置',
  'secret.unset': '未配置',
  'secret.clear': '清除',
  'secret.clearHint': '清除已存值；服务器上的引用保持不变。',

  // actions
  'action.save': '保存',
  'action.cancel': '取消',
  'action.confirm': '确认',

  // add-server form
  'add.add': '添加服务器',
  'add.title': '添加 MCP 服务器',
  'add.serverName': '服务器名称',
  'add.transport': '传输方式',
  'add.command': '命令',
  'add.args': '参数',
  'add.argAdd': '添加参数',
  'add.cwd': '工作目录（可选）',
  'add.url': 'URL（端点）',
  'add.envKey': '环境变量键/凭据键',
  'add.credentialRef': '凭据引用（环境变量名）',
  'add.headerName': '请求头名称',
  'add.secretValueLabel': '值（仅写入，不会再次显示）',
  'add.secretPlaceholder': '值',
  'add.envSectionHint': '以下条目将以环境变量的形式注入该服务器进程。',
  'add.headerSectionHint': '请求头随每次 MCP 请求发送；值仅写入——留空输入框即保留已存值。',
  'add.commandUserHint': '该命令将以此 dsh 实例的用户身份直接执行。',
  'add.toolPrefixHint': '工具将以 mcp__{name}__* 命名',

  // validation messages
  'validation.namePattern': '1–32 位，仅限字母、数字、下划线或连字符',
  'validation.duplicateName': '已存在同名服务器',
  'validation.commandRequired': '请填写命令',
  'validation.urlRequired': '请填写 URL',
  'validation.invalidUrl': 'URL 无效：需为 http(s) 地址',
  'validation.refPattern': '需为环境变量名：字母开头，后可含字母、数字、下划线',
  'validation.headerNameEmpty': '请求头名称不能为空',
  'validation.envKeyDuplicate': '环境变量键重复',
  'validation.headerNameDuplicate': '请求头名称重复',

  // save errors / failures
  'error.conflict': '设置已在别处修改，请复查后重试',
  'error.saveFailed': '保存失败，请重试',
  'error.secretWriteFailed': '凭据写入失败：{refs}',
  'error.unexpected': '发生未知错误',
}
