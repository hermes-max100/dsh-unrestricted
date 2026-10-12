import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyStill, normalizeStill } from '../lib/stills.ts'

const run = promisify(execFile)
let dir
const p = (n) => join(dir, n)
const img = (name, size) => run('ffmpeg', ['-nostdin', '-loglevel', 'error',
  '-f', 'lavfi', '-i', `testsrc=s=${size}`, '-frames:v', '1', p(name)])

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stills-'))
  await img('vertical.png', '1080x1920')   // correct shape
  await img('landscape.png', '1920x1080')  // wrong shape
  await img('square.png', '800x800')
  await img('tiny.png', '270x480')         // right ratio, too small
  await writeFile(p('notanimage.png'), 'plain text, not an image')
  await writeFile(p('empty.png'), '')
})
after(async () => { await rm(dir, { recursive: true, force: true }) })

const REEL_STILL = { expectAspectRatio: '9:16', minWidth: 1080, minHeight: 1920 }

test('a correctly shaped still passes and reports measured facts', async () => {
  const r = await verifyStill(p('vertical.png'), REEL_STILL)
  assert.equal(r.ok, true, r.ok ? '' : r.reason)
  assert.equal(r.facts.width, 1080)
  assert.equal(r.facts.height, 1920)
  assert.equal(r.facts.aspectRatio, '9:16')
  assert.match(r.facts.sha256, /^[0-9a-f]{64}$/)
  assert.ok(r.checks.every((c) => c.passed))
})

test('a landscape still is caught before any render is paid for', async () => {
  const r = await verifyStill(p('landscape.png'), REEL_STILL)
  assert.equal(r.ok, false)
  assert.match(r.reason, /aspect ratio/)
  assert.match(r.reason, /16:9/)
  assert.equal(r.facts.aspectRatio, '16:9', 'facts attached on failure')
})

test('a right-ratio but undersized still fails on dimensions', async () => {
  const r = await verifyStill(p('tiny.png'), REEL_STILL)
  assert.equal(r.ok, false)
  assert.match(r.reason, /min width|min height/)
  assert.equal(r.facts.aspectRatio, '9:16', 'ratio was fine; size was not')
})

test('a non-image fails without throwing', async () => {
  const r = await verifyStill(p('notanimage.png'), REEL_STILL)
  assert.equal(r.ok, false)
  assert.equal(r.facts, null)
  assert.match(r.reason, /not a readable image/)
})

test('an empty file fails without throwing', async () => {
  const r = await verifyStill(p('empty.png'), REEL_STILL)
  assert.equal(r.ok, false)
  assert.match(r.reason, /not a readable image/)
})

test('a missing file fails without throwing', async () => {
  const r = await verifyStill(p('nope.png'), REEL_STILL)
  assert.equal(r.ok, false)
  assert.equal(r.facts, null)
})

test('normalizeStill cover-crops landscape to 9:16 and verifies the result', async () => {
  const out = p('fixed-from-landscape.png')
  const r = await normalizeStill(p('landscape.png'), out)
  assert.equal(r.ok, true, r.ok ? '' : r.reason)
  assert.equal(r.facts.width, 1080)
  assert.equal(r.facts.height, 1920)
  assert.equal(r.facts.aspectRatio, '9:16')
  // Independently confirm on disk, not just via our own verifier.
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out])
  assert.equal(stdout.trim(), '1080,1920')
})

test('normalizeStill handles a square source', async () => {
  const r = await normalizeStill(p('square.png'), p('fixed-from-square.png'))
  assert.equal(r.ok, true, r.ok ? '' : r.reason)
  assert.equal(r.facts.aspectRatio, '9:16')
})

test('normalizeStill accepts a custom size', async () => {
  const r = await normalizeStill(p('landscape.png'), p('wide.png'), { width: 1920, height: 1080 })
  assert.equal(r.ok, true, r.ok ? '' : r.reason)
  assert.equal(r.facts.aspectRatio, '16:9')
  assert.equal(r.facts.width, 1920)
})

test('normalizeStill blames the input, not the crop, on a bad source', async () => {
  const r = await normalizeStill(p('notanimage.png'), p('never-written.png'))
  assert.equal(r.ok, false)
  assert.match(r.reason, /not a readable image: .*notanimage/)
})

test('an already-correct still normalizes idempotently', async () => {
  const once = await normalizeStill(p('vertical.png'), p('again.png'))
  assert.equal(once.ok, true, once.ok ? '' : once.reason)
  assert.equal(once.facts.width, 1080)
  assert.equal(once.facts.height, 1920)
})
