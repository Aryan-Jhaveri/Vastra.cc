// Small preview thumbnails for staged Add Item photos. Rendering the photo's
// own blob: URL in a 64–80px tile still makes the browser decode (and cache)
// the full-resolution image — ~48 MB per 12 MP phone photo — so a batch of
// 30 photos kept that many full decodes alive in the upload row and the
// detecting screen. The thumbnail is decoded once, transiently, and the tile
// then shows a ~240px JPEG. The full-res URL is only rendered for the one
// photo open in the box editor.

export const THUMB_MAX_EDGE = 240

export interface PhotoThumbnail {
  blob: Blob
  /** Source dimensions, for the box editor's aspect ratio. */
  width: number
  height: number
}

/**
 * Resolves null when the platform can't do it (no createImageBitmap / 2D
 * canvas, e.g. jsdom) — the caller falls back to the full-size preview URL.
 * Rejects if the image can't be decoded.
 */
export async function makePhotoThumbnail(file: Blob): Promise<PhotoThumbnail | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null
  const bitmap = await createImageBitmap(file)
  const { width, height } = bitmap
  const canvas = document.createElement('canvas')
  try {
    const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(width, height))
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8))
    return blob ? { blob, width, height } : null
  } finally {
    bitmap.close()
    // Release the backing store now rather than at GC (iOS canvas budget).
    canvas.width = 0
    canvas.height = 0
  }
}
