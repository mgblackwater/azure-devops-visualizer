import { net } from 'electron'
import { AdoApiError } from './client'
import { getStoredOrganizationUrl, getStoredToken } from '../auth/tokenStore'
import type { AttachmentFetchResult } from '@shared/contract'

/**
 * Streams a binary asset (e.g. an inline image embedded in a work-item
 * description) from the configured ADO organisation, using the stored PAT.
 *
 * Why a dedicated path instead of reusing `adoFetch`:
 *   - `adoFetch` JSON-parses the body. Images are binary.
 *   - Images live under `_apis/wit/attachments/{guid}` which requires the
 *     same auth header as the JSON APIs, so we can't just `<img src=>` them.
 *
 * Security:
 *   - The URL must point at the same host as the configured organisation
 *     URL; otherwise we refuse the request. This keeps a hostile renderer
 *     from using us as a credential-bearing proxy.
 */
export async function fetchAttachmentAsBase64(url: string): Promise<AttachmentFetchResult> {
  if (typeof url !== 'string' || !url.trim()) {
    throw new AdoApiError('BAD_REQUEST', 'Missing url')
  }
  const orgUrl = await getStoredOrganizationUrl()
  if (!orgUrl) {
    throw new AdoApiError('NOT_AUTHENTICATED', 'No Azure DevOps organization configured.')
  }
  const token = await getStoredToken()
  if (!token) {
    throw new AdoApiError('NOT_AUTHENTICATED', 'No PAT configured for Azure DevOps.')
  }

  const target = new URL(url)
  const orgHost = new URL(orgUrl).host.toLowerCase()
  if (target.host.toLowerCase() !== orgHost) {
    throw new AdoApiError(
      'FORBIDDEN',
      `Refusing to fetch attachment from ${target.host} (expected ${orgHost}).`
    )
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new AdoApiError('BAD_REQUEST', `Unsupported protocol ${target.protocol}`)
  }

  const auth = `Basic ${Buffer.from(`:${token}`).toString('base64')}`

  return new Promise<AttachmentFetchResult>((resolve, reject) => {
    const request = net.request({ method: 'GET', url: target.toString(), redirect: 'follow' })
    request.setHeader('Authorization', auth)
    // Accept anything - ADO returns image/* for attachments, sometimes
    // application/octet-stream when MIME isn't on the attachment.
    request.setHeader('Accept', '*/*')
    request.on('response', (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(
            new AdoApiError(
              response.statusCode === 401
                ? 'UNAUTHORIZED'
                : response.statusCode === 404
                  ? 'NOT_FOUND'
                  : 'INTERNAL',
              `Attachment fetch failed (${response.statusCode}) for ${target.pathname}`,
              response.statusCode
            )
          )
          return
        }
        const ctRaw = response.headers['content-type']
        const contentType = (
          Array.isArray(ctRaw) ? ctRaw[0] : ctRaw ?? 'application/octet-stream'
        )
          .split(';')[0]
          .trim()
        resolve({
          dataBase64: Buffer.concat(chunks).toString('base64'),
          contentType
        })
      })
      response.on('error', (err: Error) => reject(new AdoApiError('NETWORK', err.message)))
    })
    request.on('error', (err) => reject(new AdoApiError('NETWORK', err.message)))
    request.end()
  })
}
