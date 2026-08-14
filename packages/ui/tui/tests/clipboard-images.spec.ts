import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  AttachmentStore,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { ClipboardImageDraft } from '../src/chat/clipboard-images.ts'
import { contentText } from '../src/components/content.ts'

const limits: ImageAttachmentLimits = {
  maxImageBytes: 100,
  maxImagesPerMessage: 3,
  maxMessageImageBytes: 200,
  maxImagePixels: 1_000_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

function store(options: {
  limits?: ImageAttachmentLimits
  validate?: (input: SaveImageAttachment) => Promise<void>
} = {}) {
  let serial = 0
  const validateImage = vi.fn(options.validate ?? (() => Promise.resolve()))
  const saveImage = vi.fn(async (input: SaveImageAttachment): Promise<ImageAttachmentRef> => ({
    attachmentId: AttachmentId(`sha256-${String(++serial)}`),
    mediaType: input.mediaType,
    bytes: input.data.byteLength,
    width: 2,
    height: 3,
    ...input.name === undefined ? {} : { name: input.name },
  }))
  return {
    service: {
      imageLimits: options.limits ?? limits,
      validateImage,
      saveImage,
      readImage: () => Promise.reject(new Error('unused')),
    } as unknown as AttachmentStore,
    validateImage,
    saveImage,
  }
}

describe('clipboard image draft admission', () => {
  it('keeps raw bytes out of text and materializes mixed content in marker order', async () => {
    const draft = new ClipboardImageDraft()
    const first = draft.add({
      data: Uint8Array.of(1, 2, 3),
      mediaType: 'image/png',
      name: 'C:\\secret\\first.png',
    })
    const second = draft.add({ data: Uint8Array.of(4, 5), mediaType: 'image/jpeg' })
    expect(first).toBe('[Image #1]')
    expect(second).toBe('[Image #2]')
    expect(JSON.stringify({ first, second })).not.toContain('AQID')

    const fake = store()
    const content = await draft.materialize(
      [{ type: 'text', text: `before ${first} middle ${second} after` }],
      fake.service,
    )
    expect(fake.validateImage.mock.calls.map(([input]) => [...input.data])).toEqual([[1, 2, 3], [4, 5]])
    expect(fake.saveImage).toHaveBeenCalledTimes(2)
    expect(fake.saveImage.mock.calls[0]?.[0].name).toBe('first.png')
    expect(content).toEqual([
      { type: 'text', text: 'before ' },
      {
        type: 'image',
        attachment: {
          attachmentId: 'sha256-1', mediaType: 'image/png', bytes: 3, width: 2, height: 3, name: 'first.png',
        },
      },
      { type: 'text', text: ' middle ' },
      {
        type: 'image',
        attachment: { attachmentId: 'sha256-2', mediaType: 'image/jpeg', bytes: 2, width: 2, height: 3 },
      },
      { type: 'text', text: ' after' },
    ])
    expect(contentText(content)).toBe(
      'before [Image · PNG · 2×3 · 3 B · first.png] middle [Image · JPEG · 2×3 · 2 B] after',
    )
    // A repeated send reuses durable references and performs no new write.
    await draft.materialize([{ type: 'text', text: `${first}${first}` }], fake.service)
    expect(fake.saveImage).toHaveBeenCalledTimes(2)
  })

  it('validates the whole unique batch before the first save', async () => {
    const draft = new ClipboardImageDraft()
    const first = draft.add({ data: Uint8Array.of(1), mediaType: 'image/png' })
    const second = draft.add({ data: Uint8Array.of(2), mediaType: 'image/png' })
    let validations = 0
    const fake = store({
      validate: () => {
        validations += 1
        return validations === 2 ? Promise.reject(new Error('bad second image')) : Promise.resolve()
      },
    })
    await expect(draft.materialize(
      [{ type: 'text', text: `${first} and ${second}` }],
      fake.service,
    )).rejects.toThrow('bad second image')
    expect(fake.validateImage).toHaveBeenCalledTimes(2)
    expect(fake.saveImage).not.toHaveBeenCalled()
  })

  it('enforces intake and send-time count/aggregate limits', async () => {
    const draft = new ClipboardImageDraft()
    const marker = draft.add({ data: new Uint8Array(80), mediaType: 'image/png' })
    expect(draft.stats(`${marker}${marker}`)).toEqual({ count: 2, bytes: 160 })
    expect(draft.intakeError(`${marker}${marker}`, {
      data: new Uint8Array(1),
      mediaType: 'image/png',
    }, { ...limits, maxImagesPerMessage: 2 })).toContain('2-image limit')
    expect(draft.intakeError(marker, {
      data: new Uint8Array(121),
      mediaType: 'image/png',
    }, limits)).toContain('100-byte per-image limit')
    expect(draft.intakeError(marker, {
      data: new Uint8Array(1),
      mediaType: 'image/png',
    }, { ...limits, maxMessageImageBytes: 80 })).toContain('80-byte aggregate')

    await expect(draft.materialize(
      [{ type: 'text', text: `${marker}${marker}` }],
      store({ limits: { ...limits, maxImagesPerMessage: 1 } }).service,
    )).rejects.toMatchObject({ code: 'TOO_MANY_IMAGES' })
  })

  it('releases deleted unsaved images while treating unknown markers as literal text', async () => {
    const draft = new ClipboardImageDraft()
    const deleted = draft.add({ data: Uint8Array.of(1), mediaType: 'image/png' })
    const retained = draft.add({ data: Uint8Array.of(2), mediaType: 'image/png' })
    draft.pruneUnreferenced([retained])
    expect(draft.hasImages(deleted)).toBe(false)
    expect(draft.hasImages(retained)).toBe(true)
    await expect(draft.materialize(
      [{ type: 'text', text: `${deleted} [Image #999]` }],
      store().service,
    )).resolves.toEqual([{ type: 'text', text: `${deleted} [Image #999]` }])
  })
})
