/**
 * Draft-local clipboard image markers and durable send-time admission. Raw
 * bytes never enter editor text or session events: `[Image #N]` is replaced by
 * an immutable attachment reference only after batch validation succeeds.
 * @module @deepseek-ai/dsh-tui/chat/clipboard-images
 */

import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type {
  AttachmentStore,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ClipboardImage } from '../runtime.ts'

const IMAGE_MARKER = /\[Image #([1-9]\d*)\]/gu

interface PendingImage {
  readonly kind: 'pending'
  readonly input: SaveImageAttachment
}

interface DurableImage {
  readonly kind: 'durable'
  readonly attachment: ImageAttachmentRef
}

type DraftImage = PendingImage | DurableImage

interface MarkerOccurrence {
  readonly id: number
  readonly start: number
  readonly end: number
  readonly image: DraftImage
}

/** Active recognized-image totals used by intake and authoritative admission. */
export interface ClipboardImageDraftStats {
  readonly count: number
  readonly bytes: number
}

function safeDisplayName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined
  const leaf = name.replaceAll('\\', '/').split('/').at(-1)
    ?.replace(/[\u0000-\u001F\u007F]/gu, '').trim()
  return leaf === undefined || leaf === '' ? undefined : leaf.slice(0, 255)
}

function imageBytes(image: DraftImage): number {
  return image.kind === 'pending' ? image.input.data.byteLength : image.attachment.bytes
}

function imageMediaType(image: DraftImage): ImageAttachmentRef['mediaType'] {
  return image.kind === 'pending' ? image.input.mediaType : image.attachment.mediaType
}

/** Draft marker registry owned by one mounted TUI channel. */
export class ClipboardImageDraft {
  private readonly images = new Map<number, DraftImage>()
  private nextId = 1

  /**
   * Add detached temporary bytes and return the marker to insert at the cursor.
   * @param image - Clipboard image bytes and metadata.
   * @returns The draft marker associated with the detached bytes.
   */
  add(image: ClipboardImage): string {
    const id = this.nextId
    this.nextId += 1
    const name = safeDisplayName(image.name)
    this.images.set(id, {
      kind: 'pending',
      input: {
        data: Uint8Array.from(image.data),
        mediaType: image.mediaType,
        ...name === undefined ? {} : { name },
      },
    })
    return ClipboardImageDraft.marker(id)
  }

  /**
   * Build the stable human-readable marker inserted into pi-tui's text editor.
   * @param id - Mounted-channel image identifier.
   * @returns The editor marker for the identifier.
   */
  static marker(id: number): string {
    return `[Image #${String(id)}]`
  }

  /**
   * Test whether text contains at least one marker known by this mounted channel.
   * @param text - Editor text to inspect.
   * @returns Whether the text contains a recognized marker.
   */
  hasImages(text: string): boolean {
    return this.occurrences(text).length > 0
  }

  /**
   * Count recognized marker occurrences and their repeated model-input bytes.
   * @param text - Editor text to measure.
   * @returns Recognized occurrence and byte totals.
   */
  stats(text: string): ClipboardImageDraftStats {
    return this.occurrences(text).reduce<ClipboardImageDraftStats>((stats, occurrence) => ({
      count: stats.count + 1,
      bytes: stats.bytes + imageBytes(occurrence.image),
    }), { count: 0, bytes: 0 })
  }

  /**
   * Return an immediate intake refusal, leaving authoritative decoding to the
   * attachment store at send time.
   * @param text - Current editor text before the candidate insertion.
   * @param image - Candidate clipboard image.
   * @param limits - Deployment-owned image admission limits.
   * @returns A user-facing refusal, or `undefined` when intake may proceed.
   */
  intakeError(
    text: string,
    image: ClipboardImage,
    limits: ImageAttachmentLimits,
  ): string | undefined {
    const active = this.stats(text)
    if (!limits.mediaTypes.includes(image.mediaType)) {
      return `${image.mediaType} clipboard images are not accepted by this deployment.`
    }
    if (image.data.byteLength === 0) return 'The clipboard image is empty.'
    if (image.data.byteLength > limits.maxImageBytes) {
      return `Clipboard image exceeds the configured ${String(limits.maxImageBytes)}-byte per-image limit.`
    }
    if (active.count + 1 > limits.maxImagesPerMessage) {
      return `Prompt exceeds the configured ${String(limits.maxImagesPerMessage)}-image limit.`
    }
    if (active.bytes + image.data.byteLength > limits.maxMessageImageBytes) {
      return `Prompt exceeds the configured ${String(limits.maxMessageImageBytes)}-byte aggregate image limit.`
    }
    return undefined
  }

  /**
   * Release unsaved bytes no longer referenced by the live or stashed draft.
   * @param texts - Draft texts whose recognized markers remain live.
   */
  pruneUnreferenced(texts: readonly string[]): void {
    const retained = new Set<number>()
    for (const text of texts) {
      for (const occurrence of this.occurrences(text)) retained.add(occurrence.id)
    }
    for (const [id, image] of this.images) {
      if (image.kind === 'pending' && !retained.has(id)) this.images.delete(id)
    }
  }

  /** Release every pending byte array and durable marker association on teardown. */
  clear(): void {
    this.images.clear()
  }

  /**
   * Validate all recognized images before saving any, then replace markers in
   * content order with durable image blocks.
   * @param content - Prompt content containing possible draft markers.
   * @param store - Durable attachment store used for validation and persistence.
   * @returns Prompt content with recognized markers replaced by image blocks.
   */
  async materialize(
    content: readonly ContentBlock[],
    store: AttachmentStore,
  ): Promise<ContentBlock[]> {
    const occurrences = content.flatMap(block => block.type === 'text' ? this.occurrences(block.text) : [])
    if (occurrences.length === 0) return [...structuredClone(content)]
    const limits = store.imageLimits
    if (occurrences.length > limits.maxImagesPerMessage) {
      throw new AttachmentError('Prompt exceeds the configured image-count limit.', 'TOO_MANY_IMAGES')
    }
    const totalBytes = occurrences.reduce((sum, occurrence) => sum + imageBytes(occurrence.image), 0)
    if (totalBytes > limits.maxMessageImageBytes) {
      throw new AttachmentError('Prompt exceeds the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE')
    }
    for (const occurrence of occurrences) {
      const bytes = imageBytes(occurrence.image)
      if (bytes > limits.maxImageBytes) {
        throw new AttachmentError('Image exceeds the configured per-image byte limit.', 'IMAGE_TOO_LARGE')
      }
      if (!limits.mediaTypes.includes(imageMediaType(occurrence.image))) {
        throw new AttachmentError('Image media type is not accepted by this deployment.', 'UNSUPPORTED_IMAGE_TYPE')
      }
    }

    const pending = new Map<number, PendingImage>()
    for (const occurrence of occurrences) {
      if (occurrence.image.kind === 'pending') pending.set(occurrence.id, occurrence.image)
    }
    // Batch contract: a decoder must accept every unique temporary image before
    // the first durable object is published.
    for (const image of pending.values()) await store.validateImage(image.input)

    const saved = new Map<number, ImageAttachmentRef>()
    for (const [id, image] of pending) saved.set(id, await store.saveImage(image.input))
    // Update marker ownership only after every save completes. A content-addressed
    // store may retain an orphan from a failed later save, but no draft or log
    // observes a partially committed batch and retry remains idempotent.
    for (const [id, attachment] of saved) this.images.set(id, { kind: 'durable', attachment })

    return content.flatMap<ContentBlock>((block) => {
      if (block.type !== 'text') return [structuredClone(block)]
      return this.materializeText(block.text)
    })
  }

  private occurrences(text: string): MarkerOccurrence[] {
    const occurrences: MarkerOccurrence[] = []
    for (const match of text.matchAll(IMAGE_MARKER)) {
      const rawId = match[1]
      const start = match.index
      if (rawId === undefined) continue
      const id = Number(rawId)
      if (!Number.isSafeInteger(id)) continue
      const image = this.images.get(id)
      if (image === undefined) continue
      occurrences.push({ id, start, end: start + match[0].length, image })
    }
    return occurrences
  }

  private materializeText(text: string): ContentBlock[] {
    const blocks: ContentBlock[] = []
    let cursor = 0
    for (const occurrence of this.occurrences(text)) {
      if (occurrence.start > cursor) blocks.push({ type: 'text', text: text.slice(cursor, occurrence.start) })
      const image = this.images.get(occurrence.id)
      /* v8 ignore next -- entries are retained throughout this synchronous projection. */
      if (image === undefined) continue
      /* v8 ignore next -- materialize replaces every pending entry after all saves. */
      if (image.kind === 'pending') throw new Error('clipboard image was not durably committed')
      blocks.push({ type: 'image', attachment: image.attachment })
      cursor = occurrence.end
    }
    if (cursor < text.length) blocks.push({ type: 'text', text: text.slice(cursor) })
    return blocks
  }
}
