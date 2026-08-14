import { readFile, writeFile } from 'node:fs/promises'

const file = process.argv.at(-1)
if (file === undefined) throw new Error('TUI external-editor fixture did not receive a file')
const document = await readFile(file, 'utf8')
const expected = process.env.DSH_TUI_EDITOR_EXPECT
if (expected === undefined || !document.includes(expected)) {
  throw new Error(`TUI external-editor fixture did not receive context ${JSON.stringify(expected)}`)
}
if (!document.includes('external seed')) {
  throw new Error('TUI external-editor fixture did not receive the current draft')
}
process.stdout.write('DSH_EXTERNAL_EDITOR_STARTED\n')
await writeFile(file, 'External editor PTY prompt.')
