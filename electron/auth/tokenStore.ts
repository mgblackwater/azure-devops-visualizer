import { app, safeStorage } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AdoConnectionInfo, AdoIdentity } from '@shared/adoTypes'

/**
 * Persists the Azure DevOps PAT and organization URL on disk.
 * The PAT is encrypted via Electron's safeStorage (OS keychain on macOS,
 * DPAPI on Windows, libsecret on Linux). The organization URL and a flag
 * are stored in plain JSON next to it.
 */

interface VaultMeta {
  organizationUrl: string
  authenticatedUser?: AdoIdentity
  /** ISO timestamp of last successful test. */
  lastVerifiedAt?: string
}

let cachedToken: string | null = null
let cachedMeta: VaultMeta | null = null
let initialized = false

const listeners = new Set<(info: AdoConnectionInfo) => void>()

function vaultDir(): string {
  return app.getPath('userData')
}

function tokenPath(): string {
  return path.join(vaultDir(), 'pat.bin')
}

function metaPath(): string {
  return path.join(vaultDir(), 'connection.json')
}

async function loadFromDisk(): Promise<void> {
  if (initialized) return
  initialized = true
  try {
    const raw = await fs.readFile(metaPath(), 'utf8')
    cachedMeta = JSON.parse(raw) as VaultMeta
  } catch {
    cachedMeta = null
  }
  try {
    const enc = await fs.readFile(tokenPath())
    if (safeStorage.isEncryptionAvailable()) {
      cachedToken = safeStorage.decryptString(enc)
    } else {
      cachedToken = null
    }
  } catch {
    cachedToken = null
  }
}

function emitChanged(): void {
  const info = currentInfo()
  for (const fn of listeners) {
    try {
      fn(info)
    } catch {
      /* swallow listener errors */
    }
  }
}

function currentInfo(): AdoConnectionInfo {
  return {
    organizationUrl: cachedMeta?.organizationUrl ?? '',
    hasToken: !!cachedToken && !!cachedMeta?.organizationUrl,
    authenticatedUser: cachedMeta?.authenticatedUser
  }
}

export async function getConnectionInfo(): Promise<AdoConnectionInfo> {
  await loadFromDisk()
  return currentInfo()
}

export async function getStoredToken(): Promise<string | null> {
  await loadFromDisk()
  return cachedToken
}

export async function getStoredOrganizationUrl(): Promise<string | null> {
  await loadFromDisk()
  return cachedMeta?.organizationUrl ?? null
}

export async function setConnection(
  organizationUrl: string,
  token: string,
  authenticatedUser?: AdoIdentity
): Promise<AdoConnectionInfo> {
  await loadFromDisk()

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS-level encryption is not available; refusing to store the PAT in plain text.'
    )
  }

  const trimmedUrl = organizationUrl.replace(/\/+$/, '')
  cachedMeta = {
    organizationUrl: trimmedUrl,
    authenticatedUser,
    lastVerifiedAt: new Date().toISOString()
  }
  cachedToken = token

  await fs.mkdir(vaultDir(), { recursive: true })
  const encrypted = safeStorage.encryptString(token)
  await fs.writeFile(tokenPath(), encrypted, { mode: 0o600 })
  await fs.writeFile(metaPath(), JSON.stringify(cachedMeta, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  })

  emitChanged()
  return currentInfo()
}

export async function clearConnection(): Promise<void> {
  await loadFromDisk()
  cachedToken = null
  cachedMeta = null
  await Promise.allSettled([fs.rm(tokenPath(), { force: true }), fs.rm(metaPath(), { force: true })])
  emitChanged()
}

export function onConnectionChanged(handler: (info: AdoConnectionInfo) => void): () => void {
  listeners.add(handler)
  return () => listeners.delete(handler)
}
