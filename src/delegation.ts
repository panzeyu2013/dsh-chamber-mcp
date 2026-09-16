/**
 * Delegation narrowing (host half): the tool narrowing a delegating agent
 * declared for ONE child, folded from that child's own durable descriptor.
 *
 * Upstream contract this module reads (verified against the installed harness,
 * `@deepseek-ai/dsh-subagent`):
 *
 * - every session-backed child is created with `meta.origin === 'subagent'` and
 *   its descriptor is appended to the CHILD's own log as the durable,
 *   model-hidden `subagent/descriptor` session event (the envelope field is
 *   `data`; the FIRST such event is authoritative);
 * - only a `continuable` child carries a `toolFilter` (`{ allow?, deny? }`);
 *   one-shot descriptors have no such field, and the harness re-applies the
 *   persisted filter when a child is resumed — the descriptor IS the authority;
 * - the harness composes the child with `tools.restrict(toolFilter)`, whose
 *   masks gate INHERITED tools only: a registration made into the child's OWN
 *   scope is exempt by design ("scoped registrations remain visible"). This
 *   plugin registers per agent scope, so it mirrors the mask for the names it
 *   would itself register.
 *
 * Deliberate deviation: mirroring makes this plugin STRICTER than the harness's
 * literal view semantics for that one scope. It is what the delegator asked for,
 * and a `toolFilter` cannot name an MCP tool anyway — `tools.restrict()` rejects
 * names that are not known global tools — so in practice a filter either
 * suppresses this plugin's servers entirely (an allow list) or not at all (a
 * deny list that never mentions them).
 *
 * Everything here is pure and total: malformed input yields `unreadable` and
 * never throws, and `admissionOf` admits every name for anything but a folded
 * filter (fail open — the workspace's own explicit enablement stays the gate,
 * and a bookkeeping read must never keep tools away from a live agent).
 *
 * @module
 */

/** Event type the harness appends to a child's own log at creation. */
const DESCRIPTOR_EVENT = 'subagent/descriptor'

/** Descriptor format this module understands; other versions are left alone. */
const DESCRIPTOR_VERSION = 3

/**
 * What one child's own log says about narrowing.
 *
 * - `none`: no descriptor (a non-child, or a generation that writes none) or a
 *   descriptor that declares no narrowing (one-shot children) — the normal,
 *   unnarrowed case;
 * - `narrowed`: a folded filter; only names it admits may be registered;
 * - `unreadable`: a descriptor this module cannot turn into a decision — a
 *   newer format or a malformed payload. The caller logs it and proceeds
 *   unnarrowed.
 */
export type DelegationNarrowing =
  | { kind: 'none' }
  | { kind: 'narrowed'; allow?: readonly string[]; deny?: readonly string[] }
  | { kind: 'unreadable'; reason: string }

/** Narrowing that admits every name (the fail-open value). */
const NONE: DelegationNarrowing = Object.freeze({ kind: 'none' })

/**
 * Fold the narrowing out of a child's OWN events.
 *
 * The caller passes only the child's own event window (from the session's
 * `inheritedEventCount`): a seeded fork inherits its parent's prefix in the same
 * log, and a nested parent's descriptor must never be mistaken for this child's.
 * Scanning stops at the first descriptor, mirroring the harness's own fold.
 *
 * @param events - the child's own session events, oldest first.
 * @returns the folded narrowing; never throws.
 */
export function readDelegationNarrowing(events: readonly unknown[]): DelegationNarrowing {
  if (!Array.isArray(events)) return NONE
  for (const event of events) {
    if (!isRecord(event) || event.type !== DESCRIPTOR_EVENT) continue
    const descriptor = event.data
    if (!isRecord(descriptor)) return { kind: 'unreadable', reason: 'descriptor payload is not an object' }
    const version: unknown = descriptor.version
    if (version !== DESCRIPTOR_VERSION) {
      return { kind: 'unreadable', reason: 'descriptor version ' + String(version) + ' is not ' + String(DESCRIPTOR_VERSION) }
    }
    if (!Object.hasOwn(descriptor, 'toolFilter')) return NONE
    const filter = descriptor.toolFilter
    if (!isRecord(filter)) return { kind: 'unreadable', reason: 'toolFilter is not an object' }
    const allow = readNames(filter.allow, 'allow')
    const deny = readNames(filter.deny, 'deny')
    if (typeof allow === 'string') return { kind: 'unreadable', reason: allow }
    if (typeof deny === 'string') return { kind: 'unreadable', reason: deny }
    if (allow === undefined && deny === undefined) {
      return { kind: 'unreadable', reason: 'toolFilter declares neither allow nor deny' }
    }
    return {
      kind: 'narrowed',
      ...(allow === undefined ? {} : { allow }),
      ...(deny === undefined ? {} : { deny }),
    }
  }
  return NONE
}

/**
 * Admission for one folded narrowing: the same math `dsh-tools` applies when it
 * decides whether a scope's masks admit an INHERITED global name (`allow` keeps
 * only what it lists, `deny` removes what it lists, and every filter in force
 * must admit). Multiple filters would AND here; a single delegation filter is
 * what the harness installs today.
 *
 * @param narrowing - the folded narrowing.
 * @returns a predicate over a public tool name; total, never throws.
 */
export function admissionOf(narrowing: DelegationNarrowing): (name: string) => boolean {
  if (narrowing.kind !== 'narrowed') return () => true
  const allow = narrowing.allow === undefined ? undefined : new Set(narrowing.allow)
  const deny = narrowing.deny === undefined ? undefined : new Set(narrowing.deny)
  return (name: string): boolean =>
    (allow === undefined || allow.has(name)) && (deny === undefined || !deny.has(name))
}

/** Whether a value is a plain record (arrays and null are not). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one optional string-array field.
 *
 * @param value - the raw field.
 * @param field - its name, for the failure text.
 * @returns the strings, `undefined` when absent, or a failure message string.
 */
function readNames(value: unknown, field: string): readonly string[] | undefined | string {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return 'toolFilter.' + field + ' is not an array'
  for (const item of value) {
    if (typeof item !== 'string') return 'toolFilter.' + field + ' contains a non-string'
  }
  return value as readonly string[]
}
