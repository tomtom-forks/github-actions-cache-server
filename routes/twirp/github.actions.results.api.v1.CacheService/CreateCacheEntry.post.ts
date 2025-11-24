import { z } from 'zod'
import { ENV } from '~/lib/env'
import { useStorageAdapter } from '~/lib/storage'
import { getJWTparams } from '~/lib/utils'

const bodySchema = z.object({
  key: z.string(),
  version: z.string(),
})

export default defineEventHandler(async (event) => {
  const body = (await readBody(event)) as unknown
  const parsedBody = bodySchema.safeParse(body)
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
  const { key, version } = parsedBody.data

  const adapter = await useStorageAdapter()
  const reservation = await adapter.reserveCache({ key, version, repoId, branchRef })
  if (!reservation.cacheId)
    return {
      ok: false,
    }

  return {
    ok: true,
    signed_upload_url: `${ENV.API_BASE_URL}/upload/${reservation.cacheId}`,
  }
})
