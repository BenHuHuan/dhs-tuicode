// Cross-platform clipboard command fixture: stdout is one valid 1×1 PNG and
// contains no framing, text, path, or base64. The TUI's attachment store is the
// authoritative decoder and durable owner after the draft is submitted.
process.stdout.write(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
))
