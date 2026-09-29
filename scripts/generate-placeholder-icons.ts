import sharp from 'sharp'
import { mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, '..', 'src', 'transport', 'web', 'app', 'public', 'icons')
mkdirSync(outDir, { recursive: true })

function svgIcon(innerPadding: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="128" fill="#111111"/>
  <text x="256" y="356" font-family="'Courier New', monospace" font-size="360" font-weight="bold"
    fill="#f5f5f5" text-anchor="middle" dominant-baseline="central"
    style="transform: translateY(${innerPadding}px)">v</text>
</svg>`
}

async function generate() {
  const svgBuffer = Buffer.from(svgIcon(0))
  const svgMaskable = Buffer.from(svgIcon(-8)) // slightly higher for maskable safe zone

  // Standard icons
  for (const size of [192, 512]) {
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(join(outDir, `icon-${size}.png`))
    console.log(`icon-${size}.png`)
  }

  // Maskable icons (with inner padding for safe zone)
  for (const size of [192, 512]) {
    await sharp(svgMaskable)
      .resize(size, size)
      .png()
      .toFile(join(outDir, `icon-maskable-${size}.png`))
    console.log(`icon-maskable-${size}.png`)
  }

  // Apple touch icon
  await sharp(svgBuffer)
    .resize(180, 180)
    .png()
    .toFile(join(outDir, 'apple-touch-icon-180.png'))
  console.log('apple-touch-icon-180.png')

  // Favicon
  await sharp(svgBuffer)
    .resize(32, 32)
    .png()
    .toFile(join(outDir, 'favicon-32.png'))
  console.log('favicon-32.png')

  // Write SVG source
  writeFileSync(join(outDir, 'icon.svg'), svgIcon(0))
  console.log('icon.svg')
}

generate().catch(console.error)
