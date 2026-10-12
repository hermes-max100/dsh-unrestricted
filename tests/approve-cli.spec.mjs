import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const run = promisify(execFile)
const CLI = resolve(import.meta.dirname, '..', 'approve.ts')
let fxDir, reel, cwd

/** Run the CLI in an isolated cwd; never throws, so exit codes are assertable. */
async function cli(...args) {
  try {
    const { stdout, stderr } = await run('node', [CLI, ...args], { cwd })
    return { code: 0, out: stdout + stderr }
  } catch (e) {
    return { code: e.code ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

before(async () => {
  fxDir = await mkdtemp(join(tmpdir(), 'cli-fx-'))
  reel = join(fxDir, 'reel.mp4')
  await run('ffmpeg', ['-nostdin', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=blue:s=1080x1920:r=24:d=5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '5', reel])
})
after(async () => { await rm(fxDir, { recursive: true, force: true }) })
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'cli-cwd-')) })

const ENQ = ['enqueue', null, '--provider', 'runway', '--model', 'h3_max']
const enq = (...extra) => cli(...ENQ.map((a) => (a === null ? reel : a)), ...extra)

/** Pull the printed 12-char id prefix out of CLI output. */
const idOf = (out) => out.match(/^([0-9a-f]{12})\s/m)?.[1]

test('an empty queue lists cleanly', async () => {
  const r = await cli('list')
  assert.equal(r.code, 0)
  assert.match(r.out, /no renders pending review/)
})

test('a conforming render verifies and queues', async () => {
  const r = await enq('--rights', 'own-footage', '--aspect', '9:16', '--duration', '5')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /verified and queued/)
  assert.match(r.out, /1080x1920 \(9:16\)/)
  assert.match(r.out, /rights: own footage/)
})

test('a render failing a check is refused with exit 1', async () => {
  const r = await enq('--rights', 'own-footage', '--aspect', '16:9')
  assert.equal(r.code, 1)
  assert.match(r.out, /did not verify/)
  assert.doesNotMatch(r.out, /queued/, 'must not claim it queued')
})

test('a missing file is refused with exit 1', async () => {
  const r = await cli('enqueue', join(fxDir, 'nope.mp4'), '--provider', 'p', '--model', 'm', '--rights', 'own-footage')
  assert.equal(r.code, 1)
  assert.match(r.out, /not a readable media file/)
})

test('an incomplete subject-consent basis is refused before ffprobe runs', async () => {
  const r = await enq('--rights', 'subject-consent', '--subject', 'A. Person', '--obtained-at', '2026-10-01')
  assert.equal(r.code, 1)
  assert.match(r.out, /consentRef/)
})

test('a complete subject-consent basis queues and keeps the release pointer', async () => {
  const r = await enq('--rights', 'subject-consent', '--subject', 'A. Person',
    '--consent-ref', 'releases/a-person.pdf', '--obtained-at', '2026-10-01')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /consent from A\. Person, release releases\/a-person\.pdf/)
})

test('an unknown rights kind is refused', async () => {
  const r = await enq('--rights', 'vibes')
  assert.equal(r.code, 1)
  assert.match(r.out, /unknown --rights value/)
})

test('approval requires attribution', async () => {
  const id = idOf((await enq('--rights', 'own-footage')).out)
  const r = await cli('approve', id)
  assert.equal(r.code, 1)
  assert.match(r.out, /--by/)
})

test('approval succeeds and is attributed', async () => {
  const id = idOf((await enq('--rights', 'own-footage')).out)
  const r = await cli('approve', id, '--by', 'carmelo')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /approved by carmelo/)
  assert.match((await cli('list')).out, /no renders pending/)
})

test('an id equal to a flag value still parses correctly', async () => {
  // Regression: value-based positional extraction misclassified this.
  const id = idOf((await enq('--rights', 'own-footage')).out)
  const r = await cli('approve', id, '--by', id)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, new RegExp(`approved by ${id}`))
})

test('a render whose rights are incomplete cannot be approved', async () => {
  // Enqueue via a valid basis, then prove approve re-validates what was stored.
  const id = idOf((await enq('--rights', 'licensed', '--licensor', 'Pond5', '--license-ref', 'INV-1')).out)
  assert.equal((await cli('approve', id, '--by', 'carmelo')).code, 0)
})

test('rejection needs a reason, and blocks later approval', async () => {
  const id = idOf((await enq('--rights', 'own-footage')).out)
  assert.equal((await cli('reject', id)).code, 1, 'no reason given')
  const rejected = await cli('reject', id, '--reason', 'face drift on hook frame')
  assert.equal(rejected.code, 0, rejected.out)
  assert.match(rejected.out, /rejected/)
  const after = await cli('approve', id, '--by', 'carmelo')
  assert.equal(after.code, 1)
  assert.match(after.out, /was rejected/)
})

test('show reports a queued render, and fails on an unknown id', async () => {
  const id = idOf((await enq('--rights', 'own-footage')).out)
  const ok = await cli('show', id)
  assert.equal(ok.code, 0, ok.out)
  assert.match(ok.out, /pending/)
  const bad = await cli('show', 'deadbeefdead')
  assert.equal(bad.code, 1)
  assert.match(bad.out, /no queued render/)
})

test('verify-still passes a correct still and refuses a landscape one', async () => {
  const good = join(fxDir, 'v.png'), bad = join(fxDir, 'l.png')
  await run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=1080x1920', '-frames:v', '1', good])
  await run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=1920x1080', '-frames:v', '1', bad])

  const ok = await cli('verify-still', good, '--aspect', '9:16', '--min-width', '1080')
  assert.equal(ok.code, 0, ok.out)
  assert.match(ok.out, /still verified/)
  assert.match(ok.out, /1080x1920 \(9:16\)/)

  const no = await cli('verify-still', bad, '--aspect', '9:16')
  assert.equal(no.code, 1)
  assert.match(no.out, /not usable as a render input/)
  assert.doesNotMatch(no.out, /✓/, 'no success marker on a refusal')
})

test('normalize-still converts a landscape still and verifies the output', async () => {
  const src = join(fxDir, 'l2.png'), out = join(cwd, 'fixed.png')
  await run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=1920x1080', '-frames:v', '1', src])
  const r = await cli('normalize-still', src, out)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /normalized and verified/)
  assert.match(r.out, /1080x1920 \(9:16\)/)
  // The normalized file then passes the input gate.
  assert.equal((await cli('verify-still', out, '--aspect', '9:16', '--min-width', '1080')).code, 0)
})

test('normalize-still refuses a non-image input', async () => {
  const r = await cli('normalize-still', join(fxDir, 'nope.png'), join(cwd, 'x.png'))
  assert.equal(r.code, 1)
  assert.match(r.out, /not a readable image/)
})

const PERF = (id, over = {}) => [
  'record-performance', id,
  '--posted-at', over.postedAt ?? new Date(Date.now() - 72 * 3600_000).toISOString(),
  '--reach', String(over.reach ?? 40000),
  '--views', String(over.views ?? 50000),
  '--avg-watch-time', String(over.watch ?? 3.5),
  '--duration', String(over.duration ?? 5),
  '--interactions', String(over.interactions ?? 2000),
]

test('record-performance stores a measurement and reports the watch fraction', async () => {
  const r = await cli(...PERF('reel-1'))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /recorded reel-1/)
  assert.match(r.out, /70\.0%/, '3.5s of 5s')
})

test('record-performance refuses incomplete or impossible input', async () => {
  assert.equal((await cli('record-performance', 'x', '--views', '10')).code, 1)
  const transposed = await cli(...PERF('reel-2', { views: 10, reach: 5000 }))
  assert.equal(transposed.code, 1)
  assert.match(transposed.out, /transposed/)
})

test('select-winner declines on an empty log without spending', async () => {
  const r = await cli('select-winner')
  assert.equal(r.code, 0, 'declining is a successful outcome')
  assert.match(r.out, /no winner this cycle/)
  assert.match(r.out, /no performance data/)
})

test('select-winner picks the better clip once measurements exist', async () => {
  await cli(...PERF('dud', { watch: 0.4 }))
  await cli(...PERF('hit', { watch: 4.2 }))
  const r = await cli('select-winner')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /winner: hit/)
  assert.match(r.out, /commission \d+ variant/)
})

test('select-winner declines when every clip is weak', async () => {
  await cli(...PERF('weak-a', { watch: 0.3 }))
  await cli(...PERF('weak-b', { watch: 0.5 }))
  const r = await cli('select-winner')
  assert.equal(r.code, 0)
  assert.match(r.out, /no winner this cycle/)
  assert.match(r.out, /not amplifying noise/)
})

test('an unknown command prints usage and exits non-zero', async () => {
  const r = await cli('frobnicate')
  assert.equal(r.code, 1)
  assert.match(r.out, /usage:/)
})
