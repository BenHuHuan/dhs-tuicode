import { describe, expect, it, vi } from 'vitest'
import { createPalette } from '../src/components/theme.ts'
import { CredentialLoginDialog } from '../src/components/credential-login.ts'

describe('CredentialLoginDialog', () => {
  it('submits a pasted token without ever rendering its value', async () => {
    const save = vi.fn(async () => {})
    const redraw = vi.fn()
    const dialog = new CredentialLoginDialog(false, undefined, createPalette(true), save, vi.fn(), redraw)
    const token = 'dsh-secret-pro-token'

    dialog.handleInput(`\u001B[200~${token}\u001B[201~`)
    expect(dialog.render(72).join('\n')).not.toContain(token)
    expect(dialog.render(72).join('\n')).toContain('•'.repeat(token.length))

    dialog.handleInput('\r')
    await vi.waitFor(() => { expect(save).toHaveBeenCalledWith(token) })
    expect(dialog.render(72).join('\n')).not.toContain(token)
  })

  it('reads the host text clipboard when the terminal sends a bare Ctrl+V key', async () => {
    const token = 'dsh-clipboard-token'
    const save = vi.fn(async () => {})
    const readClipboard = vi.fn(async () => token)
    const dialog = new CredentialLoginDialog(
      false, undefined, createPalette(true), save, vi.fn(), vi.fn(), readClipboard,
    )

    dialog.handleInput('\x16')
    await vi.waitFor(() => { expect(readClipboard).toHaveBeenCalledOnce() })
    expect(dialog.render(72).join('\n')).not.toContain(token)
    dialog.handleInput('\r')
    await vi.waitFor(() => { expect(save).toHaveBeenCalledWith(token) })
  })
})
