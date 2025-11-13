import { z } from 'zod'
import { useStorageAdapter } from '~/lib/storage'
import { getJWTparams } from '~/lib/utils'

const bodySchema = z.object({
  key: z.string(),
  restore_keys: z.array(z.string()).nullish().optional(),
  version: z.string(),
})

export default defineEventHandler(async (event) => {
  const parsedBody = bodySchema.safeParse(await readBody(event))
  if (!parsedBody.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid body: ${parsedBody.error.message}`,
    })

  // Get request headers
  const headers = getRequestHeaders(event)

  // Extract JWT token from Authorization header
  const authHeader = headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer '))
    throw createError({
      statusCode: 401,
      statusMessage: 'Missing or invalid Authorization header',
    })

  const { repoId, branchRef } = getJWTparams(authHeader.slice(7))
  const { key, restore_keys, version } = parsedBody.data
  const adapter = await useStorageAdapter()
  const storageEntry = await adapter.getCacheEntry({
    keys: [key, ...(restore_keys ?? [])],
    version,
    repoId,
    branchRef,
  })

  if (!storageEntry)
    return {
      ok: false,
    }

  return {
    ok: true,
    signed_download_url: storageEntry.archiveLocation,
    matched_key: storageEntry.cacheKey,
  }
})
