import type { StorageDriver } from '~/lib/storage/storage-driver'
import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'

import { pipeline } from 'node:stream/promises'

import { z } from 'zod'
import { BASE_FOLDER, parseEnv, UPLOAD_FOLDER } from '~/lib/storage/storage-driver'
import { createTempDir } from '~/lib/utils'

export const FilesystemStorageDriver = {
  async create() {
    const options = parseEnv(
      z.object({
        STORAGE_FILESYSTEM_PATH: z.string().default('.data/storage/filesystem'),
        NODE_IP: z.string().optional(),
        NODE_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
      }),
    )

    const rootFolder = options.STORAGE_FILESYSTEM_PATH
    await fs.mkdir(path.join(rootFolder, BASE_FOLDER), {
      recursive: true,
    })
    await fs.mkdir(path.join(rootFolder, BASE_FOLDER, UPLOAD_FOLDER), {
      recursive: true,
    })

    return <StorageDriver>{
      async uploadPart(opts) {
        const folderPath = path.join(rootFolder, BASE_FOLDER, UPLOAD_FOLDER, opts.uploadId)
        await fs.mkdir(folderPath, { recursive: true })
        const writeStream = await createWriteStream(
          path.join(folderPath, `part_${opts.partNumber}`),
        )
        await pipeline(opts.data, writeStream)
      },

      async completeMultipartUpload(opts) {
        const tempDir = await createTempDir()
        const outputTempFilePath = path.join(tempDir, 'output')

        for (const partNumber of opts.partNumbers) {
          const buffer = await fs.readFile(
            path.join(rootFolder, BASE_FOLDER, UPLOAD_FOLDER, opts.uploadId, `part_${partNumber}`),
          )

          await fs.appendFile(outputTempFilePath, buffer)
        }

        await fs.copyFile(
          outputTempFilePath,
          path.join(rootFolder, BASE_FOLDER, opts.cacheFileName),
        )
        await fs.rm(outputTempFilePath)

        await Promise.all([
          this.cleanupMultipartUpload(opts.uploadId),
          fs.rm(outputTempFilePath, { force: true }),
        ])
      },

      async cleanupMultipartUpload(uploadId) {
        await fs.rm(path.join(rootFolder, BASE_FOLDER, UPLOAD_FOLDER, uploadId), {
          force: true,
          recursive: true,
        })
      },

      async delete(cacheFileNames): Promise<void> {
        for (const cacheFileName of cacheFileNames) {
          await fs.rm(path.join(rootFolder, BASE_FOLDER, cacheFileName), {
            force: true,
          })
        }
      },

      async createReadStream(cacheFileName) {
        const filePath = path.join(rootFolder, BASE_FOLDER, cacheFileName)
        if (!(await fs.stat(filePath))) return null

        return createReadStream(filePath)
      },

      async getFileSize(cacheFileName) {
        const filePath = path.join(rootFolder, BASE_FOLDER, cacheFileName)
        try {
          const stat = await fs.stat(filePath)
          return stat.size
        } catch {
          return null
        }
      },

      async createDownloadUrl(cacheFileName) {
        const nodeIp = options.NODE_IP
        const nodePort = options.NODE_PORT

        if (!nodeIp || !nodePort) {
          throw new Error('NODE_IP and NODE_PORT environment variables are required for createDownloadUrl')
        }

        const randomToken = randomBytes(64).toString('hex')
        return `http://${nodeIp}:${nodePort}/download/${randomToken}/${cacheFileName}`
      },
    }
  },
}
