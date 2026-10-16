/**
 * Input-still verification and normalization.
 *
 * H3 Max exposes no aspect-ratio parameter: image-to-video inherits the source
 * still's ratio. A 16:9 character image therefore yields a 16:9 render, and the
 * output verifier would only catch that *after* the render was paid for.
 * Checking the still first turns a billed mistake into a free one.
 *
 * Same contract as the output verifier: every check records expected versus
 * observed, nothing is inferred that was not measured, and an unreadable file
 * is a reasoned failure rather than a throw.
 */
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { reduceRatio, sha256File, type CheckResult } from './verify-render.ts'

const run = promisify(execFile)

export interface StillSpec {
  /** Reduced ratio, e.g. "9:16". */
  expectAspectRatio?: string
  minWidth?: number
  minHeight?: number
  minBytes?: number
}

export interface StillFacts {
  path: string
  bytes: number
  sha256: string
  width: number
  height: number
  aspectRatio: string
  codec: string
}

export type StillVerification =
  | { ok: true; facts: StillFacts; checks: CheckResult[] }
  | { ok: false; reason: string; facts: StillFacts | null; checks: CheckResult[] }

/** Read dimensions off an image with ffprobe. null when it is not an image. */
async function probeStill(path: string): Promise<StillFacts | null> {
  let bytes: number
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    bytes = info.size
  } catch {
    return null
  }
  if (bytes === 0) return null

  let parsed: { streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }> }
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_streams', path,
    ])
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }

  const image = (parsed.streams ?? []).find((s) => s.codec_type === 'video')
  if (!image || !image.width || !image.height) return null

  return {
    path,
    bytes,
    sha256: await sha256File(path),
    width: image.width,
    height: image.height,
    aspectRatio: reduceRatio(image.width, image.height),
    codec: image.codec_name ?? 'unknown',
  }
}

/** Verify a character still before it is sent to a paid render. */
export async function verifyStill(
  path: string,
  spec: StillSpec = {},
): Promise<StillVerification> {
  const facts = await probeStill(path)
  if (facts === null) {
    return { ok: false, reason: `not a readable image: ${path}`, facts: null, checks: [] }
  }

  const checks: CheckResult[] = []
  const add = (name: string, passed: boolean, expected: string, observed: string) =>
    checks.push({ name, passed, expected, observed })

  const minBytes = spec.minBytes ?? 1
  add('non-empty', facts.bytes >= minBytes, `>= ${minBytes} bytes`, `${facts.bytes} bytes`)
  if (spec.expectAspectRatio !== undefined) {
    add(
      'aspect ratio',
      facts.aspectRatio === spec.expectAspectRatio,
      spec.expectAspectRatio,
      `${facts.aspectRatio} (${facts.width}x${facts.height})`,
    )
  }
  if (spec.minWidth !== undefined) {
    add('min width', facts.width >= spec.minWidth, `>= ${spec.minWidth}px`, `${facts.width}px`)
  }
  if (spec.minHeight !== undefined) {
    add('min height', facts.height >= spec.minHeight, `>= ${spec.minHeight}px`, `${facts.height}px`)
  }

  const failed = checks.filter((c) => !c.passed)
  if (failed.length > 0) {
    return {
      ok: false,
      reason: failed.map((c) => `${c.name}: expected ${c.expected}, got ${c.observed}`).join('; '),
      facts,
      checks,
    }
  }
  return { ok: true, facts, checks }
}

/** How to reconcile a source's shape with the target's. */
export type FitMode =
  /** Fill the frame, cropping whatever overflows. Subject-unaware. */
  | 'cover'
  /** Fit the whole subject inside the frame, padding the remainder. */
  | 'pad'

/**
 * Average the four corners of an image to a single RGB hex colour.
 *
 * Used to pick padding that matches the source's background instead of
 * assuming white: a cut-out on black pads black, one on white pads white.
 * The result is approximate, not bit-exact: encoders round-trip through YUV,
 * so a flat #1a2b4c source reads back as #192a4b. That is close enough for
 * padding to be invisible, but callers should not compare it for equality.
 * Returns null when the corners disagree enough that no single colour is
 * right — a photographic background, say — so the caller can fall back
 * rather than pad with a wrong average.
 */
export async function sampleBackgroundColor(
  path: string,
): Promise<string | null> {
  const facts = await probeStill(path)
  if (facts === null) return null
  const x = Math.max(0, facts.width - 8)
  const y = Math.max(0, facts.height - 8)
  const corners: Array<[number, number]> = [[0, 0], [x, 0], [0, y], [x, y]]

  const samples: Array<[number, number, number]> = []
  for (const [cx, cy] of corners) {
    try {
      const { stdout } = await run(
        'ffmpeg',
        ['-nostdin', '-loglevel', 'error', '-i', path,
         '-vf', `crop=8:8:${cx}:${cy},scale=1:1`,
         '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        { encoding: 'buffer', maxBuffer: 1024 },
      )
      const buf = stdout as unknown as Buffer
      if (buf.length < 3) return null
      samples.push([buf[0]!, buf[1]!, buf[2]!])
    } catch {
      return null
    }
  }

  const avg = [0, 1, 2].map(
    (i) => Math.round(samples.reduce((sum, s) => sum + s[i]!, 0) / samples.length),
  ) as [number, number, number]
  // If any corner is far from the average, the edges are not a flat
  // background and padding with the mean would be visible.
  const spread = Math.max(
    ...samples.flatMap((s) => s.map((v, i) => Math.abs(v - avg[i]!))),
  )
  if (spread > 24) return null
  return '#' + avg.map((v) => v.toString(16).padStart(2, '0')).join('')
}

/**
 * Resize a still to exact dimensions, then verify the result.
 *
 * `cover` fills the frame and crops the overflow; it is subject-unaware, so a
 * wide or off-centre subject loses whatever sits outside the frame, and the
 * dimensional check will still pass. `pad` fits the whole subject inside and
 * fills the remainder — the right choice for a cut-out on a flat background,
 * where the padding is invisible.
 *
 * The output is verified rather than assumed: a filter that silently did
 * nothing would otherwise read as success. Defaults to 1080x1920 (9:16).
 */
export async function normalizeStill(
  input: string,
  output: string,
  size: {
    width?: number
    height?: number
    fit?: FitMode
    /** Pad colour. 'auto' samples the source's corners. Ignored when fit is 'cover'. */
    padColor?: string
  } = {},
): Promise<StillVerification> {
  const width = size.width ?? 1080
  const height = size.height ?? 1920
  const fit: FitMode = size.fit ?? 'cover'

  // Reject the input first, so a bad source is not reported as a bad crop.
  const source = await probeStill(input)
  if (source === null) {
    return { ok: false, reason: `not a readable image: ${input}`, facts: null, checks: [] }
  }

  let filter: string
  if (fit === 'cover') {
    filter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
  } else {
    let pad = size.padColor ?? 'auto'
    if (pad === 'auto') {
      // Fall back to white when the edges are not a flat background; padding
      // with a wrong average would be worse than a neutral default.
      pad = (await sampleBackgroundColor(input)) ?? 'white'
    }
    filter =
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:${pad}`
  }

  try {
    await run('ffmpeg', [
      '-nostdin', '-loglevel', 'error', '-y',
      '-i', input,
      '-vf', filter,
      '-frames:v', '1',
      output,
    ])
  } catch (error) {
    return {
      ok: false,
      reason: `ffmpeg could not write ${output}: ${
        error instanceof Error ? error.message.split('\n')[0] : String(error)
      }`,
      facts: null,
      checks: [],
    }
  }

  return verifyStill(output, {
    expectAspectRatio: reduceRatio(width, height),
    minWidth: width,
    minHeight: height,
  })
}
