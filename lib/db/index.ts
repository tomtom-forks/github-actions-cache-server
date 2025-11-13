import type { Selectable } from 'kysely'
import type { DatabaseDriverName } from '~/lib/db/drivers'

import cluster from 'node:cluster'

import { hash } from 'node:crypto'
import { createSingletonPromise } from '@antfu/utils'
import { Kysely, Migrator } from 'kysely'
import { getDatabaseDriver } from '~/lib/db/drivers'
import { migrations } from '~/lib/db/migrations'

import { ENV } from '~/lib/env'
import { logger } from '~/lib/logger'

export interface CacheKeysTable {
  id: string
  key: string
  version: string
  repo_id: string
  branch_ref: string
  updated_at: string
  accessed_at: string
}
export interface UploadsTable {
  created_at: string
  key: string
  version: string
  repo_id: string
  branch_ref: string
  id: string
}
export interface UploadPartsTable {
  upload_id: string
  part_number: number
}

export interface MetaTable {
  key: 'version'
  value: string
}

export interface Database {
  cache_keys: CacheKeysTable
  uploads: UploadsTable
  upload_parts: UploadPartsTable
  meta: MetaTable
}

export const useDB = createSingletonPromise(async () => {
  const driverName = ENV.DB_DRIVER
  const driverSetup = getDatabaseDriver(driverName)
  if (!driverSetup) {
    logger.error(`No database driver found for ${driverName}`)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
  if (cluster.isPrimary) logger.info(`Using database driver: ${driverName}`)

  const driver = await driverSetup()

  const db = new Kysely<Database>({
    dialect: driver,
  })

  if (cluster.isPrimary) {
    logger.info('Migrating database...')
    const migrator = new Migrator({
      db,
      provider: {
        async getMigrations() {
          return migrations(driverName as DatabaseDriverName)
        },
      },
    })
    const { error, results } = await migrator.migrateToLatest()
    if (error) {
      logger.error('Database migration failed', error)
      // eslint-disable-next-line unicorn/no-process-exit
      process.exit(1)
    }
    logger.debug('Migration results', results)
    logger.success('Database migrated')
  }

  return db
})

type DB = Awaited<ReturnType<typeof useDB>>

/**
 * @see https://docs.github.com/en/actions/using-workflows/caching-dependencies-to-speed-up-workflows#matching-a-cache-key
 */
export async function findKeyMatch(
  db: DB,
  args: { key: string; version: string; restoreKeys?: string[]; repoId: string; branchRef: string },
) {
  logger.debug('Finding key match', args)
  const exactPrimaryMatch = await db
    .selectFrom('cache_keys')
    .where('id', '=', getCacheKeyId(args.key, args.version, args.repoId, args.branchRef))
    .selectAll()
    .executeTakeFirst()
  if (exactPrimaryMatch) {
    return exactPrimaryMatch
  }

  logger.debug('No exact primary matches found in requested branch')

  const prefixedPrimaryMatch = await db
    .selectFrom('cache_keys')
    .where('key', 'like', `${args.key}%`)
    .where('version', '=', args.version)
    .where('repo_id', '=', args.repoId)
    .where('branch_ref', '=', args.branchRef)
    .orderBy('cache_keys.updated_at', 'desc')
    .selectAll()
    .executeTakeFirst()

  if (prefixedPrimaryMatch) {
    return prefixedPrimaryMatch
  }

  logger.debug('No prefix matches found in requested branch')

  const prefixedMainBranchMatch = await db
    .selectFrom('cache_keys')
    .where('key', 'like', `${args.key}%`)
    .where('version', '=', args.version)
    .where('repo_id', '=', args.repoId)
    .where('branch_ref', 'in', ['heads/refs/main', 'heads/refs/master'])
    .orderBy('cache_keys.updated_at', 'desc')
    .selectAll()
    .executeTakeFirst()

  if (prefixedMainBranchMatch) {
    return prefixedMainBranchMatch
  }

  if (!args.restoreKeys) {
    logger.debug('No restore keys provided')
    return
  }

  logger.debug('Trying restore keys', args.restoreKeys)
  for (const key of args.restoreKeys) {
    const exactMatch = await db
      .selectFrom('cache_keys')
      .where('id', '=', getCacheKeyId(args.key, args.version, args.repoId, args.branchRef))
      .orderBy('cache_keys.updated_at', 'desc')
      .selectAll()
      .executeTakeFirst()
    if (exactMatch) {
      return exactMatch
    }

    logger.debug('No exact restore keys matches found for', key)

    const prefixedMatch = await db
      .selectFrom('cache_keys')
      .where('version', '=', args.version)
      .where('key', 'like', `${key}%`)
      .where('repo_id', '=', args.repoId)
      .where('branch_ref', '=', args.branchRef)
      .orderBy('cache_keys.updated_at', 'desc')
      .selectAll()
      .executeTakeFirst()

    if (prefixedMatch) {
      return prefixedMatch
    }

    logger.debug('No prefix restore keys matches found in requested branch')

    const prefixedKeyMainBranchMatch = await db
      .selectFrom('cache_keys')
      .where('key', 'like', `${key}%`)
      .where('version', '=', args.version)
      .where('repo_id', '=', args.repoId)
      .where('branch_ref', 'in', ['refs/heads/main', 'refs/heads/master'])
      .orderBy('cache_keys.updated_at', 'desc')
      .selectAll()
      .executeTakeFirst()

    if (prefixedKeyMainBranchMatch) {
      return prefixedKeyMainBranchMatch
    }

    logger.debug('No prefixed restore keys matches found in default branch for', key)
  }
}

export async function listEntriesByKey(db: DB, key: string, repoId: string, branchRef: string) {
  return db
    .selectFrom('cache_keys')
    .where('key', '=', key)
    .where('repo_id', '=', repoId)
    .where('branch_ref', '=', branchRef)
    .selectAll()
    .execute()
}

export async function updateOrCreateKey(
  db: DB,
  {
    key,
    version,
    date,
    repoId,
    branchRef,
  }: {
    key: string
    version: string
    date?: Date
    repoId: string
    branchRef: string
  },
) {
  const now = date ?? new Date()
  const updateResult = await db
    .updateTable('cache_keys')
    .set('updated_at', now.toISOString())
    .set('accessed_at', now.toISOString())
    .where('id', '=', getCacheKeyId(key, version, repoId, branchRef))
    .executeTakeFirst()
  if (Number(updateResult.numUpdatedRows) === 0) {
    await createKey(db, { key, version, date, repoId, branchRef })
  }
}

export async function touchKey(
  db: DB,
  {
    key,
    version,
    repoId,
    branchRef,
    date,
  }: { key: string; version: string; repoId: string; branchRef: string; date?: Date },
) {
  const now = date ?? new Date()
  await db
    .updateTable('cache_keys')
    .set('accessed_at', now.toISOString())
    .where('id', '=', getCacheKeyId(key, version, repoId, branchRef))
    .execute()
}

export async function findStaleKeys(
  db: DB,
  { olderThanDays, date }: { olderThanDays?: number; date?: Date },
) {
  if (olderThanDays === undefined) return db.selectFrom('cache_keys').selectAll().execute()

  const now = date ?? new Date()
  const threshold = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000)
  return db
    .selectFrom('cache_keys')
    .where('accessed_at', '<', threshold.toISOString())
    .selectAll()
    .execute()
}

export async function createKey(
  db: DB,
  {
    key,
    version,
    date,
    repoId,
    branchRef,
  }: { key: string; version: string; date?: Date; repoId: string; branchRef: string },
) {
  const now = date ?? new Date()
  await db
    .insertInto('cache_keys')
    .values({
      id: getCacheKeyId(key, version, repoId, branchRef),
      key,
      version,
      repo_id: repoId,
      branch_ref: branchRef,
      updated_at: now.toISOString(),
      accessed_at: now.toISOString(),
    })
    .execute()
}

function getCacheKeyId(key: string, version: string, repoid: string, branchref: string) {
  return hash('sha256', Buffer.from(`${key}-${version}-${repoid}-${branchref}`))
}

export async function pruneKeys(db: DB, keys?: Selectable<CacheKeysTable>[]) {
  if (keys) {
    await db.transaction().execute(async (tx) => {
      for (const { key, version, repo_id, branch_ref } of keys ?? []) {
        await tx
          .deleteFrom('cache_keys')
          .where('id', '=', getCacheKeyId(key, version, repo_id, branch_ref))
          .execute()
      }
    })
  } else {
    await db.deleteFrom('cache_keys').execute()
  }
}

export async function getUpload(
  db: DB,
  {
    key,
    version,
    repoId,
    branchRef,
  }: { key: string; version: string; repoId: string; branchRef: string },
) {
  const row = await db
    .selectFrom('uploads')
    .select('id')
    .where('key', '=', key)
    .where('version', '=', version)
    .where('repo_id', '=', repoId)
    .where('branch_ref', '=', branchRef)
    .executeTakeFirst()
  return row
}
