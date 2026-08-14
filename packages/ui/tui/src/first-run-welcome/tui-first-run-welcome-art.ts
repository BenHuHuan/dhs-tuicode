/**
 * Static terminal rasters derived from the official 24x24 DeepSeek icon.
 *
 * Source: `../../assets/deepseek-color.svg`, whose path data is copied exactly
 * from the supplied official icon (viewBox `0 0 24 24`, fill `#4D6BFE`). Each
 * tier rasterizes that path into a square binary
 * mask without redrawing its contour. The Unicode form packs two source rows
 * into `▀`/`▄`/`█`; the ASCII fallback packs the same two bits into
 * `'`/`_`/`#`. Assets contain no ANSI and are never generated at runtime.
 * @module @deepseek-ai/dsh/tui-onboarding/tui-first-run-welcome-art
 */

/** Responsive official-icon raster tier. */
export type TuiFirstRunWelcomeArtTier = 'full' | 'compact' | 'minimal'

/** One raster with a block-cell primary and bit-equivalent ASCII fallback. */
export interface TuiFirstRunWelcomeArt {
  /** Two vertical source pixels per terminal cell. */
  readonly unicode: readonly string[]
  /** Same two-bit cells encoded as top `'`, bottom `_`, and both `#`. */
  readonly ascii: readonly string[]
}

const fullUnicode = Object.freeze([
  '                           ▄',
  '       ▄▄▄▄▄▄▄▄▄▄███▀      ██▄',
  '    ▄███████████████▄      ████▄  ▄▄▄▄██',
  '  ▄███████████████████▄    ████████████▀',
  ' ▄██████████████████████▄   ▀█████████▀',
  '▄███▀█████████████████████▄   ████▀▀',
  '███       ▀▀█████████▀▀▀█████████▀',
  '███          ▀███████▀█  ▀███████',
  '███▄           ▀███████▄  ▀█████▀',
  '▀███             ▀██████████████',
  ' ▀███▄            ▀███████████▀',
  '  ▀███▄      ▄▄▄    ▀████████▀',
  '    █████▄    ███▄▄   ▀█████▄▄',
  '      ▀█████████████▄▄▄▄█▀█████▀',
  '        ▀▀███████████▀▀',
])

const fullAscii = Object.freeze([
  '                           _',
  "       __________###'      ##_",
  '    _###############_      ####_  ____##',
  "  _###################_    ############'",
  " _######################_   '#########'",
  "_###'#####################_   ####''",
  "###       ''#########'''#########'",
  "###          '#######'#  '#######",
  "###_           '#######_  '#####'",
  "'###             '##############",
  " '###_            '###########'",
  "  '###_      ___    '########'",
  "    #####_    ###__   '#####__",
  "      '#############____#'#####'",
  "        ''###########''",
])

const compactUnicode = Object.freeze([
  '     ▄▄▄▄▄▄▄██▀    █▄      ▄',
  '  ▄███████████▄▄   ███▄▄████',
  ' ████████████████▄ ▀██████▀',
  '██▀▀▀▀▀████████████▄▄██▀',
  '██       ▀█████▄ ▀█████',
  '██▄        ▀████▄ ▄████',
  ' ██▄         ████████▀',
  '  ██▄    ▄▄   ▀█████▀',
  '   ▀███▄▄▄███▄  ████▄▄',
  '     ▀▀▀███████▀▀',
])

const compactAscii = Object.freeze([
  "     _______##'    #_      _",
  '  _###########__   ###__####',
  " ################_ '######'",
  "##'''''############__##'",
  "##       '#####_ '#####",
  "##_        '####_ _####",
  " ##_         ########'",
  "  ##_    __   '#####'",
  "   '###___###_  ####__",
  "     '''#######''",
])

const minimalUnicode = Object.freeze([
  '   ▄▄▄▄▄▄   ▄▄',
  ' ▄████████▄ ▀████▀',
  '█▀▀▀▀███████▄██▀',
  '█▄    ▀███ ▀███',
  '▀█▄     ▀█████',
  ' ▀█▄▄ █▄▄▀███▄',
  '    ▀▀▀▀▀▀',
])

const minimalAscii = Object.freeze([
  '   ______   __',
  " _########_ '####'",
  "#''''#######_##'",
  "#_    '### '###",
  "'#_     '#####",
  " '#__ #__'###_",
  "    ''''''",
])

/** Exact-path terminal rasters by responsive tier. */
export const TUI_FIRST_RUN_WELCOME_WHALE = Object.freeze({
  full: Object.freeze({ unicode: fullUnicode, ascii: fullAscii }),
  compact: Object.freeze({ unicode: compactUnicode, ascii: compactAscii }),
  minimal: Object.freeze({ unicode: minimalUnicode, ascii: minimalAscii }),
}) satisfies Readonly<Record<TuiFirstRunWelcomeArtTier, TuiFirstRunWelcomeArt>>
