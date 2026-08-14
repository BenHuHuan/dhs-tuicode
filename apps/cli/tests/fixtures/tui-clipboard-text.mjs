// Cross-platform clipboard writer fixture: consume exact UTF-8 stdin and
// persist it in the isolated PTY workspace for post-run inspection.
import { writeFile } from 'node:fs/promises'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
await writeFile('./clipboard-text-output.txt', Buffer.concat(chunks))
