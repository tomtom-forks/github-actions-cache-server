import { z } from 'zod'

import { listEntriesByKey, useDB } from '~/lib/db'
import { getJWTparams } from '~/lib/utils'

const queryParamSchema = z.object({
  key: z.string().min(1),
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
  const { key } = parsedQuery.data

  const db = await useDB()
  const entries = await listEntriesByKey(db, key, repoId, branchRef)

  return {
    totalCount: entries.length,
    artifactCaches: entries.map((entry) => ({
      cacheKey: entry.key,
      cacheVersion: entry.version,
    })),
  }
})
