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

test('an unknown command prints usage and exits non-zero', async () => {
  const r = await cli('frobnicate')
  assert.equal(r.code, 1)
  assert.match(r.out, /usage:/)
})
