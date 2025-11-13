import type { CacheFileName } from './storage/storage-driver'
import { hash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ENV } from './env'

export function getCacheFileName(
  key: string,
  version: string,
  repoid: string,
  branchref: string,
): CacheFileName {
  return hash('sha256', Buffer.from(`${key}-${version}-${repoid}-${branchref}`)) as CacheFileName
}

export function createTempDir() {
  return fs.mkdtemp(path.join(ENV.TEMP_DIR, 'github-actions-cache-server'))
}

export function decodeJWT(token: string) {
  // Decode JWT token (base64 decode the payload)
  const [, payloadBase64] = token.split('.')
  if (!payloadBase64)
    throw createError({
      statusCode: 401,
      statusMessage: 'Invalid JWT token format',
    })

  const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'))

  return payload
}

export function getJWTparams(token: string) {
  const decoded = decodeJWT(token)
  const repository_id = decoded.repository_id
  const ac = decoded.ac ? JSON.parse(decoded.ac) : []
  const scope = ac[0]?.Scope || null

  if (!repository_id)
    throw createError({
      statusCode: 401,
      statusMessage: 'Missing repository_id in token',
    })
  return {
    repoId: repository_id as string,
    branchRef: scope as string,
  }
}
