import { z } from 'zod'

import { listCachesByRepoId, useDB } from '~/lib/db'
import { useStorageAdapter } from '~/lib/storage'

const queryParamSchema = z.object({
  repo_id: z.string().min(1),
})

/**
 * GET /internal/caches?repo_id=<repo_id>
 *
 * List all caches for a given repository.
 * No JWT authentication required - for internal network use only.
 */
export default defineEventHandler(async (event) => {
  const parsedQuery = queryParamSchema.safeParse(getQuery(event))
  if (!parsedQuery.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid query parameters: ${parsedQuery.error.message}`,
    })

  const { repo_id: repoId } = parsedQuery.data

  const db = await useDB()
  const adapter = await useStorageAdapter()
  const caches = await listCachesByRepoId(db, repoId)

  const cachesWithUrls = await Promise.all(
    caches.map(async (cache) => ({
      id: cache.id,
      key: cache.key,
      version: cache.version,
      repoId: cache.repo_id,
      branchRef: cache.branch_ref,
      updatedAt: cache.updated_at,
      accessedAt: cache.accessed_at,
      sizeInBytes: (await adapter.getCacheFileSize(cache.id)) as unknown as string,
      downloadUrl: await adapter.getDownloadUrl(cache.id),
    })),
  )

  return {
    totalCount: caches.length,
    caches: cachesWithUrls,
  }
})

