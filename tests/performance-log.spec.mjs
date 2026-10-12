import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PerformanceLog, validatePerformance } from '../lib/performance-log.ts'
import { selectWinner, DEFAULT_POLICY } from '../lib/select-winner.ts'

let dir, log
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perf-'))
  log = new PerformanceLog(dir)
})

const clip = (over = {}) => ({
  clipId: 'reel-1',
  postedAt: '2026-10-09T12:00:00Z',
  reach: 40_000,
  views: 50_000,
  avgWatchTimeSeconds: 3.5,
  durationSeconds: 5,
  interactions: 2_000,
  ...over,
})

test('an absent log reads as no measurements, not as zeros', async () => {
  assert.deepEqual(await log.latest(), [])
  assert.deepEqual(await log.history(), [])
})

test('a recorded measurement round-trips', async () => {
  const row = await log.record(clip())
  assert.equal(row.source, 'manual')
  assert.ok(Date.parse(row.recordedAt) > 0)
  const latest = await log.latest()
  assert.equal(latest.length, 1)
  assert.equal(latest[0].clipId, 'reel-1')
  assert.equal(latest[0].views, 50_000)
  assert.equal(latest[0].recordedAt, undefined, 'bookkeeping fields are stripped for the scorer')
})

test('a later measurement supersedes an earlier one, history is kept', async () => {
  await log.record(clip({ views: 1_000, reach: 900 }))
  await new Promise((r) => setTimeout(r, 5))
  await log.record(clip({ views: 50_000, reach: 40_000 }))
  const latest = await log.latest()
  assert.equal(latest.length, 1, 'one clip, not two')
  assert.equal(latest[0].views, 50_000, 'the later number wins')
  assert.equal((await log.history()).length, 2, 'both measurements survive as evidence')
})

test('distinct clips are kept separate', async () => {
  await log.record(clip({ clipId: 'a' }))
  await log.record(clip({ clipId: 'b' }))
  assert.deepEqual((await log.latest()).map((c) => c.clipId).sort(), ['a', 'b'])
})

test('impossible measurements are rejected at the boundary', async () => {
  assert.match(validatePerformance(clip({ clipId: '' })), /clipId/)
  assert.match(validatePerformance(clip({ postedAt: 'whenever' })), /postedAt/)
  assert.match(validatePerformance(clip({ views: -1 })), /cannot be negative/)
  assert.match(validatePerformance(clip({ durationSeconds: 0 })), /greater than zero/)
  assert.match(validatePerformance(clip({ reach: NaN })), /finite/)
  assert.equal(validatePerformance(clip()), null)
})

test('views below reach is caught as likely transposed fields', async () => {
  const bad = clip({ views: 100, reach: 50_000 })
  assert.match(validatePerformance(bad), /transposed/)
  await assert.rejects(() => log.record(bad), /transposed/)
  assert.deepEqual(await log.history(), [], 'nothing written on rejection')
})

test('the log feeds the selector directly', async () => {
  await log.record(clip({ clipId: 'dud', avgWatchTimeSeconds: 0.4 }))
  await log.record(clip({ clipId: 'hit', avgWatchTimeSeconds: 4.2 }))
  const decision = selectWinner(await log.latest(), DEFAULT_POLICY, new Date('2026-10-12T12:00:00Z'))
  assert.equal(decision.kind, 'winner')
  assert.equal(decision.clip.clipId, 'hit')
})
