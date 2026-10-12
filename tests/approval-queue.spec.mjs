import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyRender } from '../lib/verify-render.ts'
import { ApprovalQueue, validateRightsBasis } from '../lib/approval-queue.ts'

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

const OWN = { kind: 'own-footage' }
const META = { provider: 'runway', model: 'h3_max', rights: OWN }

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

test('validateRightsBasis accepts own footage with nothing further', () => {
  assert.equal(validateRightsBasis({ kind: 'own-footage' }), null)
})

test('validateRightsBasis requires a licensor and reference for licensed footage', () => {
  assert.match(validateRightsBasis({ kind: 'licensed', licensor: '', licenseRef: 'r' }), /licensor/)
  assert.match(validateRightsBasis({ kind: 'licensed', licensor: 'Pond5', licenseRef: '  ' }), /licenseRef/)
  assert.equal(
    validateRightsBasis({ kind: 'licensed', licensor: 'Pond5', licenseRef: 'INV-7781' }),
    null,
  )
})

test('validateRightsBasis requires subject, consentRef and a real date', () => {
  const base = { kind: 'subject-consent', subject: 'A. Person', consentRef: 'releases/ap.pdf', obtainedAt: '2026-10-01' }
  assert.equal(validateRightsBasis(base), null)
  assert.match(validateRightsBasis({ ...base, subject: '' }), /name of the person/)
  assert.match(validateRightsBasis({ ...base, consentRef: '' }), /consentRef/)
  assert.match(validateRightsBasis({ ...base, obtainedAt: 'whenever' }), /obtainedAt/)
})

test('validateRightsBasis rejects an absent basis', () => {
  assert.match(validateRightsBasis(undefined), /no rights basis/)
})

test('approval is refused when the rights basis is incomplete', async () => {
  // A likeness entry naming a subject but pointing at no release.
  const entry = await q.enqueue(verified, {
    ...META,
    rights: { kind: 'subject-consent', subject: 'A. Person', consentRef: '', obtainedAt: '2026-10-01' },
  })
  await assert.rejects(() => q.approve(entry.id, 'carmelo'), /consentRef/)
  assert.equal((await q.get(entry.id)).status, 'pending', 'stays pending')
})

test('a complete subject-consent basis carries the evidence pointer and approves', async () => {
  const entry = await q.enqueue(verified, {
    ...META,
    rights: {
      kind: 'subject-consent',
      subject: 'A. Person',
      consentRef: 'releases/a-person-2026-10-01.pdf',
      obtainedAt: '2026-10-01',
    },
  })
  assert.equal(entry.rights.consentRef, 'releases/a-person-2026-10-01.pdf')
  const approved = await q.approve(entry.id, 'carmelo')
  assert.equal(approved.status, 'approved')
  assert.equal(approved.rights.subject, 'A. Person', 'evidence stays linked to the entry')
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

test('an unambiguous prefix resolves like a git short hash', async () => {
  const entry = await q.enqueue(verified, META)
  const short = entry.id.slice(0, 12)
  assert.equal(await q.resolveId(short), entry.id)
  assert.equal((await q.get(short)).id, entry.id)
  const approved = await q.approve(short, 'carmelo')
  assert.equal(approved.status, 'approved', 'mutations accept a prefix too')
})

test('an ambiguous prefix is refused rather than guessed', async () => {
  // Craft a log with two entries sharing a prefix; the queue reads JSONL.
  const dir = await mkdtemp(join(tmpdir(), 'ambig-'))
  const mk = (id) => JSON.stringify({
    kind: 'enqueue',
    entry: {
      id, at: new Date().toISOString(), status: 'pending',
      facts: { ...verified.facts, sha256: id },
      provider: 'runway', model: 'h3_max', rights: { kind: 'own-footage' },
    },
  })
  const a = 'abc111'.padEnd(64, '0')
  const b = 'abc222'.padEnd(64, '0')
  await writeFile(join(dir, '.approval-queue.jsonl'), mk(a) + '\n' + mk(b) + '\n')
  const amb = new ApprovalQueue(dir)
  assert.equal((await amb.state()).size, 2)
  await assert.rejects(() => amb.resolveId('abc'), /ambiguous \(2 matches\)/)
  assert.equal(await amb.resolveId('abc111'), a, 'a longer prefix still resolves')
  assert.equal(await amb.get('abc'), undefined, 'get returns nothing rather than a guess')
  await rm(dir, { recursive: true, force: true })
})

test('a prefix matching nothing is refused', async () => {
  await q.enqueue(verified, META)
  await assert.rejects(() => q.resolveId('ffffff'), /no queued render/)
})

test('an absent log reads as an empty queue', async () => {
  const fresh = new ApprovalQueue(await mkdtemp(join(tmpdir(), 'empty-')))
  assert.deepEqual(await fresh.listPending(), [])
  assert.equal((await fresh.state()).size, 0)
})
