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

/**
 * Cover-crop a still to exact dimensions, then verify the result.
 *
 * The output is verified rather than assumed: a filter that silently did
 * nothing would otherwise read as success. Defaults to 1080x1920 (9:16).
 */
export async function normalizeStill(
  input: string,
  output: string,
  size: { width?: number; height?: number } = {},
): Promise<StillVerification> {
  const width = size.width ?? 1080
  const height = size.height ?? 1920

  // Reject the input first, so a bad source is not reported as a bad crop.
  const source = await probeStill(input)
  if (source === null) {
    return { ok: false, reason: `not a readable image: ${input}`, facts: null, checks: [] }
  }

  try {
    await run('ffmpeg', [
      '-nostdin', '-loglevel', 'error', '-y',
      '-i', input,
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
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
