import { useStorageAdapter } from '~/lib/storage'

/**
 * DELETE /internal/caches/:cacheId
 *
 * Delete a cache by its ID.
 * No JWT authentication required - for internal network use only.
 */
export default defineEventHandler(async (event) => {
  const cacheId = getRouterParam(event, 'cacheId')

  if (!cacheId)
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing cacheId parameter',
    })

  const adapter = await useStorageAdapter()
  const deleted = await adapter.deleteCacheById(cacheId)

  if (!deleted) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Cache not found',
    })
  }

  setResponseStatus(event, 200)
  return {
    success: true,
    message: `Cache ${cacheId} deleted successfully`,
  }
})

