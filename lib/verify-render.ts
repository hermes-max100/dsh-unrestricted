/**
 * Render verification via ffprobe.
 *
 * The through-line of every bug in the original pipeline was claiming success
 * without evidence: `print()` calls standing in for generation, a QA monitor
 * counting .mp4 files nothing wrote, an activity log asserting "Posted 11
 * videos". This module is the opposite contract. A render is verified only if
 * ffprobe actually read each property off the file, and every check records
 * what was expected and what was observed.
 *
 * It never infers a property it did not measure, and it never throws on a bad
 * input — a missing, empty or non-video file is a `false` result with a reason,
 * because an unverifiable render is a normal outcome, not a crash.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface RenderSpec {
  /** Reduced ratio, e.g. "9:16" for vertical short-form. */
  expectAspectRatio?: string
  expectDurationSeconds?: number
  /** Encoders land a frame or two off; default 0.5s. */
  durationToleranceSeconds?: number
  requireAudio?: boolean
  minWidth?: number
  minBytes?: number
}

/** Only properties ffprobe actually reported. Nothing derived by assumption. */
export interface RenderFacts {
  path: string
  bytes: number
  sha256: string
  width: number
  height: number
  /** gcd-reduced from the measured width and height. */
  aspectRatio: string
  durationSeconds: number
  hasAudio: boolean
  videoCodec: string
  audioCodec: string | null
}

export interface CheckResult {
  name: string
  passed: boolean
  expected: string
  observed: string
}

export type Verification =
  | { ok: true; facts: RenderFacts; checks: CheckResult[] }
  | { ok: false; reason: string; facts: RenderFacts | null; checks: CheckResult[] }

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/** Reduce measured dimensions to a ratio string, e.g. 1080x1920 -> "9:16". */
export function reduceRatio(width: number, height: number): string {
  if (width <= 0 || height <= 0) return 'unknown'
  const d = gcd(width, height)
  return `${width / d}:${height / d}`
}

/** Exported so the stills module hashes identically. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  duration?: string
}

/** Read facts off the file. Returns null when ffprobe cannot parse it at all. */
async function probe(path: string): Promise<RenderFacts | null> {
  let bytes: number
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    bytes = info.size
  } catch {
    return null
  }
  if (bytes === 0) {
    // ffprobe on an empty file yields nothing useful; report the size itself.
    return {
      path, bytes, sha256: await sha256File(path),
      width: 0, height: 0, aspectRatio: 'unknown', durationSeconds: 0,
      hasAudio: false, videoCodec: 'none', audioCodec: null,
    }
  }

  let parsed: { streams?: ProbeStream[]; format?: { duration?: string } }
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      path,
    ])
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }

  const streams = parsed.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')
  if (!video) {
    return {
      path, bytes, sha256: await sha256File(path),
      width: 0, height: 0, aspectRatio: 'unknown', durationSeconds: 0,
      hasAudio: Boolean(audio), videoCodec: 'none',
      audioCodec: audio?.codec_name ?? null,
    }
  }

  const width = video.width ?? 0
  const height = video.height ?? 0
  // Container duration is more reliable than the stream's for short clips.
  const durationSeconds = Number.parseFloat(
    parsed.format?.duration ?? video.duration ?? '0',
  )

  return {
    path,
    bytes,
    sha256: await sha256File(path),
    width,
    height,
    aspectRatio: reduceRatio(width, height),
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    hasAudio: Boolean(audio),
    videoCodec: video.codec_name ?? 'unknown',
    audioCodec: audio?.codec_name ?? null,
  }
}

/**
 * Verify a rendered file against a spec.
 *
 * Returns ok:false with the facts attached whenever a check fails, so a caller
 * can log exactly which property was wrong rather than retrying blind.
 */
export async function verifyRender(
  path: string,
  spec: RenderSpec = {},
): Promise<Verification> {
  const facts = await probe(path)
  if (facts === null) {
    return {
      ok: false,
      reason: `not a readable media file: ${path}`,
      facts: null,
      checks: [],
    }
  }

  const checks: CheckResult[] = []
  const add = (name: string, passed: boolean, expected: string, observed: string) =>
    checks.push({ name, passed, expected, observed })

  const minBytes = spec.minBytes ?? 1
  add('non-empty', facts.bytes >= minBytes, `>= ${minBytes} bytes`, `${facts.bytes} bytes`)
  add('has video stream', facts.videoCodec !== 'none', 'a video stream', facts.videoCodec)

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
  if (spec.expectDurationSeconds !== undefined) {
    const tol = spec.durationToleranceSeconds ?? 0.5
    const delta = Math.abs(facts.durationSeconds - spec.expectDurationSeconds)
    add(
      'duration',
      delta <= tol,
      `${spec.expectDurationSeconds}s +/- ${tol}s`,
      `${facts.durationSeconds.toFixed(3)}s`,
    )
  }
  if (spec.requireAudio === true) {
    add('has audio', facts.hasAudio, 'an audio stream', facts.audioCodec ?? 'none')
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
