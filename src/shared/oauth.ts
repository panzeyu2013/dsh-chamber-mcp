/**
 * Browser-safe OAuth wire vocabulary shared by the host projection and the
 * settings UI.
 *
 * **No runtime imports — on purpose.** The browser bundle may only require
 * react, so every module reachable from `src/client/index.ts` must have no
 * runtime dependency. This module imports only TYPES (erased at compile time)
 * from the frozen wire contract (`./wire.js`); the host adds upstream data, the
 * browser renders it.
 *
 * Boundary rules (the same redaction contract as `./wire.ts`):
 * - an attempt view is token-free by construction: no access token, refresh
 *   token, client secret or PKCE verifier can reach it;
 * - upstream diagnostic text never crosses the wire — a failed attempt carries
 *   one member of the fixed {@link OAuthAttemptFailure} enum instead;
 * - the authorization URL is published only while the attempt actually waits
 *   for the browser, and only for HTTPS or loopback HTTP (the same rule the
 *   official host applies to OAuth requests).
 *
 * @module
 */

import type {
  RuntimeAuthorizationFailure,
  RuntimeAuthorizationPhase,
  RuntimeAuthorizationReason,
  RuntimeAuthorizationView,
} from './wire.js'

/**
 * Why a passive OAuth connection waits for explicit authorization: the five
 * fixed reasons of the upstream status (never a message).
 */
export type OAuthReason = RuntimeAuthorizationReason

/** Observable phases of one browser authorization attempt. */
export type OAuthAttemptPhase = RuntimeAuthorizationPhase

/**
 * Fixed failure identity of a `failed` attempt: `timeout` (the through-browser
 * deadline elapsed), `cleanup` (attempt cleanup did not confirm), `rejected`
 * (the server or authorization server refused the attempt) and `failed`
 * (anything else). The upstream failure text is matched against a whitelist
 * and NEVER forwarded.
 */
export type OAuthAttemptFailure = RuntimeAuthorizationFailure

/**
 * Token-free authorization attempt view: identity, phase, the authorization
 * page while `waiting-browser`, and a fixed failure identity while `failed`.
 *
 * Alias of the frozen wire's {@link RuntimeAuthorizationView}: the host
 * projection and the action response carry exactly the wire shape.
 */
export interface OAuthAttemptView extends RuntimeAuthorizationView {
  /** Fixed failure identity; present only while `phase === 'failed'`. */
  readonly failure?: OAuthAttemptFailure
}

/**
 * Fixed business failure codes of the three OAuth actions. The route layer maps
 * them to HTTP statuses (409 for not-configured/unavailable/busy, 500 for
 * failed/cleanup); the browser never sees an upstream message.
 */
export type OAuthActionCode =
  | 'oauth-not-configured'
  | 'oauth-unavailable'
  | 'oauth-busy'
  | 'oauth-required'
  | 'oauth-failed'
  | 'oauth-cleanup'
