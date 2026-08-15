import { defineConfig } from 'tsdown'
import { typertPlugin } from '../../typert/generator/lib/types/tsdown-plugin.js'

/**
 * The connection registry is a Loader-facing plugin entry, rather than an
 * implementation-only module. Keep it as a named host artifact alongside the
 * ordinary client and invariant entries so a built TUI profile can import
 * `@deepseek-ai/dsh-mcp-client/registry` without a source loader.
 */
export default defineConfig({
  entry: [
    'lib/types/index.js',
    'lib/types/invariant.js',
    'lib/types/registry.js',
  ],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  plugins: [typertPlugin({ mode: 'workspace', faces: ['host'] })],
})
