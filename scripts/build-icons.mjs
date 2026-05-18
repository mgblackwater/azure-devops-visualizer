// Rasterises build/icon.svg into the platform icon assets electron-builder
// expects (icon.ico, icon.png) plus a runtime PNG used by the BrowserWindow
// constructor in electron/main.ts. Run via `npm run build:icons` after
// editing build/icon.svg.

import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const svgPath = resolve(root, 'build/icon.svg')
const svg = readFileSync(svgPath)

const icoSizes = [16, 24, 32, 48, 64, 128, 256]

mkdirSync(resolve(root, 'build'), { recursive: true })
mkdirSync(resolve(root, 'electron/assets'), { recursive: true })

const pngBuffers = await Promise.all(
  icoSizes.map((size) => sharp(svg).resize(size, size).png().toBuffer())
)

const icoBuffer = await pngToIco(pngBuffers)
writeFileSync(resolve(root, 'build/icon.ico'), icoBuffer)
console.log(`[icons] build/icon.ico  (${icoSizes.join(', ')})`)

await sharp(svg).resize(512, 512).png().toFile(resolve(root, 'build/icon.png'))
console.log('[icons] build/icon.png  (512x512)')

await sharp(svg)
  .resize(256, 256)
  .png()
  .toFile(resolve(root, 'electron/assets/app-icon.png'))
console.log('[icons] electron/assets/app-icon.png  (256x256)')
