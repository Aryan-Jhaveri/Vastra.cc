import multer from 'multer'
import { perUserRateLimit } from './middleware/perUserRateLimit.js'

// One image upload per request, everywhere (OSS audit 2026-09-28). multer's
// own defaults only cap the file size: field count, field size and part count
// are unlimited, so a single multipart request (the anonymous /share-target
// included) could buffer gigabytes of text fields in memory.
export const IMAGE_UPLOAD_LIMITS = {
  fileSize: 15 * 1024 * 1024,
  files: 1,
  fields: 30,
  fieldSize: 64 * 1024,
  parts: 40,
  headerPairs: 100,
} as const

export function imageUpload() {
  return multer({ storage: multer.memoryStorage(), limits: IMAGE_UPLOAD_LIMITS })
}

/** A MulterError as an HTTP status + JSON body (413 for an oversized file). */
export function uploadErrorResponse(err: unknown): { status: number; body: { error: string } } | null {
  if (!(err instanceof multer.MulterError)) return null
  return err.code === 'LIMIT_FILE_SIZE'
    ? { status: 413, body: { error: 'file_too_large' } }
    : { status: 400, body: { error: 'upload_rejected' } }
}

/** Shared by every signed-in image upload route: each upload runs sharp and writes to disk. */
export const uploadRateLimit = perUserRateLimit(60_000, 30)
