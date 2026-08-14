import { describe, expect, it } from 'vitest'
import {
  selectClipboardTextCommands,
  writeTextToClipboard,
} from '../src/clipboard-text.ts'

function request(text: string, signal = new AbortController().signal) {
  return { text, signal, cwd: process.cwd() }
}

describe('clipboard text process boundary', () => {
  it('selects shell-free platform helpers and honors an exact argv override', () => {
    expect(selectClipboardTextCommands({ platform: 'win32' })[0]?.argv.slice(0, 5))
      .toEqual(['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-STA'])
    expect(selectClipboardTextCommands({ platform: 'linux', environment: {} }).map(item => item.argv[0]))
      .toEqual(['wl-copy', 'xclip'])
    expect(selectClipboardTextCommands({ platform: 'linux', environment: { WSL_INTEROP: '/run/WSL/1_interop' } })[0]?.argv[0])
      .toBe('powershell.exe')
    expect(selectClipboardTextCommands({ platform: 'darwin' })[0]?.argv).toEqual(['pbcopy'])
    expect(selectClipboardTextCommands({ command: ['custom-writer', '--stdin'] }))
      .toEqual([{ argv: ['custom-writer', '--stdin'] }])
    expect(() => selectClipboardTextCommands({ command: [] })).toThrow('non-empty executable')
  })

  it('writes the exact UTF-8 payload on stdin without putting it in argv', async () => {
    const expected = 'first line\n世界\n\u001b]2;literal\u0007'
    const verifier = [
      'const chunks=[];',
      'process.stdin.on("data", chunk => chunks.push(chunk));',
      'process.stdin.on("end", () => {',
      ' const actual=Buffer.concat(chunks);',
      ' const expected=Buffer.from(process.env.DSH_COPY_EXPECT, "base64");',
      ' if (!actual.equals(expected)) { process.stderr.write("payload mismatch"); process.exit(9); }',
      '});',
    ].join('')
    await expect(writeTextToClipboard(request(expected), {
      command: [process.execPath, '-e', verifier],
      environment: {
        ...process.env,
        DSH_COPY_EXPECT: Buffer.from(expected).toString('base64'),
      },
    })).resolves.toBeUndefined()
  })

  it('reports empty input, process failure, startup failure, and cancellation', async () => {
    await expect(writeTextToClipboard(request(''), {
      command: [process.execPath, '-e', 'process.exit(0)'],
    })).rejects.toThrow('must not be empty')
    await expect(writeTextToClipboard(request('text'), {
      command: [process.execPath, '-e', 'process.stdin.resume(); process.stderr.write("broken"); process.exit(7)'],
    })).rejects.toThrow('exit code 7: broken')
    await expect(writeTextToClipboard(request('text'), {
      command: ['dsh-definitely-missing-clipboard-writer'],
    })).rejects.toThrow('failed to start')

    const controller = new AbortController()
    const writing = writeTextToClipboard(request('text', controller.signal), {
      command: [process.execPath, '-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'],
    })
    controller.abort(new Error('test cancelled'))
    await expect(writing).rejects.toThrow('test cancelled')
  })
})
