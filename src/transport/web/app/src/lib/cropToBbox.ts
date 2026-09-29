// Sample N px in from each corner; if the four samples agree to within
// COLOR_TOLERANCE, treat that average as the background and scan inwards
// from each edge for rows/cols where ≥ ROW_BG_FRACTION of the pixels are
// within tolerance — those are uniform border rows we can trim.
const CORNER_INSET = 2
const COLOR_TOLERANCE = 26
const ROW_BG_FRACTION = 0.94
const MIN_KEEP_FRACTION = 0.4

interface RGB { r: number; g: number; b: number }

function avg(samples: RGB[]): RGB {
  const r = samples.reduce((s, p) => s + p.r, 0) / samples.length
  const g = samples.reduce((s, p) => s + p.g, 0) / samples.length
  const b = samples.reduce((s, p) => s + p.b, 0) / samples.length
  return { r, g, b }
}

function dist(a: RGB, b: RGB) {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)
}

function sample(data: Uint8ClampedArray, w: number, x: number, y: number): RGB {
  const i = (y * w + x) * 4
  return { r: data[i], g: data[i + 1], b: data[i + 2] }
}

function findTrimBounds(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): null | { top: number; bottom: number; left: number; right: number } {
  if (w < 8 || h < 8) return null

  const inset = Math.min(CORNER_INSET, Math.floor(Math.min(w, h) / 4))
  const corners: RGB[] = [
    sample(data, w, inset, inset),
    sample(data, w, w - 1 - inset, inset),
    sample(data, w, inset, h - 1 - inset),
    sample(data, w, w - 1 - inset, h - 1 - inset),
  ]
  const bg = avg(corners)
  for (const c of corners) {
    if (dist(c, bg) > COLOR_TOLERANCE) return null
  }

  const isBgRow = (y: number) => {
    let bgCount = 0
    for (let x = 0; x < w; x++) {
      if (dist(sample(data, w, x, y), bg) <= COLOR_TOLERANCE) bgCount++
    }
    return bgCount / w >= ROW_BG_FRACTION
  }
  const isBgCol = (x: number) => {
    let bgCount = 0
    for (let y = 0; y < h; y++) {
      if (dist(sample(data, w, x, y), bg) <= COLOR_TOLERANCE) bgCount++
    }
    return bgCount / h >= ROW_BG_FRACTION
  }

  let top = 0; while (top < h && isBgRow(top)) top++
  let bottom = 0; while (bottom < h - top && isBgRow(h - 1 - bottom)) bottom++
  let left = 0; while (left < w && isBgCol(left)) left++
  let right = 0; while (right < w - left && isBgCol(w - 1 - right)) right++

  const maxTrimH = Math.floor(h * (1 - MIN_KEEP_FRACTION))
  const maxTrimW = Math.floor(w * (1 - MIN_KEEP_FRACTION))
  if (top + bottom > maxTrimH) {
    const scale = maxTrimH / (top + bottom)
    top = Math.floor(top * scale); bottom = Math.floor(bottom * scale)
  }
  if (left + right > maxTrimW) {
    const scale = maxTrimW / (left + right)
    left = Math.floor(left * scale); right = Math.floor(right * scale)
  }

  if (top === 0 && bottom === 0 && left === 0 && right === 0) return null
  return { top, bottom, left, right }
}

// Exported for unit tests — exercises pixel scan without a canvas
export const __trimInternals = { findTrimBounds }

// The server stores item images at max 1200px (storage/images.ts MAX_DIMENSION)
// and /analyze compresses to 1200px, so a crop larger than this only costs
// memory and upload bytes. Kept a little above 1200 so the server's resize,
// not ours, sets the final quality.
export const CROP_MAX_EDGE = 1600

// iOS Safari caps total canvas memory per page and frees a canvas's backing
// store lazily; shrinking it to 0×0 releases the pixels right away so a batch
// of crops can't exhaust the budget.
function releaseCanvas(canvas: HTMLCanvasElement) {
  canvas.width = 0
  canvas.height = 0
}

export async function cropToBbox(
  file: File,
  box: { x: number; y: number; w: number; h: number },
): Promise<File> {
  const url = URL.createObjectURL(file)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const sx = (box.x / 100) * img.naturalWidth
      const sy = (box.y / 100) * img.naturalHeight
      const sw = Math.max(1, (box.w / 100) * img.naturalWidth)
      const sh = Math.max(1, (box.h / 100) * img.naturalHeight)
      // Draw straight at the capped size: the canvas never holds more than
      // CROP_MAX_EDGE² pixels, and a large batch's crops stay small in memory.
      const scale = Math.min(1, CROP_MAX_EDGE / Math.max(sw, sh))
      const dw = Math.max(1, Math.round(sw * scale))
      const dh = Math.max(1, Math.round(sh * scale))
      const canvas = document.createElement('canvas')
      canvas.width = dw
      canvas.height = dh
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('no 2d context')); return }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh)

      try {
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const bounds = findTrimBounds(imgData.data, canvas.width, canvas.height)
        if (bounds) {
          const newW = canvas.width - bounds.left - bounds.right
          const newH = canvas.height - bounds.top - bounds.bottom
          if (newW > 0 && newH > 0) {
            const trimmed = document.createElement('canvas')
            trimmed.width = newW
            trimmed.height = newH
            const tctx = trimmed.getContext('2d')
            if (tctx) {
              tctx.drawImage(canvas, bounds.left, bounds.top, newW, newH, 0, 0, newW, newH)
              canvas.width = newW
              canvas.height = newH
              ctx.drawImage(trimmed, 0, 0)
            }
            releaseCanvas(trimmed)
          }
        }
      } catch {
        // getImageData can throw on tainted canvases; fall through with untrimmed crop
      }

      URL.revokeObjectURL(url)
      img.src = ''
      canvas.toBlob(
        blob => {
          releaseCanvas(canvas)
          if (!blob) { reject(new Error('crop failed')); return }
          resolve(new File([blob], 'crop.jpg', { type: 'image/jpeg' }))
        },
        'image/jpeg',
        0.9,
      )
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')) }
    img.src = url
  })
}
