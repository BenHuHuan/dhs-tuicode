import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeTextFile } from '../src/text-file.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-text-file-'))
  temporaryDirectories.push(root)
  return root
}

describe('response text file writer', () => {
  it('creates a relative target with exact UTF-8 bytes and reports its resolved path', async () => {
    const cwd = await temporaryDirectory()
    const text = 'first line\n世界\n\u001b]2;literal\u0007'
    const result = await writeTextFile({
      path: 'answer.md',
      text,
      overwrite: false,
      signal: new AbortController().signal,
      cwd,
    })

    expect(result).toEqual({ kind: 'written', path: resolve(cwd, 'answer.md') })
    await expect(readFile(join(cwd, 'answer.md'), 'utf8')).resolves.toBe(text)
  })

  it('does not alter an existing file until overwrite is explicit', async () => {
    const cwd = await temporaryDirectory()
    const request = {
      path: 'answer.txt',
      signal: new AbortController().signal,
      cwd,
    }
    await writeTextFile({ ...request, text: 'original', overwrite: false })

    await expect(writeTextFile({ ...request, text: 'replacement', overwrite: false }))
      .resolves.toEqual({ kind: 'exists', path: resolve(cwd, 'answer.txt') })
    await expect(readFile(join(cwd, 'answer.txt'), 'utf8')).resolves.toBe('original')

    await expect(writeTextFile({ ...request, text: 'replacement', overwrite: true }))
      .resolves.toEqual({ kind: 'written', path: resolve(cwd, 'answer.txt') })
    await expect(readFile(join(cwd, 'answer.txt'), 'utf8')).resolves.toBe('replacement')
  })

  it('rejects empty paths, missing parents, and an already-aborted operation', async () => {
    const cwd = await temporaryDirectory()
    const signal = new AbortController().signal
    await expect(writeTextFile({ path: '  ', text: 'x', overwrite: false, signal, cwd }))
      .rejects.toThrow('must not be empty')
    await expect(writeTextFile({ path: 'missing/answer.txt', text: 'x', overwrite: false, signal, cwd }))
      .rejects.toThrow()

    const controller = new AbortController()
    controller.abort(new Error('test cancelled'))
    await expect(writeTextFile({
      path: 'cancelled.txt',
      text: 'x',
      overwrite: false,
      signal: controller.signal,
      cwd,
    })).rejects.toThrow('test cancelled')
  })
})
