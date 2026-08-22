import { describe, expect, it } from 'vitest'
import {
  readImageFromClipboard,
  selectClipboardImageCommands,
} from '../src/clipboard-image.ts'

function request(maxBytes = 1024, signal = new AbortController().signal) {
  return { maxBytes, signal, cwd: process.cwd() }
}

describe('clipboard image process boundary', () => {
  it('selects shell-free platform helpers and honors an exact argv override', () => {
    const windows = selectClipboardImageCommands({ platform: 'win32' })[0]
    expect(windows?.argv.slice(0, 5))
      .toEqual(['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-STA'])
    const windowsScript = windows?.argv.at(-1)
    expect(windowsScript).toContain('GetData("PNG", $false)')
    expect(windowsScript).toContain('ContainsFileDropList()')
    expect(windowsScript).toContain('GetImage()')
    expect(selectClipboardImageCommands({ platform: 'linux', environment: {} }).map(item => item.argv[0]))
      .toEqual(['wl-paste', 'xclip'])
    expect(selectClipboardImageCommands({ platform: 'linux', environment: { WSL_DISTRO_NAME: 'Ubuntu' } })[0]?.argv[0])
      .toBe('powershell.exe')
    expect(selectClipboardImageCommands({ platform: 'darwin' })[0]?.argv).toEqual(['pngpaste', '-'])
    expect(selectClipboardImageCommands({ command: ['custom-reader', '--png'] }))
      .toEqual([{ argv: ['custom-reader', '--png'], noImageExitCodes: [3] }])
    expect(() => selectClipboardImageCommands({ command: [] })).toThrow('non-empty executable')
  })

  it('captures binary PNG stdout and treats exit 3 as an empty clipboard', async () => {
    const image = await readImageFromClipboard(request(), {
      command: [process.execPath, '-e', 'process.stdout.write(Buffer.from([0, 255, 1, 2]))'],
    })
    expect(image).toEqual({
      data: Uint8Array.of(0, 255, 1, 2),
      mediaType: 'image/png',
      name: 'clipboard.png',
    })
    await expect(readImageFromClipboard(request(), {
      command: [process.execPath, '-e', 'process.exit(3)'],
    })).resolves.toBeUndefined()
  })

  it('enforces the byte cap, reports process failure, and propagates cancellation', async () => {
    await expect(readImageFromClipboard(request(2), {
      command: [process.execPath, '-e', 'process.stdout.write(Buffer.alloc(3))'],
    })).rejects.toThrow('2-byte limit')
    await expect(readImageFromClipboard(request(), {
      command: [process.execPath, '-e', 'process.stderr.write("broken"); process.exit(7)'],
    })).rejects.toThrow('exit code 7: broken')

    const controller = new AbortController()
    const reading = readImageFromClipboard(request(1024, controller.signal), {
      command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    })
    controller.abort(new Error('test cancelled'))
    await expect(reading).rejects.toThrow('test cancelled')
  })
})
