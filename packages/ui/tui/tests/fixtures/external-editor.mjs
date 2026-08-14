import { readFile, writeFile } from 'node:fs/promises'

const file = process.argv.at(-1)
if (file === undefined) throw new Error('external-editor fixture did not receive a file')
const initial = await readFile(file, 'utf8')
const expected = process.env.DSH_TUI_EDITOR_EXPECT
if (expected !== undefined && !initial.includes(expected)) {
  throw new Error(`external-editor fixture did not find ${JSON.stringify(expected)}`)
}
const exitCode = Number(process.env.DSH_TUI_EDITOR_EXIT ?? '0')
if (exitCode !== 0) process.exit(exitCode)
const encoded = process.env.DSH_TUI_EDITOR_OUTPUT_BASE64
if (encoded === undefined) throw new Error('external-editor fixture has no output')
await writeFile(file, Buffer.from(encoded, 'base64'))
