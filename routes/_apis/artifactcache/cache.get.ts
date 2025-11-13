import { z } from 'zod'

import { useStorageAdapter } from '~/lib/storage'
import { getJWTparams } from '~/lib/utils'

const queryParamSchema = z.object({
  keys: z
    .string()
    .min(1)
    .transform((value) => value.split(',')),
  version: z.string().min(1),
})

export default defineEventHandler(async (event) => {
  const parsedQuery = queryParamSchema.safeParse(getQuery(event))
  if (!parsedQuery.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid query parameters: ${parsedQuery.error.message}`,
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
  const { keys, version } = parsedQuery.data

  const adapter = await useStorageAdapter()
  const storageEntry = await adapter.getCacheEntry({ keys, version, repoId, branchRef })

  if (!storageEntry) {
    setResponseStatus(event, 204)
    return
  }

  return storageEntry
})
