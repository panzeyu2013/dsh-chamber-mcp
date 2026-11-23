/**
 * In-process fake MCP authorization server + MCP streamable-HTTP endpoint for
 * the OAuth host acceptance suite.
 *
 * One loopback HTTP origin plays all four roles the official browser flow
 * talks to, so a test can run the REAL `McpOAuthAuthorization` end to end
 * without network stubs:
 *
 * - **protected resource** (`GET/POST /mcp`) — answers 401 with a
 *   `WWW-Authenticate: Bearer resource_metadata=…` challenge until a valid
 *   bearer token is presented, then speaks just enough MCP JSON-RPC
 *   (initialize / notifications/initialized / tools/list / ping) for a mounted
 *   official instance to reach `connected`;
 * - **resource metadata** (`/.well-known/oauth-protected-resource`);
 * - **authorization server metadata** (`/.well-known/oauth-authorization-server`)
 *   plus dynamic client registration (`POST /register`);
 * - **consent + token** — `simulateConsent(authorizationUrl)` allocates an
 *   authorization code bound to the request's S256 challenge and redirect URI
 *   and returns the redirect the browser would follow; `POST /token` enforces
 *   PKCE S256 and rotates refresh tokens on every refresh.
 *
 * The fixture never validates a bearer token cryptographically (they are opaque
 * strings it minted); it only checks membership. Everything it observed is
 * exposed on `state` for assertions, and `close()` tears down the listener
 * including any open server-sent-events response.
 *
 * @module
 */

import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'

/** Base64url encoding of one value (PKCE's S256 representation). */
const base64url = (value) => Buffer.from(value).toString('base64url')

/** SHA-256 hex digest of one string (callback path + codes). */
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/** Fixed client name the upstream flow registers itself under. */
const CLIENT_NAME = 'DeepSeek Harness'

/** Initial protocol version the fake MCP endpoint falls back to. */
const FALLBACK_PROTOCOL_VERSION = '2025-06-18'

/** Lifetime of every minted access token (the flow never needs a refresh race). */
const ACCESS_TOKEN_LIFETIME_MS = 3_600_000

/**
 * One tool the fake MCP endpoint advertises (a minimal valid definition).
 */
const FAKE_TOOLS = [
  {
    name: 'echo',
    description: 'Echo the input back',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

/**
 * Start the combined fake authorization server / MCP endpoint.
 *
 * @returns the fixture handle: origin, resource URL, observed state, the
 *   consent simulation, and a close function.
 */
export async function startOAuthServer() {
  const state = {
    /** Dynamic client registrations (0 when a pre-registered clientId is used). */
    registrations: 0,
    /** Last registration request body (host-side assertion material only). */
    lastRegistration: undefined,
    /** Query parameters of every simulated browser authorization request. */
    authorizationRequests: [],
    /** Parsed form bodies of every /token request. */
    tokenRequests: [],
    /** Refresh-token exchanges served (rotation proof). */
    refreshCalls: 0,
    /** Whether the PKCE S256 challenge of the latest code exchange matched. */
    verifierChecked: false,
    /** Accepted-then-replayed authorization codes (replay probe). */
    replayedCodes: 0,
    /** JSON-RPC methods the fake MCP endpoint served, in order. */
    mcpCalls: [],
    /** Every bearer token the fake MCP endpoint accepted. */
    acceptedTokens: new Set(),
    /** Authorization codes minted so far. */
    codesMinted: 0,
  }
  /** code → { challenge, redirectUri, clientId, scope }. */
  const codes = new Map()
  /** access token → expiresAt epoch ms. */
  const accessTokens = new Map()
  /** Current refresh token (rotation: one live token per grant). */
  let refreshToken
  /** Monotonic token counter (access-1, refresh-1, access-2, …). */
  let tokenSeq = 0
  /** Open server-sent-events responses, torn down by close(). */
  const streams = new Set()
  let origin
  let resourceUrl

  const sendJson = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }

  /** Mint one token pair; rotation invalidates the previous refresh token. */
  const mintTokens = () => {
    tokenSeq += 1
    const accessToken = 'access-' + tokenSeq
    refreshToken = 'refresh-' + tokenSeq
    accessTokens.set(accessToken, Date.now() + ACCESS_TOKEN_LIFETIME_MS)
    state.acceptedTokens.add(accessToken)
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_LIFETIME_MS / 1000),
      refresh_token: refreshToken,
      scope: 'mcp',
    }
  }

  /** The bearer token of a request, or undefined. */
  const bearerOf = (req) => {
    const header = req.headers.authorization ?? ''
    return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
  }

  /** Whether a request carries a currently valid bearer token. */
  const authorized = (req) => {
    const token = bearerOf(req)
    if (token === undefined) return false
    const expiresAt = accessTokens.get(token)
    return expiresAt !== undefined && expiresAt > Date.now()
  }

  /** The 401 challenge every unauthenticated request receives. */
  const challenge = (res) => {
    sendJson(res, 401, { error: 'unauthorized' }, {
      'www-authenticate': 'Bearer resource_metadata="' + origin + '/.well-known/oauth-protected-resource", scope="mcp"',
    })
  }

  /** Answer one JSON-RPC message (requests get a result; notifications 202). */
  const answerMcp = (res, message) => {
    state.mcpCalls.push(message.method)
    if (message.id === undefined) {
      res.writeHead(202)
      res.end()
      return
    }
    let result
    switch (message.method) {
      case 'server/discover':
        // Protocol-revision negotiation probe of the 2.4 SDK: advertise one
        // revision and the tools capability so the client lists tools.
        result = { supportedVersions: [FALLBACK_PROTOCOL_VERSION], capabilities: { tools: {} } }
        break
      case 'initialize':
        result = {
          protocolVersion: message.params?.protocolVersion ?? FALLBACK_PROTOCOL_VERSION,
          // The tools capability is what makes the bridge call tools/list.
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-oauth-mcp', version: '1.0.0' },
        }
        break
      case 'ping':
        result = {}
        break
      case 'tools/list':
        result = { tools: FAKE_TOOLS }
        break
      default:
        sendJson(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } })
        return
    }
    sendJson(res, 200, { jsonrpc: '2.0', id: message.id, result })
  }

  /** The redirect the browser would follow after the human consented. */
  const redirectFor = (authorizationUrl, errorCode) => {
    const url = new URL(String(authorizationUrl))
    const redirectUri = url.searchParams.get('redirect_uri')
    const stateParam = url.searchParams.get('state')
    if (redirectUri === null || stateParam === null) throw new Error('fake AS: authorization request is missing redirect_uri/state')
    state.authorizationRequests.push(Object.fromEntries(url.searchParams))
    if (errorCode !== undefined) {
      const denied = new URL(redirectUri)
      denied.searchParams.set('error', errorCode)
      denied.searchParams.set('state', stateParam)
      return denied
    }
    if (url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('fake AS: PKCE S256 is required')
    state.codesMinted += 1
    const code = 'code-' + state.codesMinted + '-' + randomBytes(6).toString('hex')
    codes.set(code, {
      challenge: url.searchParams.get('code_challenge'),
      redirectUri,
      clientId: url.searchParams.get('client_id'),
      scope: url.searchParams.get('scope'),
    })
    const redirect = new URL(redirectUri)
    redirect.searchParams.set('code', code)
    redirect.searchParams.set('state', stateParam)
    return redirect
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake.invalid')
    switch (url.pathname) {
      case '/.well-known/oauth-protected-resource':
        return sendJson(res, 200, { resource: resourceUrl, authorization_servers: [origin] })
      case '/.well-known/oauth-authorization-server':
        return sendJson(res, 200, {
          issuer: origin,
          authorization_endpoint: origin + '/authorize',
          token_endpoint: origin + '/token',
          registration_endpoint: origin + '/register',
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['mcp'],
        })
      case '/register': {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
        let body = ''
        for await (const chunk of req) body += chunk
        state.registrations += 1
        state.lastRegistration = JSON.parse(body)
        return sendJson(res, 200, {
          client_id: 'fake-client-' + state.registrations,
          client_name: CLIENT_NAME,
          redirect_uris: state.lastRegistration.redirect_uris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        })
      }
      case '/authorize': {
        // The real browser step: consent is simulated by the fixture helper, so
        // this endpoint only redirects (no human UI exists in a unit test).
        const redirect = redirectFor(url)
        res.writeHead(302, { location: redirect.href })
        return res.end()
      }
      case '/token': {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
        let body = ''
        for await (const chunk of req) body += chunk
        const params = new URLSearchParams(body)
        const exchange = Object.fromEntries(params)
        state.tokenRequests.push(exchange)
        if (params.get('grant_type') === 'authorization_code') {
          const code = params.get('code') ?? ''
          const entry = codes.get(code)
          if (entry === undefined) {
            state.replayedCodes += 1
            return sendJson(res, 400, { error: 'invalid_grant' })
          }
          const verifier = params.get('code_verifier') ?? ''
          state.verifierChecked = base64url(createHash('sha256').update(verifier).digest()) === entry.challenge
          if (!state.verifierChecked || params.get('redirect_uri') !== entry.redirectUri) {
            return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE or redirect mismatch' })
          }
          codes.delete(code)
          return sendJson(res, 200, mintTokens())
        }
        if (params.get('grant_type') === 'refresh_token') {
          state.refreshCalls += 1
          if (params.get('refresh_token') !== refreshToken) return sendJson(res, 400, { error: 'invalid_grant' })
          return sendJson(res, 200, mintTokens())
        }
        return sendJson(res, 400, { error: 'unsupported_grant_type' })
      }
      case '/mcp': {
        if (!authorized(req)) {
          // The OAuth flow's discovery probe reads this challenge; an instance
          // without a grant never reaches here (it fails before the transport).
          return challenge(res)
        }
        if (req.method === 'GET') {
          // The streamable-HTTP client opens one server-initiated SSE stream on
          // start; keep it open until close() (no server messages are sent).
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          res.write(': fake-as stream\n\n')
          streams.add(res)
          req.on('close', () => {
            streams.delete(res)
          })
          return
        }
        if (req.method === 'DELETE') {
          res.writeHead(200)
          return res.end()
        }
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
        let body = ''
        for await (const chunk of req) body += chunk
        let message
        try {
          message = JSON.parse(body)
        } catch {
          return sendJson(res, 400, { error: 'invalid_json' })
        }
        return answerMcp(res, message)
      }
      default:
        return sendJson(res, 404, { error: 'not_found' })
    }
  })
  server.on('clientError', (_error, socket) => {
    socket.destroy()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake AS: no loopback port')
  origin = 'http://127.0.0.1:' + address.port
  resourceUrl = origin + '/mcp'
  state.origin = origin
  state.resourceUrl = resourceUrl

  return {
    origin,
    resourceUrl,
    state,
    /** Simulate the human consenting: returns the callback redirect to dispatch. */
    simulateConsent(authorizationUrl) {
      return redirectFor(authorizationUrl)
    },
    /** Simulate the human denying: returns the callback redirect carrying error. */
    simulateDenial(authorizationUrl, errorCode = 'access_denied') {
      return redirectFor(authorizationUrl, errorCode)
    },
    /** Whether one access token is still accepted by the fake MCP endpoint. */
    acceptsToken(token) {
      return accessTokens.has(token) && accessTokens.get(token) > Date.now()
    },
    async close() {
      for (const stream of streams) {
        try {
          stream.end()
        } catch {
          // Already closed.
        }
      }
      streams.clear()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
