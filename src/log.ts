/**
 * Shared host logging surface (host half).
 *
 * ONE logger type for the manager, the per-definition seat, the per-agent
 * applier and the OAuth module (all `ctx.logger`-compatible), plus the ONE
 * control-character sanitizer every host diagnostic goes through before it is
 * logged. Nothing here ever reaches the wire: the status projection carries
 * fixed enums/codes only ({@link ./shared/wire.js}), and an upstream/credential
 * text is classified, never forwarded.
 *
 * @module
 */

/** Host-side logger surface (`ctx.logger`-compatible; never on the wire). */
export interface HostLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Longest diagnostic retained after sanitization (one log line, never the wire). */
const LOG_TEXT_MAX = 300

/**
 * Log-safe one-line text: control characters stripped, length capped. This is
 * the single sanitizer of the host half — it turns multi-line upstream prose and
 * any CR/LF/NUL-bearing value into one bounded line before a logger sees it.
 *
 * @param value - anything (usually an `Error` or a diagnostic string).
 * @param maxLength - optional cap override (defaults to 300 characters).
 * @returns a single line without control characters.
 */
export function sanitizeLogText(value: unknown, maxLength: number = LOG_TEXT_MAX): string {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, maxLength)
}

/**
 * Log-safe error text with the HTTP-status suffix transport errors expose
 * (`error.data.status` / `error.status`). Diagnostics only: the status wire
 * carries a fixed code instead.
 *
 * @param error - the failure to describe.
 * @returns the sanitized one-line description, suffixed with `(HTTP n)` when
 *   the failure carries a numeric HTTP status.
 */
export function safeErrorText(error: unknown): string {
  const status = (error as { data?: { status?: unknown }; status?: unknown } | null | undefined)
  const httpStatus = typeof status?.data?.status === 'number'
    ? status.data.status
    : typeof status?.status === 'number'
      ? status.status
      : undefined
  const suffix = httpStatus === undefined ? '' : ' (HTTP ' + httpStatus + ')'
  return sanitizeLogText(error) + suffix
}
