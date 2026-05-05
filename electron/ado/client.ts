import { net } from 'electron'
import type { IpcError } from '@shared/adoTypes'
import { getStoredOrganizationUrl, getStoredToken } from '../auth/tokenStore'

/**
 * Thin Azure DevOps REST wrapper.
 *
 * - Uses Electron's `net` module so requests respect system proxies and don't
 *   hit Chromium CORS.
 * - Adds `api-version` automatically when callers omit it.
 * - In-memory TTL cache for safe, idempotent GETs.
 * - Retries transient 429/5xx with exponential backoff.
 */

const DEFAULT_API_VERSION = '7.1'
const DEFAULT_TTL_MS = 30_000
const MAX_RETRIES = 3

export interface AdoRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** Path beginning with '/'. May or may not start with '/_apis'. */
  path: string
  /** Override base URL. Defaults to stored organization URL. */
  baseUrl?: string
  /** Force a specific PAT (used by connection probe before storing). */
  token?: string
  /** Query params; primitives are stringified. Adds api-version automatically. */
  query?: Record<string, string | number | boolean | undefined | null>
  /** JSON-serializable body. */
  body?: unknown
  /** Override Content-Type (e.g. 'application/json-patch+json'). */
  contentType?: string
  /** Override default api-version. */
  apiVersion?: string
  /** Cache TTL for GETs. Pass 0 to bypass cache. */
  cacheTtlMs?: number
  /** Cache key override (rare). */
  cacheKey?: string
}

export interface AdoErrorPayload {
  $id?: string
  innerException?: unknown
  message?: string
  typeName?: string
  typeKey?: string
  errorCode?: number
  eventId?: number
}

export class AdoApiError extends Error implements IpcError {
  code: IpcError['code']
  status?: number
  details?: unknown

  constructor(code: IpcError['code'], message: string, status?: number, details?: unknown) {
    super(message)
    this.name = 'AdoApiError'
    this.code = code
    this.status = status
    this.details = details
  }

  toIpc(): IpcError {
    return { code: this.code, message: this.message, status: this.status, details: this.details }
  }
}

interface CacheEntry {
  expiresAt: number
  value: unknown
}

const cache = new Map<string, CacheEntry>()

function buildUrl(base: string, path: string, query?: AdoRequestOptions['query'], apiVersion?: string): string {
  const trimmedBase = base.replace(/\/+$/, '')
  const normalisedPath = path.startsWith('/') ? path : `/${path}`
  const url = new URL(`${trimmedBase}${normalisedPath}`)
  const params = url.searchParams
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue
      params.set(k, String(v))
    }
  }
  if (!params.has('api-version')) {
    params.set('api-version', apiVersion ?? DEFAULT_API_VERSION)
  }
  return url.toString()
}

function authHeader(token: string): string {
  // ADO accepts a PAT as the password with an empty username.
  const encoded = Buffer.from(`:${token}`).toString('base64')
  return `Basic ${encoded}`
}

function isRetriable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface RawResponse {
  status: number
  headers: Record<string, string>
  bodyText: string
}

function performRequest(url: string, init: {
  method: string
  headers: Record<string, string>
  body?: string
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: init.method,
      url,
      redirect: 'follow'
    })
    for (const [k, v] of Object.entries(init.headers)) {
      request.setHeader(k, v)
    }
    request.on('response', (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(response.headers)) {
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v)
        }
        resolve({
          status: response.statusCode,
          headers,
          bodyText: Buffer.concat(chunks).toString('utf8')
        })
      })
      response.on('error', (err: Error) => reject(err))
    })
    request.on('error', (err) => reject(err))
    if (init.body !== undefined) {
      request.write(init.body)
    }
    request.end()
  })
}

function parseError(status: number, bodyText: string, fallback: string): AdoApiError {
  let payload: AdoErrorPayload | undefined
  try {
    payload = bodyText ? (JSON.parse(bodyText) as AdoErrorPayload) : undefined
  } catch {
    payload = undefined
  }
  const message = payload?.message ?? fallback
  let code: IpcError['code'] = 'INTERNAL'
  switch (status) {
    case 400:
      code = 'BAD_REQUEST'
      break
    case 401:
      code = 'UNAUTHORIZED'
      break
    case 403:
      code = 'FORBIDDEN'
      break
    case 404:
      code = 'NOT_FOUND'
      break
    case 409:
      code = 'CONFLICT'
      break
  }
  return new AdoApiError(code, message, status, payload)
}

export async function adoFetch<T>(opts: AdoRequestOptions): Promise<T> {
  const method = opts.method ?? 'GET'
  const baseUrl = opts.baseUrl ?? (await getStoredOrganizationUrl())
  if (!baseUrl) {
    throw new AdoApiError('NOT_AUTHENTICATED', 'No Azure DevOps organization configured.')
  }
  const token = opts.token ?? (await getStoredToken())
  if (!token) {
    throw new AdoApiError('NOT_AUTHENTICATED', 'No PAT configured for Azure DevOps.')
  }

  const url = buildUrl(baseUrl, opts.path, opts.query, opts.apiVersion)

  if (method === 'GET' && opts.cacheTtlMs !== 0) {
    const ttl = opts.cacheTtlMs ?? DEFAULT_TTL_MS
    const key = opts.cacheKey ?? url
    const hit = cache.get(key)
    if (hit && hit.expiresAt > Date.now()) {
      return hit.value as T
    }
    const value = await execute<T>(method, url, opts, token)
    cache.set(key, { value, expiresAt: Date.now() + ttl })
    return value
  }

  if (method !== 'GET') {
    invalidateCacheForPathPrefix(opts.path)
  }
  return execute<T>(method, url, opts, token)
}

async function execute<T>(
  method: string,
  url: string,
  opts: AdoRequestOptions,
  token: string
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: authHeader(token)
  }
  let body: string | undefined
  if (opts.body !== undefined) {
    headers['Content-Type'] = opts.contentType ?? 'application/json'
    body = JSON.stringify(opts.body)
  }

  let attempt = 0
  let lastErr: Error | undefined
  while (attempt <= MAX_RETRIES) {
    try {
      const res = await performRequest(url, { method, headers, body })
      if (res.status >= 200 && res.status < 300) {
        if (!res.bodyText) return undefined as T
        try {
          return JSON.parse(res.bodyText) as T
        } catch {
          return res.bodyText as unknown as T
        }
      }
      if (isRetriable(res.status) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers['retry-after'])
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 250 * Math.pow(2, attempt)
        attempt += 1
        await sleep(wait)
        continue
      }
      throw parseError(res.status, res.bodyText, `${method} ${url} failed (${res.status})`)
    } catch (err) {
      if (err instanceof AdoApiError) throw err
      lastErr = err as Error
      if (attempt < MAX_RETRIES) {
        attempt += 1
        await sleep(250 * Math.pow(2, attempt))
        continue
      }
      throw new AdoApiError('NETWORK', lastErr?.message ?? 'Network error contacting Azure DevOps')
    }
  }
  throw new AdoApiError('NETWORK', lastErr?.message ?? 'Network error contacting Azure DevOps')
}

export function invalidateCacheForPathPrefix(prefix: string): void {
  if (!prefix) {
    cache.clear()
    return
  }
  for (const key of cache.keys()) {
    if (key.includes(prefix)) cache.delete(key)
  }
}

export function clearCache(): void {
  cache.clear()
}

/**
 * Resolve the identity associated with the currently configured PAT (or
 * the one passed in `opts`, used during the initial connection probe).
 *
 * We hit the locator service's `_apis/connectionData` endpoint, which is
 * authenticated, low-cost, and returns the caller's user record without
 * needing the `vso.profile` scope on the PAT (so it works with the
 * minimum-scoped tokens the app advertises).
 *
 * `connectionData` is a long-lived ADO endpoint that historically used
 * `api-version=1.0`. Newer versions (7.x) work for cloud DevOps but
 * sometimes 400 on Azure DevOps Server installs, so we pin 1.0 here for
 * the widest compatibility — every other call still uses the modern 7.1
 * default. We pass `connectOptions=none` to keep the response payload
 * tiny; we only need the user record.
 *
 * Returns `null` when the endpoint declines to identify the caller —
 * e.g. against an on-prem Azure DevOps Server with auth disabled, or
 * when the network request fails — so the UI can fall back gracefully
 * without throwing.
 */
export async function getAuthenticatedIdentity(opts?: {
  organizationUrl?: string
  token?: string
}): Promise<{
  displayName: string
  id?: string
  uniqueName?: string
  descriptor?: string
} | null> {
  interface ConnectionDataResponse {
    authenticatedUser?: ConnectionDataUser
    authorizedUser?: ConnectionDataUser
  }
  interface ConnectionDataUser {
    id?: string
    providerDisplayName?: string
    customDisplayName?: string
    /** Common on cloud DevOps; falls back to provider/custom names. */
    displayName?: string
    /** Email address — most reliable for `uniqueName`. */
    mailAddress?: string
    /** AAD principal name on cloud DevOps. */
    principalName?: string
    subjectDescriptor?: string
    properties?: {
      Account?: { $value?: string }
    }
  }
  try {
    const data = await adoFetch<ConnectionDataResponse>({
      method: 'GET',
      path: '/_apis/connectionData',
      baseUrl: opts?.organizationUrl,
      token: opts?.token,
      apiVersion: '1.0',
      query: { connectOptions: 'none' },
      cacheTtlMs: 0
    })
    const u = data.authenticatedUser ?? data.authorizedUser
    if (!u) {
      console.warn(
        '[ado/identity] connectionData returned no user; mentions filter will be unavailable'
      )
      return null
    }
    const displayName =
      u.customDisplayName ||
      u.displayName ||
      u.providerDisplayName ||
      u.mailAddress ||
      u.principalName ||
      u.properties?.Account?.$value ||
      'Unknown user'
    return {
      displayName,
      id: u.id,
      uniqueName:
        u.mailAddress ||
        u.principalName ||
        u.properties?.Account?.$value,
      descriptor: u.subjectDescriptor
    }
  } catch (err) {
    // Don't let identity resolution failures break the connection flow —
    // the app remains functional without it; only "Mentions me" needs
    // the display name and it surfaces a manual retry. Log so dev users
    // can diagnose; tightly-scoped PATs and offline networks are the
    // most common reasons this fails.
    console.warn(
      '[ado/identity] failed to resolve authenticated user:',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}
