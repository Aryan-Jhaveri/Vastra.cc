import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? ''
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID ?? ''
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY ?? ''
const R2_BACKUP_BUCKET = process.env.R2_BACKUP_BUCKET ?? ''

function getR2Client(): S3Client {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BACKUP_BUCKET) {
    throw new Error('R2 credentials not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BACKUP_BUCKET')
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  })
}

function getBucket(): string {
  if (!R2_BACKUP_BUCKET) {
    throw new Error('R2_BACKUP_BUCKET is not set')
  }
  return R2_BACKUP_BUCKET
}

export interface BackupObject {
  key: string
  size: number
  lastModified: Date
}

export interface PutResult {
  etag: string
  size: number
}

export interface HeadResult {
  size: number
  lastModified: Date
  metadata?: Record<string, string>
}

class RealBackupStore {
  private client: S3Client | null = null

  private getClient(): S3Client {
    if (!this.client) {
      this.client = getR2Client()
    }
    return this.client
  }

  async put(key: string, body: Buffer, metadata?: Record<string, string>): Promise<PutResult> {
    const client = this.getClient()
    const result = await client.send(
      new PutObjectCommand({
        Bucket: getBucket(),
        Key: key,
        Body: body,
        Metadata: metadata,
      })
    )
    return {
      etag: result.ETag ?? '',
      size: body.length,
    }
  }

  async get(key: string): Promise<Buffer> {
    const client = this.getClient()
    const result = await client.send(
      new GetObjectCommand({
        Bucket: getBucket(),
        Key: key,
      })
    )
    if (!result.Body) {
      throw new Error(`No body in response for key ${key}`)
    }
    const chunks: Uint8Array[] = []
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  async head(key: string): Promise<HeadResult | null> {
    const client = this.getClient()
    try {
      const result = await client.send(
        new HeadObjectCommand({
          Bucket: getBucket(),
          Key: key,
        })
      )
      return {
        size: result.ContentLength ?? 0,
        lastModified: result.LastModified ?? new Date(),
        metadata: result.Metadata,
      }
    } catch (err) {
      if ((err as { name?: string }).name === 'NotFound' || (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
        return null
      }
      throw err
    }
  }

  /** Up to maxKeys objects under prefix, newest first. Pages past R2's 1,000-key limit. */
  async list(prefix: string, maxKeys = 100): Promise<BackupObject[]> {
    const client = this.getClient()
    const objects: BackupObject[] = []
    let token: string | undefined
    do {
      const result = await client.send(
        new ListObjectsV2Command({
          Bucket: getBucket(),
          Prefix: prefix,
          MaxKeys: Math.min(1000, maxKeys - objects.length),
          ContinuationToken: token,
        })
      )
      for (const obj of result.Contents ?? []) {
        objects.push({ key: obj.Key ?? '', size: obj.Size ?? 0, lastModified: obj.LastModified ?? new Date(0) })
      }
      token = result.IsTruncated ? result.NextContinuationToken : undefined
    } while (token && objects.length < maxKeys)
    return objects.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
  }

  async delete(key: string): Promise<void> {
    const client = this.getClient()
    await client.send(
      new DeleteObjectCommand({
        Bucket: getBucket(),
        Key: key,
      })
    )
  }
}

export interface BackupStoreInterface {
  put(key: string, body: Buffer, metadata?: Record<string, string>): Promise<PutResult>
  get(key: string): Promise<Buffer>
  head(key: string): Promise<HeadResult | null>
  list(prefix: string, maxKeys?: number): Promise<BackupObject[]>
  delete(key: string): Promise<void>
}

export const BackupStore: BackupStoreInterface = new RealBackupStore()

let testStore: BackupStoreInterface | null = null

export function setStoreForTesting(store: BackupStoreInterface | null): void {
  testStore = store
}

export function getStore(): BackupStoreInterface {
  return testStore ?? BackupStore
}
