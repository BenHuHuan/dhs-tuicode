import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  editTextInExternalEditor,
  externalEditorDocument,
  externalEditorDraft,
  ExternalEditorShortcut,
  latestAssistantResponse,
  parseEditorCommand,
  selectExternalEditorCommand,
} from '../src/external-editor.ts'

const temporaryDirectories: string[] = []
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'external-editor.mjs')
const editorCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('external editor document and command boundary', () => {
  it('parses quoted commands while preserving ordinary path backslashes', () => {
    expect(parseEditorCommand('"C:\\Program Files\\Editor\\edit.exe" --wait "two words" \'\''))
      .toEqual(['C:\\Program Files\\Editor\\edit.exe', '--wait', 'two words', ''])
    expect(parseEditorCommand('C:\\Tools\\vim.exe -f escaped\\ value'))
      .toEqual(['C:\\Tools\\vim.exe', '-f', 'escaped value'])
    expect(() => parseEditorCommand('"unfinished')).toThrow('unterminated quote')
    expect(() => parseEditorCommand('   ')).toThrow('must not be empty')
  })

  it('prefers VISUAL, then EDITOR, then the platform default', () => {
    expect(selectExternalEditorCommand({ VISUAL: ' code --wait ', EDITOR: 'vim' }, 'linux')).toBe('code --wait')
    expect(selectExternalEditorCommand({ VISUAL: ' ', EDITOR: 'nano' }, 'linux')).toBe('nano')
    expect(selectExternalEditorCommand({}, 'win32')).toBe('notepad.exe')
    expect(selectExternalEditorCommand({}, 'darwin')).toBe('vi')
  })

  it('comments prior reply context and strips only its generated leading block', () => {
    const request = {
      draft: '# user heading\r\nbody',
      previousResponse: 'answer one\n# answer heading\n\nanswer four',
    }
    const document = externalEditorDocument(request)
    expect(document).toContain('# Previous assistant response')
    expect(document).toContain('# # answer heading')
    expect(externalEditorDraft(document.replace(/\n/gu, '\r\n'), true)).toBe('# user heading\nbody')
    expect(externalEditorDraft('# user heading\r\nbody', true)).toBe('# user heading\nbody')
    expect(externalEditorDraft(document.replace('</deepseek', '</changed'), true)).toContain('<deepseek-harness')
    expect(externalEditorDocument({ draft: '# mine' })).toBe('# mine')
  })

  it('finds the latest committed non-empty assistant text only', () => {
    const events = [
      { type: 'assistant/message', surfaceOp: 'append', seq: 1, data: { message: { content: [{ type: 'text', text: 'older' }] } } },
      { type: 'assistant/message', surfaceOp: 'append', seq: 2, data: { message: { content: [{ type: 'reasoning', text: 'hidden' }] } } },
      {
        type: 'assistant/message',
        surfaceOp: 'append',
        seq: 3,
        data: { message: { content: [{ type: 'text', text: 'new ' }, { type: 'text', text: 'answer' }] } },
      },
    ]
    expect(latestAssistantResponse(events as never)).toBe('new answer')
    expect(latestAssistantResponse([])).toBeUndefined()
  })

  it('recognizes direct and readline-native shortcuts without swallowing a following printable key', () => {
    const shortcut = new ExternalEditorShortcut()
    expect(shortcut.handle('\x07')).toBe('invoke')
    expect(shortcut.handle('\x18')).toBe('consume')
    expect(shortcut.handle('a')).toBe('pass')
    expect(shortcut.handle('\x05')).toBe('pass')
    expect(shortcut.handle('\x18\x05')).toBe('invoke')
    expect(shortcut.handle('\x18')).toBe('consume')
    expect(shortcut.handle('\x05')).toBe('invoke')
    shortcut.reset()
    expect(shortcut.handle('\x05')).toBe('pass')
  })

  it('waits for the editor, normalizes its saved text, and removes the private directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tui-editor-test-'))
    temporaryDirectories.push(root)
    const output = '\uFEFF# user heading\r\nline two\r\n'
    const edited = await editTextInExternalEditor({
      draft: 'draft',
      previousResponse: 'assistant context',
    }, {
      editor: editorCommand,
      temporaryDirectory: root,
      environment: {
        ...process.env,
        DSH_TUI_EDITOR_EXPECT: 'assistant context',
        DSH_TUI_EDITOR_OUTPUT_BASE64: Buffer.from(output).toString('base64'),
      },
    })
    expect(edited).toBe('# user heading\nline two\n')
    expect(await readdir(root)).toEqual([])
  })

  it('rejects a non-zero editor exit without leaving the private directory behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tui-editor-failure-'))
    temporaryDirectories.push(root)
    await expect(editTextInExternalEditor({ draft: 'unchanged' }, {
      editor: editorCommand,
      temporaryDirectory: root,
      environment: {
        ...process.env,
        DSH_TUI_EDITOR_EXIT: '7',
      },
    })).rejects.toThrow('exit code 7')
    expect(await readdir(root)).toEqual([])
  })

  it.skipIf(process.platform !== 'win32')('runs an explicitly configured .cmd editor and waits for it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tui-editor-cmd-'))
    temporaryDirectories.push(root)
    const command = join(root, 'editor with spaces.cmd')
    await writeFile(command, '@echo off\r\n> "%~1" echo edited through cmd\r\n')
    const edited = await editTextInExternalEditor({ draft: 'before' }, {
      editor: `"${command}"`,
      temporaryDirectory: root,
    })
    expect(edited).toBe('edited through cmd\n')
    expect(await readdir(root)).toEqual(['editor with spaces.cmd'])
  })
})
