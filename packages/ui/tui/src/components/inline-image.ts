/** Inline rendering of durable image attachments in capable terminals. */

import {
  Image,
  getCapabilities,
  getCellDimensions,
  visibleWidth,
  type Component,
} from '@earendil-works/pi-tui'
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import sharp from 'sharp'
import { imageContentText } from './content.ts'
import type { Palette } from './theme.ts'

type ImageBlock = { readonly type: 'image'; readonly attachment: ImageAttachmentRef }

export type InlineImageFactory = (block: ImageBlock) => Component

export interface InlineImageOptions {
  readonly maxWidthCells?: number
  readonly maxHeightCells?: number
  readonly hideFallback?: boolean
  /** Render a portable half-block truecolor raster instead of relying on an image protocol. */
  readonly preferAnsiPixels?: boolean
  /** Position ANSI art relative to the whole viewport or the welcome card's left column. */
  readonly ansiAlignment?: 'left' | 'center' | 'left-panel'
}

interface SixelImage {
  readonly sequence: string
  readonly rows: number
}

interface AnsiImage {
  readonly lines: readonly string[]
}

/** Convert two vertical source pixels into one terminal cell using ▀/▄. */
async function makeAnsiPixels(data: Uint8Array, widthCells: number, maxRows: number): Promise<AnsiImage> {
  // Sharp applies resize before extend within one pipeline. Keep preparation
  // and scaling in separate pipelines so the transparent safety gutter is
  // scaled with the mascot instead of becoming 64 extra terminal columns and
  // rows around it.
  const prepared = await sharp(data)
    .ensureAlpha()
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({
      top: 32,
      bottom: 32,
      left: 32,
      right: 32,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer()
  const decoded = await sharp(prepared)
    .ensureAlpha()
    .resize({
      width: Math.max(1, widthCells),
      height: Math.max(2, maxRows * 2),
      fit: 'inside',
      // Terminal mascots are deliberately block-built. Nearest-neighbour keeps
      // those brick edges crisp instead of blending them back into a blur.
      kernel: 'nearest',
      withoutEnlargement: false,
    })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const width = decoded.info.width
  const height = decoded.info.height
  const channels = decoded.info.channels
  const pixel = (x: number, y: number): readonly [number, number, number, number] => {
    if (y >= height) return [0, 0, 0, 0]
    const offset = (y * width + x) * channels
    return [
      decoded.data[offset] ?? 0,
      decoded.data[offset + 1] ?? 0,
      decoded.data[offset + 2] ?? 0,
      decoded.data[offset + 3] ?? 255,
    ]
  }
  const foreground = (rgb: readonly [number, number, number, number]): string =>
    `\x1b[38;2;${String(rgb[0])};${String(rgb[1])};${String(rgb[2])}m`
  const background = (rgb: readonly [number, number, number, number]): string =>
    `\x1b[48;2;${String(rgb[0])};${String(rgb[1])};${String(rgb[2])}m`
  const lines: string[] = []
  for (let y = 0; y < height; y += 2) {
    let line = ''
    for (let x = 0; x < width; x++) {
      const top = pixel(x, y)
      const bottom = pixel(x, y + 1)
      const topVisible = top[3] >= 64
      const bottomVisible = bottom[3] >= 64
      if (!topVisible && !bottomVisible) {
        line += ' '
      } else if (topVisible && !bottomVisible) {
        line += `${foreground(top)}▀\x1b[0m`
      } else if (!topVisible && bottomVisible) {
        line += `${foreground(bottom)}▄\x1b[0m`
      } else {
        line += `${foreground(top)}${background(bottom)}▀\x1b[0m`
      }
    }
    lines.push(line.replace(/ +$/u, ''))
  }
  while (lines[0]?.trim() === '') lines.shift()
  while (lines.at(-1)?.trim() === '') lines.pop()
  return { lines }
}

function supportsSixel(): boolean {
  if (process.env.TMUX || process.env.TERM?.toLowerCase().startsWith('screen')) return false
  const forced = process.env.DSH_TUI_IMAGE_PROTOCOL?.toLowerCase()
  if (forced === 'none') return false
  if (forced === 'sixel') return true
  if (forced === 'kitty' || forced === 'iterm2') return false
  return process.env.WT_SESSION !== undefined || process.env.TERM_PROGRAM?.toLowerCase() === 'vscode'
}

function sixelRun(character: string, count: number): string {
  return count >= 4 ? `!${String(count)}${character}` : character.repeat(count)
}

function encodeSixelRow(values: readonly number[]): string {
  if (values.length === 0) return ''
  let result = ''
  let previous = values[0] ?? 0
  let count = 1
  for (let index = 1; index < values.length; index++) {
    const value = values[index] ?? 0
    if (value === previous) {
      count++
      continue
    }
    result += sixelRun(String.fromCharCode(63 + previous), count)
    previous = value
    count = 1
  }
  return result + sixelRun(String.fromCharCode(63 + previous), count)
}

/** Encode a compact 27-colour Sixel image sized to terminal cells. */
async function makeSixel(data: Uint8Array, widthCells: number, maxRows = 24): Promise<SixelImage> {
  const cells = getCellDimensions()
  const maxWidthPx = Math.max(1, Math.round(widthCells * cells.widthPx))
  const maxHeightPx = Math.max(1, Math.round(maxRows * cells.heightPx))
  const decoded = await sharp(data)
    .ensureAlpha()
    .resize({ width: maxWidthPx, height: maxHeightPx, fit: 'inside', withoutEnlargement: false })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const width = decoded.info.width
  const height = decoded.info.height
  const channels = decoded.info.channels
  const indexed = new Int16Array(width * height)
  indexed.fill(-1)
  const used = new Set<number>()
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * channels
    if ((decoded.data[offset + 3] ?? 255) < 64) continue
    const red = Math.min(2, Math.round((decoded.data[offset] ?? 0) / 127.5))
    const green = Math.min(2, Math.round((decoded.data[offset + 1] ?? 0) / 127.5))
    const blue = Math.min(2, Math.round((decoded.data[offset + 2] ?? 0) / 127.5))
    const colour = red * 9 + green * 3 + blue
    indexed[pixel] = colour
    used.add(colour)
  }
  const palette = [...used].sort((left, right) => left - right)
    .map((colour) => {
      const red = Math.floor(colour / 9)
      const green = Math.floor((colour % 9) / 3)
      const blue = colour % 3
      return `#${String(colour)};2;${String(red * 50)};${String(green * 50)};${String(blue * 50)}`
    })
    .join('')
  const bands: string[] = []
  for (let top = 0; top < height; top += 6) {
    const colours: string[] = []
    for (const colour of palette.length === 0 ? [0] : [...used].sort((left, right) => left - right)) {
      const columns = new Array<number>(width).fill(0)
      let present = false
      for (let x = 0; x < width; x++) {
        let mask = 0
        for (let bit = 0; bit < 6 && top + bit < height; bit++) {
          if (indexed[(top + bit) * width + x] === colour) mask |= 1 << bit
        }
        columns[x] = mask
        present ||= mask !== 0
      }
      if (present) colours.push(`#${String(colour)}${encodeSixelRow(columns)}`)
    }
    bands.push(colours.join('$'))
  }
  const payload = `\x1bP0;1;0q"1;1;${String(width)};${String(height)}${palette}${bands.join('-')}\x1b\\`
  const rows = Math.max(1, Math.ceil(height / cells.heightPx))
  const moveUp = rows > 1 ? `\x1b[${String(rows - 1)}A` : ''
  return { sequence: moveUp + payload, rows }
}

class InlineAttachmentImage implements Component {
  private stored: StoredImageAttachment | undefined
  private native: Image | undefined
  private error = false
  private sixel: { width: number; image: SixelImage } | undefined
  private sixelWidth: number | undefined
  private ansi: { width: number; image: AnsiImage } | undefined
  private ansiWidth: number | undefined

  constructor(
    private readonly block: ImageBlock,
    load: Promise<StoredImageAttachment>,
    private readonly requestRender: () => void,
    private readonly palette: Palette,
    private readonly options: InlineImageOptions,
  ) {
    void load.then((stored) => {
      this.stored = stored
      this.requestRender()
    }, () => {
      this.error = true
      this.requestRender()
    })
  }

  invalidate(): void {
    this.native?.invalidate()
  }

  render(width: number): string[] {
    const fallback = this.palette.dim(imageContentText(this.block))
    const fallbackLines = this.options.hideFallback === true ? [] : [fallback]
    if (this.error || this.stored === undefined) return fallbackLines
    const capabilities = getCapabilities()
    if (capabilities.images !== null) {
      this.native ??= new Image(
        Buffer.from(this.stored.data).toString('base64'),
        this.block.attachment.mediaType,
        { fallbackColor: value => this.palette.dim(value) },
        {
          maxWidthCells: this.options.maxWidthCells ?? 60,
          maxHeightCells: this.options.maxHeightCells ?? 24,
          ...this.block.attachment.name === undefined ? {} : { filename: this.block.attachment.name },
        },
        { widthPx: this.block.attachment.width, heightPx: this.block.attachment.height },
      )
      return this.native.render(width)
    }
    const alignment = this.options.ansiAlignment ?? 'left'
    const alignmentWidth = alignment === 'left-panel' && width >= 76
      ? Math.max(1, Math.floor((width - 7) * 0.38))
      : width
    const targetWidth = Math.max(1, Math.min(this.options.maxWidthCells ?? 60, alignmentWidth - 2))
    if (this.options.preferAnsiPixels === true) {
      if (this.ansi?.width === targetWidth) {
        const lines = [...this.ansi.image.lines]
        if (alignment === 'left') return lines
        const artWidth = Math.max(0, ...lines.map(line => visibleWidth(line)))
        const areaWidth = alignment === 'left-panel' ? alignmentWidth : width
        const indent = Math.max(0, Math.floor((areaWidth - artWidth) / 2))
        return lines.map(line => `${' '.repeat(indent)}${line}`)
      }
      if (this.ansiWidth !== targetWidth) {
        this.ansiWidth = targetWidth
        void makeAnsiPixels(this.stored.data, targetWidth, this.options.maxHeightCells ?? 24).then((image) => {
          if (this.ansiWidth !== targetWidth) return
          this.ansi = { width: targetWidth, image }
          this.requestRender()
        }, () => {
          this.error = true
          this.requestRender()
        })
      }
      return fallbackLines
    }
    if (!supportsSixel()) return fallbackLines
    if (this.sixel?.width === targetWidth) {
      const lines = new Array<string>(this.sixel.image.rows).fill('')
      lines[lines.length - 1] = this.sixel.image.sequence
      return lines
    }
    if (this.sixelWidth !== targetWidth) {
      this.sixelWidth = targetWidth
      void makeSixel(this.stored.data, targetWidth, this.options.maxHeightCells ?? 24).then((image) => {
        if (this.sixelWidth !== targetWidth) return
        this.sixel = { width: targetWidth, image }
        this.requestRender()
      }, () => {
        this.error = true
        this.requestRender()
      })
    }
    return fallbackLines
  }
}

/** Create attachment components with a shared verified-byte cache. */
export function createInlineImageFactory(
  readImage: (ref: ImageAttachmentRef) => Promise<StoredImageAttachment>,
  requestRender: () => void,
  palette: Palette,
  options: InlineImageOptions = {},
): InlineImageFactory {
  const loads = new Map<string, Promise<StoredImageAttachment>>()
  return (block) => {
    const key = String(block.attachment.attachmentId)
    let load = loads.get(key)
    if (load === undefined) {
      load = readImage(block.attachment)
      loads.set(key, load)
    }
    return new InlineAttachmentImage(block, load, requestRender, palette, options)
  }
}
