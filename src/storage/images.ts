import { createReadStream } from 'fs'
import { mkdir, unlink, readFile, writeFile, copyFile, rm, rename, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname, resolve, sep } from 'path'
import { nanoid } from 'nanoid'
import sharp, { type Metadata, type Sharp } from 'sharp'
import { DATA_DIR } from '../db/client.js'

export type ImageFolder = 'items' | 'tags' | 'tryon' | 'user' | 'outfits' | 'garments' | 'source' | 'collections' | 'share' | 'share-inbox'

const MAX_DIMENSION = 1200
const JPEG_QUALITY = 80
const THUMB_DIMENSION = 200
const THUMB_QUALITY = 70

export interface StorageBackend {
  putObject(key: string, buffer: Buffer, contentType: string): Promise<void>
  getObject(key: string): Promise<Buffer>
  headObject(key: string): Promise<{ size: number; contentType: string } | null>
  deleteObject(key: string): Promise<void>
  deletePrefix(prefix: string): Promise<number>
  listPrefix(prefix: string): Promise<string[]>
  streamObject(key: string): Promise<NodeJS.ReadableStream>
}

export class DiskBackend implements StorageBackend {
  private resolveKey(key: string): string {
    return join(DATA_DIR, key)
  }

  async putObject(key: string, buffer: Buffer, _contentType: string): Promise<void> {
    const absPath = this.resolveKey(key)
    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, buffer)
  }

  async getObject(key: string): Promise<Buffer> {
    const absPath = this.resolveKey(key)
    return readFile(absPath)
  }

  async headObject(key: string): Promise<{ size: number; contentType: string } | null> {
    const absPath = this.resolveKey(key)
    if (!existsSync(absPath)) return null
    const stats = await stat(absPath)
    const ext = absPath.toLowerCase().split('.').pop()
    const contentType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream'
    return { size: stats.size, contentType }
  }

  async deleteObject(key: string): Promise<void> {
    const absPath = this.resolveKey(key)
    if (existsSync(absPath)) {
      await unlink(absPath)
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const absPrefix = this.resolveKey(prefix)
    return this.deleteRecursive(absPrefix)
  }

  private async deleteRecursive(absPath: string): Promise<number> {
    if (!existsSync(absPath)) return 0
    const stats = await stat(absPath)
    if (stats.isDirectory()) {
      const entries = await readdir(absPath)
      let count = 0
      for (const entry of entries) {
        count += await this.deleteRecursive(join(absPath, entry))
      }
      await rm(absPath, { recursive: true, force: true })
      return count
    } else {
      await unlink(absPath)
      return 1
    }
  }

  async listPrefix(prefix: string): Promise<string[]> {
    const absPrefix = this.resolveKey(prefix)
    const results: string[] = []
    await this.listRecursive(absPrefix, prefix, results, DATA_DIR)
    return results
  }

  private async listRecursive(absPath: string, keyPrefix: string, results: string[], rootDir: string): Promise<void> {
    if (!existsSync(absPath)) return
    const stats = await stat(absPath)
    if (stats.isDirectory()) {
      const entries = await readdir(absPath)
      for (const entry of entries) {
        await this.listRecursive(join(absPath, entry), keyPrefix, results, rootDir)
      }
    } else {
      const relativePath = absPath.slice(rootDir.length + 1)
      results.push(relativePath)
    }
  }

  async streamObject(key: string): Promise<NodeJS.ReadableStream> {
    const absPath = this.resolveKey(key)
    return createReadStream(absPath)
  }
}

const backend: StorageBackend = new DiskBackend()

export function thumbUri(fullUri: string): string {
  const dot = fullUri.lastIndexOf('.')
  return dot > 0 ? `${fullUri.slice(0, dot)}_thumb${fullUri.slice(dot)}` : `${fullUri}_thumb`
}

/**
 * Issue #379: camera JPEGs often store pixels landscape plus an EXIF
 * Orientation tag (6 = rotate 90°). Browsers honour the tag, and sharp drops
 * metadata on output without applying it, so every sharp open of an image
 * auto-orients. metadata() still reports the pre-rotation width/height; use
 * orientedSize() for anything that maps upright coordinates onto pixels.
 */
function storedImage(input: Buffer | string): Sharp {
  return sharp(input, { autoOrient: true })
}

/** Width/height as displayed, i.e. after the EXIF orientation is applied. */
export function orientedSize(meta: Metadata): { width: number; height: number } {
  return {
    width: meta.autoOrient?.width ?? meta.width ?? 0,
    height: meta.autoOrient?.height ?? meta.height ?? 0,
  }
}

async function saveThumb(destPath: string): Promise<void> {
  const dot = destPath.lastIndexOf('.')
  const thumbPath = dot > 0
    ? `${destPath.slice(0, dot)}_thumb${destPath.slice(dot)}`
    : `${destPath}_thumb`

  await storedImage(destPath)
    .resize(THUMB_DIMENSION, THUMB_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY })
    .toFile(thumbPath)
}

function getUserImagesDir(userId: string): string {
  return join(DATA_DIR, 'users', userId, 'images')
}

async function ensureDir(folder: ImageFolder, userId: string): Promise<string> {
  const dir = join(getUserImagesDir(userId), folder)
  await mkdir(dir, { recursive: true })
  return dir
}

function userKey(folder: ImageFolder, userId: string, filename: string): string {
  return `users/${userId}/images/${folder}/${filename}`
}

// Untrusted uploads (OSS audit 2026-09-28): sharp decoded any format libvips
// knows (SVG, PDF, TIFF…) up to ~268 MP, so a tiny file declaring a huge image
// cost seconds of CPU and a lot of memory. Inputs are checked from the header
// first: a photo format, at most MAX_INPUT_PIXELS (covers 108 MP phone photos).
export const MAX_INPUT_PIXELS = 120_000_000
const ALLOWED_INPUT_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif', 'avif', 'gif'])

export class UnsupportedImageError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsupportedImageError' }
}

/**
 * A sharp pipeline for an untrusted image, after a header-only format + size
 * check. The pipeline auto-orients (EXIF Orientation, #379), so what gets
 * stored is upright — the same view the browser showed the user.
 */
export async function untrustedImage(input: Buffer | string): Promise<Sharp> {
  const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, autoOrient: true })
  let meta: Metadata
  try { meta = await image.metadata() } catch { throw new UnsupportedImageError('Not a readable image') }
  if (!meta.format || !ALLOWED_INPUT_FORMATS.has(meta.format)) {
    throw new UnsupportedImageError(`Unsupported image format: ${meta.format ?? 'unknown'}`)
  }
  if ((meta.width ?? 0) * (meta.height ?? 0) > MAX_INPUT_PIXELS) {
    throw new UnsupportedImageError('Image is too large')
  }
  return image
}

export async function saveImage(
  sourcePath: string,
  folder: ImageFolder,
  userId: string,
): Promise<string> {
  const id = nanoid()
  const destFilename = `${id}.jpg`

  const compressed = await (await untrustedImage(sourcePath))
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer()

  const key = userKey(folder, userId, destFilename)
  await backend.putObject(key, compressed, 'image/jpeg')

  const absDestPath = join(DATA_DIR, key)
  await saveThumb(absDestPath).catch(() => {})

  return `images/${folder}/${destFilename}`
}

export async function saveImageSquareCrop(
  base64: string,
  folder: ImageFolder,
  userId: string,
  size = 800,
): Promise<string> {
  const id = nanoid()
  const destFilename = `${id}.jpg`

  const buffer = Buffer.from(base64, 'base64')
  const cropped = await (await untrustedImage(buffer))
    .resize(size, size, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer()

  const key = userKey(folder, userId, destFilename)
  await backend.putObject(key, cropped, 'image/jpeg')

  return `images/${folder}/${destFilename}`
}

export async function saveImageFromBase64(
  base64: string,
  folder: ImageFolder,
  userId: string,
): Promise<string> {
  const id = nanoid()
  const destFilename = `${id}.jpg`

  const buffer = Buffer.from(base64, 'base64')
  const compressed = await (await untrustedImage(buffer))
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer()

  const key = userKey(folder, userId, destFilename)
  await backend.putObject(key, compressed, 'image/jpeg')

  const absDestPath = join(DATA_DIR, key)
  await saveThumb(absDestPath).catch(() => {})

  return `images/${folder}/${destFilename}`
}

function isContained(root: string, absPath: string): boolean {
  return absPath.startsWith(root + sep)
}

// Resolves a stored image URI (`images/<folder>/<file>`) to an absolute path
// inside the caller's own image tree. URIs reach this function from request
// bodies (garmentUris, sourceUri, share imageUris), so a resolved path that
// escapes `users/<userId>/images/` is rejected rather than served — otherwise
// `../<otherUser>/images/...` reads another tenant's files. Only the canonical
// 'self' user may fall back to the pre-multi-user `DATA_DIR/images/` tree.
export function resolveImagePath(relativePath: string, userId: string): string {
  if (!userId || userId.includes('/') || userId.includes('\\') || userId.includes('..')) {
    throw new Error(`Refusing to resolve image for unsafe userId: ${JSON.stringify(userId)}`)
  }
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) {
    throw new Error('Refusing to resolve invalid image path')
  }

  const userImagesRoot = resolve(getUserImagesDir(userId))
  const userPath = resolve(join(DATA_DIR, 'users', userId, relativePath))
  const userPathOk = isContained(userImagesRoot, userPath)

  if (userId === 'self') {
    const legacyRoot = resolve(join(DATA_DIR, 'images'))
    const legacyPath = resolve(join(DATA_DIR, relativePath))
    if (userPathOk && existsSync(userPath)) return userPath
    if (isContained(legacyRoot, legacyPath)) return legacyPath
  }

  if (!userPathOk) {
    throw new Error(`Refusing image path outside user storage: ${JSON.stringify(relativePath)}`)
  }
  return userPath
}

export async function imageToBase64(relativePath: string, userId: string): Promise<string> {
  const absPath = resolveImagePath(relativePath, userId)
  const buffer = await readFile(absPath)
  return buffer.toString('base64')
}

export async function imageToBase64SquarePadded(
  relativePath: string,
  userId: string,
): Promise<string> {
  const absPath = resolveImagePath(relativePath, userId)
  const image = storedImage(absPath)
  const metadata = await image.metadata()
  const { width, height } = orientedSize(metadata)
  const side = Math.max(width || 1024, height || 1024)
  const padSize = Math.min(side, 1024)

  const buffer = await sharp({
    create: {
      width: padSize,
      height: padSize,
      channels: 3,
      background: { r: 245, g: 245, b: 245 },
    },
  })
    .composite([{ input: await image.resize(padSize, padSize, { fit: 'inside' }).toBuffer() }])
    .jpeg({ quality: 80 })
    .toBuffer()

  return buffer.toString('base64')
}

export async function deleteImage(relativePath: string, userId: string): Promise<void> {
  const absPath = resolveImagePath(relativePath, userId)
  if (existsSync(absPath)) {
    await unlink(absPath)
  }
  const thumbAbsPath = resolveImagePath(thumbUri(relativePath), userId)
  if (existsSync(thumbAbsPath)) {
    await unlink(thumbAbsPath).catch(() => {})
  }
}

export async function moveImageBetweenUsers(
  uri: string,
  fromUserId: string,
  toUserId: string,
): Promise<void> {
  for (const uid of [fromUserId, toUserId]) {
    if (!uid || uid.includes('/') || uid.includes('\\') || uid.includes('..')) {
      throw new Error(`Refusing to move image for unsafe userId: ${JSON.stringify(uid)}`)
    }
  }
  if (uri.includes('..')) {
    throw new Error(`Refusing to move image with unsafe uri: ${JSON.stringify(uri)}`)
  }

  async function moveOne(relativePath: string): Promise<void> {
    const fromRoot = resolve(join(DATA_DIR, 'users', fromUserId))
    const toRoot = resolve(join(DATA_DIR, 'users', toUserId))
    const fromAbs = resolve(join(fromRoot, relativePath))
    const toAbs = resolve(join(toRoot, relativePath))
    if (!fromAbs.startsWith(fromRoot + sep) || !toAbs.startsWith(toRoot + sep)) {
      throw new Error(`Refusing to move image outside users root: ${fromAbs} -> ${toAbs}`)
    }
    if (!existsSync(fromAbs)) return
    await mkdir(dirname(toAbs), { recursive: true })
    await rename(fromAbs, toAbs)
  }

  await moveOne(uri)
  await moveOne(thumbUri(uri)).catch(() => { /* thumb may not exist */ })
}

export async function compressImage(relativePath: string, userId: string): Promise<void> {
  const absPath = resolveImagePath(relativePath, userId)
  const tmpPath = absPath + '.tmp'

  await storedImage(absPath)
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toFile(tmpPath)

  await unlink(absPath)
  await copyFile(tmpPath, absPath)
  await unlink(tmpPath)
}

export async function getImageMetadata(relativePath: string, userId: string) {
  const absPath = resolveImagePath(relativePath, userId)
  return sharp(absPath).metadata()
}

export async function snapshotImageForShare(
  sourceRelativePath: string,
  payloadId: string,
  userId: string,
): Promise<string | null> {
  const absSource = resolveImagePath(sourceRelativePath, userId)
  if (!existsSync(absSource)) return null

  const shareDir = join(getUserImagesDir(userId), 'share', payloadId)
  await mkdir(shareDir, { recursive: true })

  const id = nanoid()
  const destFilename = `${id}.jpg`
  const destPath = join(shareDir, destFilename)

  await storedImage(absSource)
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toFile(destPath)

  return `images/share/${payloadId}/${destFilename}`
}

export async function imageToBase64Compressed(
  relativePath: string,
  userId: string,
  opts?: { maxDim?: number; quality?: number },
): Promise<string> {
  const maxDim = opts?.maxDim ?? 800
  const quality = opts?.quality ?? 70
  const absPath = resolveImagePath(relativePath, userId)
  const buffer = await storedImage(absPath)
    .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer()
  return buffer.toString('base64')
}

export async function deleteUserImageDirectory(userId: string): Promise<void> {
  if (!userId || userId.includes('/') || userId.includes('\\') || userId.includes('..')) {
    throw new Error(`Refusing to delete user directory for unsafe userId: ${JSON.stringify(userId)}`)
  }

  const usersRoot = resolve(join(DATA_DIR, 'users'))
  const target = resolve(join(usersRoot, userId))

  if (target === usersRoot || dirname(target) !== usersRoot) {
    throw new Error(`Refusing to delete unexpected path: ${target}`)
  }

  await rm(target, { recursive: true, force: true })
}

export { getUserImagesDir }

export async function compressBuffer(
  buffer: Buffer,
  opts?: { maxDim?: number; quality?: number },
): Promise<Buffer> {
  const maxDim = opts?.maxDim ?? MAX_DIMENSION
  const quality = opts?.quality ?? JPEG_QUALITY
  return (await untrustedImage(buffer))
    .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer()
}

/**
 * Bulk add (prod 2026-09-29): crop one detected box out of the stored source
 * photo on the server, so the review step doesn't depend on the browser's
 * canvas (which failed silently for some Firefox users: empty previews,
 * nothing classified or saved). `box` is in percent of the photo, as the
 * detector returns it. Uniform borders are trimmed like the old client crop.
 * Returns JPEG bytes; nothing is stored.
 */
export async function cropSourceBox(
  sourceUri: string,
  userId: string,
  box: { x: number; y: number; w: number; h: number },
  maxEdge = 1200,
): Promise<Buffer> {
  const sourcePath = resolveImagePath(sourceUri, userId)
  // Box percentages are of the upright photo the user saw, so both the
  // dimensions and the extract use the auto-oriented image (#379).
  const { width: W, height: H } = orientedSize(await sharp(sourcePath).metadata())
  if (!W || !H) throw new Error('Source image has no dimensions')
  const left = Math.min(W - 1, Math.max(0, Math.round((box.x / 100) * W)))
  const top = Math.min(H - 1, Math.max(0, Math.round((box.y / 100) * H)))
  const width = Math.max(1, Math.min(W - left, Math.round((box.w / 100) * W)))
  const height = Math.max(1, Math.min(H - top, Math.round((box.h / 100) * H)))
  const cropped = await storedImage(sourcePath).extract({ left, top, width, height }).toBuffer()
  // trim() throws when the whole crop is one colour; keep the untrimmed crop then.
  const trimmed = await sharp(cropped).trim({ threshold: 10 }).toBuffer().catch(() => cropped)
  return sharp(trimmed)
    .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer()
}

export async function cropFromUri(
  sourceUri: string,
  userId: string,
  bbox: { left: number; top: number; width: number; height: number },
  folder: ImageFolder,
): Promise<{ uri: string; buffer: Buffer }> {
  const sourcePath = resolveImagePath(sourceUri, userId)
  const oriented = orientedSize(await sharp(sourcePath).metadata())
  const srcW = oriented.width || 1000
  const srcH = oriented.height || 1000

  const clampedLeft = Math.min(bbox.left, srcW - 1)
  const clampedTop = Math.min(bbox.top, srcH - 1)
  const clampedWidth = Math.min(bbox.width, srcW - clampedLeft)
  const clampedHeight = Math.min(bbox.height, srcH - clampedTop)

  const cropBuf = await storedImage(sourcePath)
    .extract({ left: clampedLeft, top: clampedTop, width: clampedWidth, height: clampedHeight })
    .resize(800, 1000, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer()

  const id = nanoid()
  const destFilename = `${id}.jpg`
  const key = userKey(folder, userId, destFilename)
  await backend.putObject(key, cropBuf, 'image/jpeg')

  return { uri: `images/${folder}/${destFilename}`, buffer: cropBuf }
}
