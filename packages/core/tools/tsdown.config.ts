import { defineConfig } from 'tsdown'

// `bootstrap` is a public Cordis plugin entry, so it must remain a standalone
// file beside the package's ordinary index and invariant entries.
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/bootstrap.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
