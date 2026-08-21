/**
 * Image-token estimate for vision requests. The sizing/token formula mirrors
 * the official DeepSeek image token calculator (token_usage.mdx § Calculate
 * image token usage): images below ~384×384 are scaled up, larger images are
 * scaled down toward ~800×800 total pixels, aspect ratio is preserved within
 * an 8:1 bound, and the estimate is capped at 384 tokens per image.
 *
 * @module @deepseek-ai/dsh-token-meter/image-tokens
 */

const PATCH_SIZE = 14
const DOWNSAMPLE_RATIO = 3
const MAX_IMAGE_TOKENS = 384
const COMPRESS_PAD_TO = 4
const MAX_WIDTH_HEIGHT_RATIO = 8
const MIN_PIXELS = 147_456

const floor = (value: number): number => Math.floor(value)
const ceilDiv = (value: number, divisor: number): number => floor((value + divisor - 1) / divisor)
const trunc = (value: number): number => Math.trunc(value)

/** Token count of one already-resized image, in llm-patch rows and columns. */
function patchTokens(height: number, width: number): number {
  let tokens = height * (width + 1) + 2
  if (height % 2 === 1) tokens += width + 1
  tokens += ceilDiv(height, 2) * (width + 1) % 2 * 2
  return tokens
}

interface ResizeResult {
  /** Resized width and height the token count came from. */
  bestWidth: number
  bestHeight: number
  /** Patch-grid dimensions and the resulting token count. */
  nLlmWidth: number
  nLlmHeight: number
  numTokens: number
}

/** Find the largest patch-grid size fitting one token budget at a fixed aspect ratio. */
function solveResizeRatio(height: number, width: number, tokenBudget: number): ResizeResult {
  const ratio = height / width
  const solvedHeight = Math.sqrt((tokenBudget - 2) / ratio + 0.25) - 0.5
  const solvedWidth = solvedHeight * ratio
  let bestWidth: number
  let bestHeight: number
  if (solvedHeight < 1) {
    const patchWidth = 1
    let patchHeight = floor((tokenBudget - 2) / (patchWidth + 1))
    if (patchHeight % 2 === 1) patchHeight -= 1
    bestHeight = patchHeight * PATCH_SIZE * DOWNSAMPLE_RATIO
    bestWidth = patchWidth * PATCH_SIZE * DOWNSAMPLE_RATIO
  } else if (solvedWidth < 2) {
    const patchHeight = 2
    const patchWidth = floor((tokenBudget - 2) / patchHeight) - 1
    if (patchWidth <= 1) throw new Error('assertion failed: max_w > 1')
    bestHeight = patchHeight * PATCH_SIZE * DOWNSAMPLE_RATIO
    bestWidth = patchWidth * PATCH_SIZE * DOWNSAMPLE_RATIO
  } else {
    const patchHeight = trunc(solvedHeight)
    let patchWidth = trunc(solvedWidth)
    if (patchWidth % 2 === 1) patchWidth -= 1
    const scaleForWidth = patchHeight * PATCH_SIZE * DOWNSAMPLE_RATIO / width
    const scaleForHeight = patchWidth * PATCH_SIZE * DOWNSAMPLE_RATIO / height
    const scale = Math.min(scaleForWidth, scaleForHeight)
    bestWidth = trunc(width * scale / PATCH_SIZE) * PATCH_SIZE
    bestHeight = trunc(height * scale / PATCH_SIZE) * PATCH_SIZE
  }
  const nLlmWidth = ceilDiv(Math.floor(bestWidth / PATCH_SIZE), DOWNSAMPLE_RATIO)
  const nLlmHeight = ceilDiv(Math.floor(bestHeight / PATCH_SIZE), DOWNSAMPLE_RATIO)
  return {
    nLlmWidth,
    nLlmHeight,
    bestWidth,
    bestHeight,
    numTokens: patchTokens(nLlmHeight, nLlmWidth),
  }
}

/** Resize one image toward the token cap, falling back through smaller budgets until it fits. */
function safeResize(width: number, height: number, bestWidth: number, bestHeight: number): ResizeResult {
  const patchWidth = ceilDiv(Math.floor(bestWidth / PATCH_SIZE), DOWNSAMPLE_RATIO)
  const patchHeight = ceilDiv(Math.floor(bestHeight / PATCH_SIZE), DOWNSAMPLE_RATIO)
  const compressedPadding = COMPRESS_PAD_TO - 1
  const tokenCap = MAX_IMAGE_TOKENS - compressedPadding
  let result: ResizeResult = {
    nLlmWidth: patchWidth,
    nLlmHeight: patchHeight,
    bestWidth,
    bestHeight,
    numTokens: patchTokens(patchHeight, patchWidth),
  }
  if (result.numTokens > tokenCap) {
    result = solveResizeRatio(height, width, tokenCap)
    let budget = tokenCap
    while (result.numTokens > tokenCap) {
      budget -= 1
      result = solveResizeRatio(height, width, budget)
    }
    if (result.numTokens > tokenCap) throw new Error('assertion failed: result.num_tokens <= max_n_token')
  }
  result.numTokens += compressedPadding
  return result
}

/** One resize attempt: clamp aspect ratio, honor the minimum pixel floor, then fit the token cap. */
function resizeImage(width: number, height: number): ResizeResult {
  const boundedWidth = width > height * MAX_WIDTH_HEIGHT_RATIO ? height * MAX_WIDTH_HEIGHT_RATIO : width
  let scaledWidth = boundedWidth
  let scaledHeight = height
  const pixels = scaledWidth * scaledHeight
  if (pixels < MIN_PIXELS && pixels > 0) {
    const scale = Math.sqrt(MIN_PIXELS / pixels)
    scaledWidth = trunc(scaledWidth * scale)
    scaledHeight = trunc(scaledHeight * scale)
  }
  const bestWidth = ceilDiv(scaledWidth, PATCH_SIZE) * PATCH_SIZE
  const bestHeight = ceilDiv(scaledHeight, PATCH_SIZE) * PATCH_SIZE
  return safeResize(scaledWidth, scaledHeight, bestWidth, bestHeight)
}

/**
 * Estimate the input tokens one image costs on the DeepSeek vision route.
 * The provider-reported `usage` remains authoritative; this is the same
 * dimension-only estimate the official calculator exposes.
 * @param width - intrinsic encoded width in pixels.
 * @param height - intrinsic encoded height in pixels.
 * @returns the estimated token count, capped at 384 per image.
 */
export function estimateImageTokens(width: number, height: number): number {
  let result = resizeImage(width, height)
  for (let iteration = 1; iteration < 10; iteration++) {
    const next = resizeImage(result.bestWidth, result.bestHeight)
    if (
      next.nLlmHeight === result.nLlmHeight
      && next.nLlmWidth === result.nLlmWidth
      && next.bestHeight === result.bestHeight
      && next.bestWidth === result.bestWidth
      && next.numTokens === result.numTokens
    ) return result.numTokens
    result = next
  }
  throw new Error(`image token resize did not converge after 10 iterations: ${JSON.stringify(result)}`)
}
