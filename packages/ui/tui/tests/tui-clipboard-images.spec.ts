import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  AttachmentStore,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { createTuiTestHarness, disposeTuiTestHarness } from './harness.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

const imageLimits: ImageAttachmentLimits = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 3,
  maxMessageImageBytes: 2048,
  maxImagePixels: 1_000_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

function fakeAttachments(validate?: (input: SaveImageAttachment) => Promise<void>) {
  let serial = 0
  const validateImage = vi.fn(validate ?? (() => Promise.resolve()))
  const saveImage = vi.fn(async (input: SaveImageAttachment): Promise<ImageAttachmentRef> => ({
    attachmentId: AttachmentId(`clipboard-${String(++serial)}`),
    mediaType: input.mediaType,
    bytes: input.data.byteLength,
    width: 1,
    height: 1,
    ...input.name === undefined ? {} : { name: input.name },
  }))
  return {
    service: {
      imageLimits,
      validateImage,
      saveImage,
      readImage: () => Promise.reject(new Error('unused')),
    } as unknown as AttachmentStore,
    validateImage,
    saveImage,
  }
}

const catalog = (inputModalities: readonly ('text' | 'image')[]) => ({
  providers: [{ id: 'vision', name: 'Vision' }],
  models: [{ provider: 'vision', id: 'model', name: 'Model', inputModalities }],
  resolveModelInfo: () => Promise.resolve({
    context: { contextWindow: 128_000 },
    inputModalities,
  }),
})

async function settle(terminal: HeadlessTerminal): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30))
  await terminal.flush()
}

describe('TUI clipboard image input', () => {
  it('pastes at the cursor and durably sends mixed and image-only prompts', async () => {
    const terminal = new HeadlessTerminal(88, 32)
    const attachments = fakeAttachments()
    const readClipboardImage = vi.fn(() => Promise.resolve({
      data: Uint8Array.of(137, 80, 78, 71),
      mediaType: 'image/png' as const,
      name: 'clipboard.png',
    }))
    const setup = await createTuiTestHarness(terminal, vi.fn(), {
      attachments: attachments.service,
      readClipboardImage,
      agentOptions: { provider: 'vision', model: 'model' },
      catalog: catalog(['text', 'image']),
    })
    try {
      await settle(terminal)
      terminal.send('describe ')
      terminal.send('\x1bv')
      await settle(terminal)
      terminal.send(' please')
      expect(await terminal.snapshot({ includeScrollback: true })).toContain('[Image #1]')
      terminal.send('\r')
      await settle(terminal)

      expect(readClipboardImage).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 1024, cwd: '/workspace' }))
      expect(attachments.validateImage).toHaveBeenCalledTimes(1)
      expect(attachments.saveImage).toHaveBeenCalledTimes(1)
      expect(setup.agent.sent[0]).toEqual([
        { type: 'text', text: 'describe ' },
        {
          type: 'image',
          attachment: {
            attachmentId: 'clipboard-1', mediaType: 'image/png', bytes: 4, width: 1, height: 1, name: 'clipboard.png',
          },
        },
        { type: 'text', text: ' please' },
      ])
      expect(JSON.stringify(setup.session.events)).not.toContain('137,80,78,71')

      terminal.send('\x16')
      await settle(terminal)
      terminal.send('\r')
      await settle(terminal)
      expect(setup.agent.sent[1]).toEqual([
        {
          type: 'image',
          attachment: {
            attachmentId: 'clipboard-2', mediaType: 'image/png', bytes: 4, width: 1, height: 1, name: 'clipboard.png',
          },
        },
      ])
    } finally {
      await disposeTuiTestHarness(setup)
      await terminal.dispose()
    }
  })

  it('restores the marker and performs no write when the selected model is text-only', async () => {
    const terminal = new HeadlessTerminal(88, 32)
    const attachments = fakeAttachments()
    const setup = await createTuiTestHarness(terminal, vi.fn(), {
      attachments: attachments.service,
      readClipboardImage: () => Promise.resolve({ data: Uint8Array.of(1), mediaType: 'image/png' }),
      agentOptions: { provider: 'vision', model: 'model' },
      catalog: catalog(['text']),
    })
    try {
      terminal.send('\x1bv')
      await settle(terminal)
      terminal.send('\r')
      await settle(terminal)
      expect(setup.agent.sent).toEqual([])
      expect(attachments.validateImage).not.toHaveBeenCalled()
      expect(attachments.saveImage).not.toHaveBeenCalled()
      const snapshot = await terminal.snapshot({ includeScrollback: true })
      expect(snapshot).toContain('[Image #1]')
      expect(snapshot).toContain('does not support image input')
    } finally {
      await disposeTuiTestHarness(setup)
      await terminal.dispose()
    }
  })

  it('validates a multi-image draft as a batch before saving any member', async () => {
    const terminal = new HeadlessTerminal(88, 32)
    const attachments = fakeAttachments(input => input.data[0] === 2
      ? Promise.reject(new Error('second image is invalid'))
      : Promise.resolve())
    let byte = 0
    const setup = await createTuiTestHarness(terminal, vi.fn(), {
      attachments: attachments.service,
      readClipboardImage: () => Promise.resolve({ data: Uint8Array.of(++byte), mediaType: 'image/png' }),
      agentOptions: { provider: 'vision', model: 'model' },
      catalog: catalog(['text', 'image']),
    })
    try {
      terminal.send('\x1bv')
      await settle(terminal)
      terminal.send(' and ')
      terminal.send('\x1bv')
      await settle(terminal)
      terminal.send('\r')
      await settle(terminal)
      expect(attachments.validateImage).toHaveBeenCalledTimes(2)
      expect(attachments.saveImage).not.toHaveBeenCalled()
      expect(setup.agent.sent).toEqual([])
      const snapshot = await terminal.snapshot({ includeScrollback: true })
      expect(snapshot).toContain('[Image #1] and [Image #2]')
      expect(snapshot).toContain('second image is invalid')
    } finally {
      await disposeTuiTestHarness(setup)
      await terminal.dispose()
    }
  })

  it('degrades explicitly for missing readers, stores, and clipboard images', async () => {
    const cases = [
      {
        options: { attachments: fakeAttachments().service },
        expected: 'no clipboard reader',
      },
      {
        options: { readClipboardImage: vi.fn(() => Promise.resolve(undefined)) },
        expected: 'no attachment store',
      },
      {
        options: {
          attachments: fakeAttachments().service,
          readClipboardImage: vi.fn(() => Promise.resolve(undefined)),
        },
        expected: 'No image found in the clipboard',
      },
    ] as const
    for (const testCase of cases) {
      const terminal = new HeadlessTerminal(88, 32)
      const setup = await createTuiTestHarness(terminal, vi.fn(), testCase.options)
      try {
        terminal.send('\x1bv')
        await settle(terminal)
        expect(await terminal.snapshot({ includeScrollback: true })).toContain(testCase.expected)
      } finally {
        await disposeTuiTestHarness(setup)
        await terminal.dispose()
      }
    }
  })
})
