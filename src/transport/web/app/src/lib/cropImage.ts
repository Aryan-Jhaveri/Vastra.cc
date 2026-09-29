/**
 * Center-crops a File to the target aspect ratio and returns a new JPEG File.
 * No external dependencies — uses the browser Canvas API.
 *
 * Aspect ratio guide across the app:
 *   - Person / body photos (try-on reference): 3:4
 *   - Clothing item photos:                    4:5
 *   - Outfit cover photos:                     1:1 (square)
 */
export async function cropToAspectRatio(
  file: File,
  aspectW: number,
  aspectH: number,
): Promise<File> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)

      const { naturalWidth: w, naturalHeight: h } = img
      const targetRatio = aspectW / aspectH
      const srcRatio = w / h

      let srcX = 0, srcY = 0, srcW = w, srcH = h

      if (srcRatio > targetRatio) {
        // Image is wider than target — crop the sides
        srcW = Math.round(h * targetRatio)
        srcX = Math.round((w - srcW) / 2)
      } else {
        // Image is taller than target — crop top/bottom
        srcH = Math.round(w / targetRatio)
        srcY = Math.round((h - srcH) / 2)
      }

      const canvas = document.createElement('canvas')
      canvas.width = srcW
      canvas.height = srcH
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('Canvas unavailable')); return }

      ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH)

      canvas.toBlob(
        blob => {
          if (!blob) { reject(new Error('Crop failed')); return }
          const name = file.name.replace(/\.[^.]+$/, '.jpg')
          resolve(new File([blob], name, { type: 'image/jpeg' }))
        },
        'image/jpeg',
        0.9,
      )
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Image failed to load'))
    }

    img.src = url
  })
}
