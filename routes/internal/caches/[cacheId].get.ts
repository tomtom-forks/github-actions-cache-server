import { getCacheById, useDB } from '~/lib/db'
import { useStorageAdapter } from '~/lib/storage'

/**
 * GET /internal/caches/:cacheId
 *
 * Get a cache by its ID.
 * No JWT authentication required - for internal network use only.
 */
export default defineEventHandler(async (event) => {
  const cacheId = getRouterParam(event, 'cacheId')

  if (!cacheId)
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing cacheId parameter',
    })

  const db = await useDB()
  const cache = await getCacheById(db, cacheId)

  if (!cache) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Cache not found',
    })
  }

  const adapter = await useStorageAdapter()
  const sizeInBytes = await adapter.getCacheFileSize(cacheId)
  const downloadUrl = await adapter.getDownloadUrl(cacheId)

  return {
    id: cache.id,
    key: cache.key,
    version: cache.version,
    repoId: cache.repo_id,
    branchRef: cache.branch_ref,
    updatedAt: cache.updated_at,
    accessedAt: cache.accessed_at,
    sizeInBytes,
    downloadUrl,
  }
})

