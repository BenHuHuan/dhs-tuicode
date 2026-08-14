export const name = 'tui-late-failure'

export function apply(ctx) {
  let armed = true
  ctx.on('tui-agent/ready', () => {
    if (!armed) return
    armed = false
    setImmediate(() => {
      void Promise.reject(new Error('scripted late TUI sibling failure'))
    })
  })
}
