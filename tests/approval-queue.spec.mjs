import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyRender } from '../lib/verify-render.ts'
import { ApprovalQueue } from '../lib/approval-queue.ts'

const run = promisify(execFile)
let dir, verified, queueDir, q

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'queue-fx-'))
  const file = join(dir, 'reel.mp4')
  await run('ffmpeg', ['-nostdin', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=blue:s=1080x1920:r=24:d=5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '5', file])
  verified = await verifyRender(file, { expectAspectRatio: '9:16', expectDurationSeconds: 5 })
  assert.equal(verified.ok, true, 'fixture must verify for these tests to mean anything')
})
after(async () => { await rm(dir, { recursive: true, force: true }) })

beforeEach(async () => {
  queueDir = await mkdtemp(join(tmpdir(), 'queue-'))
  q = new ApprovalQueue(queueDir)
})

const META = { provider: 'runway', model: 'h3_max', sourceRightsConfirmed: true }

test('a verified render enters the queue as pending', async () => {
  const entry = await q.enqueue(verified, META)
  assert.equal(entry.status, 'pending')
  assert.equal(entry.id, verified.facts.sha256, 'identity is content hash')
  assert.equal(entry.facts.aspectRatio, '9:16')
  assert.deepEqual((await q.listPending()).map((e) => e.id), [entry.id])
})

test('re-enqueuing identical content does not duplicate or reset it', async () => {
  const first = await q.enqueue(verified, META)
  await q.approve(first.id, 'carmelo')
  const again = await q.enqueue(verified, META)
  assert.equal(again.status, 'approved', 'must not revert an approved entry to pending')
  assert.equal((await q.state()).size, 1)
})

test('approval is refused when source rights were not confirmed', async () => {
  const entry = await q.enqueue(verified, { ...META, sourceRightsConfirmed: false })
  await assert.rejects(
    () => q.approve(entry.id, 'carmelo'),
    /source rights \/ likeness consent were not confirmed/,
  )
  assert.equal((await q.get(entry.id)).status, 'pending', 'stays pending')
})

test('approval succeeds once rights are confirmed', async () => {
  const entry = await q.enqueue(verified, META)
  const approved = await q.approve(entry.id, 'carmelo')
  assert.equal(approved.status, 'approved')
  assert.deepEqual(await q.listPending(), [], 'no longer pending')
})

test('nothing posts without approval', async () => {
  const entry = await q.enqueue(verified, META)
  await assert.rejects(() => q.markPosted(entry.id), /not approved/)
  await q.approve(entry.id, 'carmelo')
  const posted = await q.markPosted(entry.id)
  assert.equal(posted.status, 'posted')
})

test('a rejected render cannot be approved', async () => {
  const entry = await q.enqueue(verified, META)
  await q.reject(entry.id, 'face drift on the hook frame')
  assert.equal((await q.get(entry.id)).status, 'rejected')
  await assert.rejects(() => q.approve(entry.id, 'carmelo'), /was rejected/)
})

test('rejection records the reason', async () => {
  const entry = await q.enqueue(verified, META)
  const rejected = await q.reject(entry.id, 'wrong avatar')
  assert.equal(rejected.note, 'wrong avatar')
})

test('operations on an unknown id fail loudly', async () => {
  await assert.rejects(() => q.approve('deadbeef', 'carmelo'), /no queued render/)
  await assert.rejects(() => q.reject('deadbeef', 'x'), /no queued render/)
  await assert.rejects(() => q.markPosted('deadbeef'), /no queued render/)
})

test('state survives a fresh queue instance reading the same log', async () => {
  const entry = await q.enqueue(verified, META)
  await q.approve(entry.id, 'carmelo')
  const reopened = new ApprovalQueue(queueDir)
  assert.equal((await reopened.get(entry.id)).status, 'approved', 'log is the source of truth')
})

test('an absent log reads as an empty queue', async () => {
  const fresh = new ApprovalQueue(await mkdtemp(join(tmpdir(), 'empty-')))
  assert.deepEqual(await fresh.listPending(), [])
  assert.equal((await fresh.state()).size, 0)
})
