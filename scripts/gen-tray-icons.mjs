// Generates the tray icon PNG assets used by the Electron tray.
//
// We commit the PNG bytes directly under `electron/assets/` so the
// runtime can reference real files (and electron-builder can pack them
// into the installer). Re-run this script from the repo root if you
// want to tweak the glyph:
//
//   node scripts/gen-tray-icons.mjs
//
// Why this lives in-repo rather than relying on a designer-supplied
// asset: v0.3.1 is the first release that needs *any* tray art and we
// don't want to hand-craft a binary in version control review. The
// code-fork-shaped glyph here is intentionally placeholder-grade and
// can be swapped for a real asset file later without touching tray.ts.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const outDir = path.join(__dirname, '..', 'electron', 'assets')

fs.mkdirSync(outDir, { recursive: true })

/**
 * Render a 16x16 (or 32x32 retina) RGBA buffer of a code-fork glyph.
 * Pixels are RGBA8888, opaque white where the glyph hits, transparent
 * elsewhere. macOS template images render the alpha channel against
 * the menu bar's effective background, so a white-on-transparent
 * source works in both light and dark modes.
 */
function renderFork(size) {
  // 16x16 design grid that we scale to the target size. Each row is
  // 16 chars: `#` = filled, anything else = transparent. Loose
  // code-fork shape: two upper branches and a single trunk meeting
  // at a hub in the middle.
  const grid = [
    '..##........##..',
    '..##........##..',
    '..##........##..',
    '..###......###..',
    '...##......##...',
    '....##....##....',
    '.....##..##.....',
    '......####......',
    '.......##.......',
    '.......##.......',
    '.......##.......',
    '......####......',
    '.....##..##.....',
    '......####......',
    '.......##.......',
    '................'
  ]

  const buf = Buffer.alloc(size * size * 4, 0)
  const scale = size / 16
  for (let y = 0; y < size; y += 1) {
    const sourceY = Math.min(15, Math.floor(y / scale))
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.min(15, Math.floor(x / scale))
      const cell = grid[sourceY][sourceX]
      const idx = (y * size + x) * 4
      if (cell === '#') {
        buf[idx] = 255
        buf[idx + 1] = 255
        buf[idx + 2] = 255
        buf[idx + 3] = 255
      }
    }
  }
  return buf
}

/**
 * Wrap a chunk type + data in PNG's length-type-data-CRC frame. The
 * CRC32 implementation is the slow lookup-free variant — fine because
 * we run this once at codegen time, not at render time.
 */
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
    }
  }
  return ~c
}

function encodePng(rgba, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = size * 4
  const filtered = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    filtered[y * (stride + 1)] = 0
    rgba.copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = zlib.deflateSync(filtered)

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const targets = [
  { name: 'tray-iconTemplate.png', size: 16 },
  { name: 'tray-iconTemplate@2x.png', size: 32 },
  { name: 'tray-icon.png', size: 16 },
  { name: 'tray-icon@2x.png', size: 32 }
]

for (const t of targets) {
  const png = encodePng(renderFork(t.size), t.size)
  const out = path.join(outDir, t.name)
  fs.writeFileSync(out, png)
  console.log(`wrote ${out} (${png.length} bytes)`)
}
