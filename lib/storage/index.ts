import type { Buffer } from 'node:buffer'

import type { CacheFileName } from './storage-driver'

import cluster from 'node:cluster'
import { randomBytes, randomInt } from 'node:crypto'
import { createSingletonPromise } from '@antfu/utils'

import {
  deleteCacheById,
  findKeyMatch,
  findStaleKeys,
  getCacheById,
  getUpload,
  pruneKeys,
  touchKey,
  updateOrCreateKey,
  useDB,
} from '~/lib/db'

import { ENV } from '~/lib/env'
import { logger } from '~/lib/logger'
import { getStorageDriver } from '~/lib/storage/drivers'
import { getCacheFileName } from '~/lib/utils'

export const useStorageAdapter = createSingletonPromise(async () => {
  try {
    const driverName = ENV.STORAGE_DRIVER
    const driverClass = getStorageDriver(driverName)
    if (!driverClass) {
      logger.error(`No storage driver found for ${driverName}`)
      // eslint-disable-next-line unicorn/no-process-exit
      process.exit(1)
    }
    if (cluster.isPrimary) logger.info(`Using storage driver: ${driverName}`)

    const driver = await driverClass.create()
    const db = await useDB()

    return {
      driver,
      async reserveCache({
        key,
        version,
        repoId,
        branchRef,
      }: {
        key: string
        version: string
        repoId: string
        branchRef: string
      }) {
        logger.debug('Reserve:', { key, version, repoId, branchRef })

        if (await getUpload(db, { key, version, repoId, branchRef })) {
          logger.debug(`Reserve: Already reserved. Ignoring...`, { key, version })
          return {
            cacheId: null,
          }
        }

        const uploadId = randomInt(1_000_000_000, 9_999_999_999)

        await db
          .insertInto('uploads')
          .values({
            created_at: new Date().toISOString(),
            id: uploadId.toString(),
            key,
            version,
            repo_id: repoId,
            branch_ref: branchRef,
          })
          .execute()

        logger.debug(`Reserve:`, {
          key,
          version,
          uploadId,
        })

        return {
          cacheId: uploadId,
        }
      },
      async uploadChunk({
        uploadId,
        chunkStream,
        chunkStart,
        chunkIndex,
      }: {
        uploadId: number
        chunkStream: ReadableStream<Buffer>
        chunkStart: number
        chunkIndex: number
      }) {
        const upload = await db
          .selectFrom('uploads')
          .selectAll()
          .where('id', '=', uploadId.toString())
          .executeTakeFirst()
        if (!upload) {
          logger.debug(`Upload: Upload not found. Ignoring...`, {
            uploadId,
          })
          return
        }

        const partNumber = chunkIndex + 1

        try {
          await driver.uploadPart({
            uploadId: upload.id,
            partNumber,
            data: chunkStream,
          })
          await db
            .insertInto('upload_parts')
            .values({
              part_number: partNumber,
              upload_id: uploadId.toString(),
            })
            .execute()
        } catch (err) {
          logger.debug(
            'Upload: Error',
            {
              uploadId,
              chunkStart,
              partNumber,
            },
            err,
          )
          throw err
        }

        logger.debug('Upload:', { uploadId, chunkStart, partNumber })
      },
      async commitCache(uploadId: number | string) {
        const upload = await db
          .selectFrom('uploads')
          .selectAll()
          .where('id', '=', uploadId.toString())
          .executeTakeFirst()

        if (!upload) {
          logger.debug('Commit: Upload not found. Ignoring...')
          return
        }

        const parts = await db
          .selectFrom('upload_parts')
          .selectAll()
          .where('upload_id', '=', upload.id)
          .orderBy('part_number', 'asc')
          .execute()

        await db.transaction().execute(async (tx) => {
          logger.debug('Commit:', uploadId)

          await tx.deleteFrom('uploads').where('id', '=', upload.id).execute()
          await updateOrCreateKey(tx, {
            key: upload.key,
            version: upload.version,
            repoId: upload.repo_id,
            branchRef: upload.branch_ref,
          })

          await driver.completeMultipartUpload({
            cacheFileName: getCacheFileName(
              upload.key,
              upload.version,
              upload.repo_id,
              upload.branch_ref,
            ),
            uploadId: upload.id,
            partNumbers: parts.map((part) => part.part_number),
          })
        })
      },
      async getCacheEntry({
        keys,
        version,
        repoId,
        branchRef,
      }: {
        keys: string[]
        version: string
        repoId: string
        branchRef: string
      }) {
        const primaryKey = keys[0]
        const restoreKeys = keys.length > 1 ? keys.slice(1) : undefined

        const cacheKey = await findKeyMatch(db, {
          key: primaryKey,
          version,
          restoreKeys,
          repoId,
          branchRef,
        })

        if (!cacheKey) {
          logger.debug('Get: Cache entry not found', { keys, version, repoId, branchRef })
          return null
        }

        await touchKey(db, {
          key: cacheKey.key,
          version: cacheKey.version,
          repoId: cacheKey.repo_id,
          branchRef: cacheKey.branch_ref,
        })

        const cacheFileName = getCacheFileName(
          cacheKey.key,
          cacheKey.version,
          cacheKey.repo_id,
          cacheKey.branch_ref,
        )

        logger.debug('Get: Found', cacheKey)

        return {
          archiveLocation:
            ENV.ENABLE_DIRECT_DOWNLOADS && driver.createDownloadUrl
              ? await driver.createDownloadUrl(cacheFileName)
              : createLocalDownloadUrl(cacheFileName),
          cacheKey: cacheKey.key,
        }
      },
      async download(cacheFileName: CacheFileName) {
        logger.debug('Download:', cacheFileName)
        return driver.createReadStream(cacheFileName)
      },
      async pruneCaches(olderThanDays?: number) {
        logger.debug('Prune:', {
          olderThanDays,
        })

        const keys = await findStaleKeys(db, { olderThanDays })
        if (keys.length === 0) {
          logger.debug('Prune: No caches to prune')
          return
        }

        await driver.delete(
          keys.map((key) => getCacheFileName(key.key, key.version, key.repo_id, key.branch_ref)),
        )
        await pruneKeys(db, keys)

        logger.debug('Prune: Caches pruned', {
          olderThanDays,
        })
      },
      async pruneUploads(olderThanDate: Date) {
        logger.debug('Prune uploads')

        // uploads older than 24 hours
        const uploads = await db
          .selectFrom('uploads')
          .selectAll()
          .where('created_at', '<', olderThanDate.toISOString())
          .execute()

        for (const upload of uploads) {
          try {
            await driver.cleanupMultipartUpload(upload.id)
            await db.deleteFrom('uploads').where('id', '=', upload.id).execute()
          } catch (err) {
            logger.error('Failed to cleanup upload', upload, err)
          }
        }
      },
      async deleteCacheById(cacheId: string) {
        logger.debug('Delete cache by ID:', cacheId)

        const cache = await getCacheById(db, cacheId)
        if (!cache) {
          logger.debug('Delete: Cache not found', { cacheId })
          return false
        }

        const cacheFileName = getCacheFileName(
          cache.key,
          cache.version,
          cache.repo_id,
          cache.branch_ref,
        )

        try {
          await driver.delete([cacheFileName])
          await deleteCacheById(db, cacheId)
          logger.debug('Delete: Cache deleted', { cacheId })
          return true
        } catch (err) {
          logger.error('Failed to delete cache', { cacheId }, err)
          throw err
        }
      },
      async getCacheFileSize(cacheId: string) {
        logger.debug('Get cache file size:', cacheId)

        const cache = await getCacheById(db, cacheId)
        if (!cache) {
          logger.debug('GetFileSize: Cache not found', { cacheId })
          return null
        }

        const cacheFileName = getCacheFileName(
          cache.key,
          cache.version,
          cache.repo_id,
          cache.branch_ref,
        )

        if (driver.getFileSize) {
          return driver.getFileSize(cacheFileName)
        } else {
          logger.debug('GetFileSize: Driver does not support getFileSize', { cacheId })
        }

        return null
      },
      async getDownloadUrl(cacheId: string) {
        logger.debug('Get download URL:', cacheId)

        const cache = await getCacheById(db, cacheId)
        if (!cache) {
          logger.debug('GetDownloadUrl: Cache not found', { cacheId })
          return null
        }

        const cacheFileName = getCacheFileName(
          cache.key,
          cache.version,
          cache.repo_id,
          cache.branch_ref,
        )

        return ENV.ENABLE_DIRECT_DOWNLOADS && driver.createDownloadUrl
          ? await driver.createDownloadUrl(cacheFileName)
          : createLocalDownloadUrl(cacheFileName)
      },
    }
  } catch (err) {
    logger.error('Failed to initialize storage driver:', err)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
})

function createLocalDownloadUrl(cacheFileName: CacheFileName) {
  return `${ENV.API_BASE_URL}/download/${randomBytes(64).toString('hex')}/${cacheFileName}`
}

