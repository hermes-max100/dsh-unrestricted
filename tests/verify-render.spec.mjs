import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyRender, reduceRatio } from '../lib/verify-render.ts'

const run = promisify(execFile)
let dir
const p = (name) => join(dir, name)

/** Real files, produced by ffmpeg, with properties we therefore know. */
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'verify-'))
  await run('ffmpeg', ['-nostdin', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=blue:s=1080x1920:r=24:d=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-t', '5',
    p('vertical-audio.mp4')])
  await run('ffmpeg', ['-nostdin', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=1920x1080:r=24:d=5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '5', p('landscape-silent.mp4')])
  await run('ffmpeg', ['-nostdin', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=green:s=1080x1920:r=24:d=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '2', p('vertical-2s.mp4')])
  await writeFile(p('empty.mp4'), '')
  await writeFile(p('notavideo.mp4'), 'this is plain text, not media')
})
after(async () => { await rm(dir, { recursive: true, force: true }) })

const REEL = { expectAspectRatio: '9:16', expectDurationSeconds: 5, requireAudio: true, minWidth: 1080 }

test('reduceRatio reduces measured dimensions', () => {
  assert.equal(reduceRatio(1080, 1920), '9:16')
  assert.equal(reduceRatio(1920, 1080), '16:9')
  assert.equal(reduceRatio(1000, 1000), '1:1')
  assert.equal(reduceRatio(0, 0), 'unknown')
})

test('a conforming reel passes and reports measured facts', async () => {
  const r = await verifyRender(p('vertical-audio.mp4'), REEL)
  assert.equal(r.ok, true, r.ok ? '' : r.reason)
  assert.equal(r.facts.width, 1080)
  assert.equal(r.facts.height, 1920)
  assert.equal(r.facts.aspectRatio, '9:16')
  assert.ok(Math.abs(r.facts.durationSeconds - 5) < 0.5)
  assert.equal(r.facts.hasAudio, true)
  assert.equal(r.facts.videoCodec, 'h264')
  assert.equal(r.facts.audioCodec, 'aac')
  assert.match(r.facts.sha256, /^[0-9a-f]{64}$/)
  assert.ok(r.facts.bytes > 0)
  assert.ok(r.checks.every((c) => c.passed))
})

test('the hash is stable across reads', async () => {
  const a = await verifyRender(p('vertical-audio.mp4'), REEL)
  const b = await verifyRender(p('vertical-audio.mp4'), REEL)
  assert.equal(a.facts.sha256, b.facts.sha256)
})

test('wrong aspect ratio fails and names the mismatch', async () => {
  const r = await verifyRender(p('landscape-silent.mp4'), { expectAspectRatio: '9:16' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /aspect ratio/)
  assert.match(r.reason, /16:9/)
  assert.equal(r.facts.aspectRatio, '16:9', 'facts are still attached on failure')
})

test('duration outside tolerance fails, inside passes', async () => {
  const bad = await verifyRender(p('vertical-2s.mp4'), { expectDurationSeconds: 5 })
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /duration/)
  const ok = await verifyRender(p('vertical-2s.mp4'), {
    expectDurationSeconds: 2, durationToleranceSeconds: 0.5,
  })
  assert.equal(ok.ok, true, ok.ok ? '' : ok.reason)
})

test('requireAudio fails on a silent clip', async () => {
  const r = await verifyRender(p('landscape-silent.mp4'), { requireAudio: true })
  assert.equal(r.ok, false)
  assert.match(r.reason, /has audio/)
  assert.equal(r.facts.hasAudio, false)
})

test('an empty file fails without throwing', async () => {
  const r = await verifyRender(p('empty.mp4'), REEL)
  assert.equal(r.ok, false)
  assert.match(r.reason, /non-empty|video stream/)
})

test('a non-media file fails without throwing', async () => {
  const r = await verifyRender(p('notavideo.mp4'), REEL)
  assert.equal(r.ok, false)
})

test('a missing file fails without throwing', async () => {
  const r = await verifyRender(p('does-not-exist.mp4'), REEL)
  assert.equal(r.ok, false)
  assert.equal(r.facts, null)
  assert.match(r.reason, /not a readable media file/)
})

test('checks record expected versus observed for every property', async () => {
  const r = await verifyRender(p('landscape-silent.mp4'), REEL)
  assert.equal(r.ok, false)
  const names = r.checks.map((c) => c.name)
  for (const n of ['non-empty', 'has video stream', 'aspect ratio', 'min width', 'duration', 'has audio']) {
    assert.ok(names.includes(n), `missing check: ${n}`)
  }
  for (const c of r.checks) {
    assert.equal(typeof c.expected, 'string')
    assert.equal(typeof c.observed, 'string')
  }
})
