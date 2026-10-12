import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  selectWinner, scoreEligible, hoeffdingLowerBound, wilsonLowerBound, DEFAULT_POLICY,
} from '../lib/select-winner.ts'

const NOW = new Date('2026-10-12T12:00:00Z')
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

/** A clip comfortably clearing every gate: 5s reel watched ~3.5s on average. */
const clip = (over = {}) => ({
  clipId: 'c1',
  postedAt: hoursAgo(72),
  reach: 40_000,
  views: 50_000,
  avgWatchTimeSeconds: 3.5,
  durationSeconds: 5,
  interactions: 2_000,
  ...over,
})

test('hoeffdingLowerBound penalises small samples', () => {
  const tiny = hoeffdingLowerBound(1.0, 4, 0.05)
  const large = hoeffdingLowerBound(0.8, 10_000, 0.05)
  assert.ok(tiny < large, `4 views (${tiny.toFixed(3)}) must not outrank 10k (${large.toFixed(3)})`)
})

test('hoeffdingLowerBound stays in [0,1] and handles edges', () => {
  assert.equal(hoeffdingLowerBound(0.9, 0, 0.05), 0, 'no samples scores 0')
  assert.equal(hoeffdingLowerBound(0, 1_000, 0.05), 0)
  assert.ok(hoeffdingLowerBound(1, 1_000_000, 0.05) > 0.99)
  assert.throws(() => hoeffdingLowerBound(0.5, 10, 0), RangeError)
  assert.throws(() => hoeffdingLowerBound(0.5, 10, 1), RangeError)
})

test('a looping clip whose watch time exceeds its duration clamps to the top', () => {
  // Instagram counts replays, so avg watch time can exceed duration.
  const looped = hoeffdingLowerBound(1.4, 50_000, 0.05)
  const exact = hoeffdingLowerBound(1.0, 50_000, 0.05)
  assert.equal(looped, exact, 'clamped, not allowed to exceed 1')
  assert.ok(looped > 0.99)
})

test('a stricter delta lowers the bound', () => {
  assert.ok(hoeffdingLowerBound(0.8, 1_000, 0.001) < hoeffdingLowerBound(0.8, 1_000, 0.05))
})

test('no data means no winner and no spend', () => {
  const r = selectWinner([], DEFAULT_POLICY, NOW)
  assert.equal(r.kind, 'no-winner')
  assert.equal(r.evaluated, 0)
  assert.match(r.reason, /no performance data/)
})

test('an under-reached clip is not eligible', () => {
  const r = selectWinner([clip({ reach: 10, views: 600 })], DEFAULT_POLICY, NOW)
  assert.equal(r.kind, 'no-winner')
  assert.equal(r.eligible, 0)
  assert.match(r.reason, /reach/)
})

test('a clip reached widely but barely viewed is not eligible', () => {
  const r = selectWinner([clip({ reach: 40_000, views: 50 })], DEFAULT_POLICY, NOW)
  assert.equal(r.kind, 'no-winner')
  assert.equal(r.eligible, 0)
})

test('a clip younger than the 48h insights lag is not eligible', () => {
  const r = selectWinner([clip({ postedAt: hoursAgo(24) })], DEFAULT_POLICY, NOW)
  assert.equal(r.kind, 'no-winner', 'Instagram data lags up to 48h; 24h is immature')
  assert.equal(DEFAULT_POLICY.minAgeHours, 48)
})

test('a stale clip past its trend window is not eligible', () => {
  const r = selectWinner([clip({ postedAt: hoursAgo(500) })], DEFAULT_POLICY, NOW)
  assert.equal(r.kind, 'no-winner')
})

test('a well-sampled low-retention clip is refused, not amplified', () => {
  // 0.5s average on a 5s reel: ample data, genuinely bad.
  const r = selectWinner([clip({ avgWatchTimeSeconds: 0.5 })], DEFAULT_POLICY, NOW)
  assert.equal(r.kind, 'no-winner')
  assert.equal(r.eligible, 1, 'evaluated, then rejected on quality')
  assert.match(r.reason, /not amplifying noise/)
})

test('a genuine winner is selected with a bounded variant count', () => {
  const r = selectWinner([clip()], DEFAULT_POLICY, NOW)
  assert.equal(r.kind, 'winner')
  assert.equal(r.clip.clipId, 'c1')
  assert.ok(r.score > DEFAULT_POLICY.minWatchFractionLowerBound)
  assert.ok(r.variants >= 1 && r.variants <= DEFAULT_POLICY.maxVariants)
  assert.match(r.reason, /confident watch fraction/)
})

test('between equal watch fractions, the larger sample wins', () => {
  // This is the bound doing its job: identical raw means, different confidence.
  const thin = clip({ clipId: 'thin', reach: 1_000, views: 520, avgWatchTimeSeconds: 4 })
  const thick = clip({ clipId: 'thick', reach: 60_000, views: 80_000, avgWatchTimeSeconds: 4 })
  const r = selectWinner([thin, thick], DEFAULT_POLICY, NOW)
  assert.equal(r.kind, 'winner')
  assert.equal(r.clip.clipId, 'thick', 'same 0.8 mean, more evidence')
})

test('a sub-floor sample never reaches scoring at all', () => {
  // The minViews gate, not the bound, is what stops a genuine fluke: a clip
  // with 40 views and perfect watch time is excluded before it is scored.
  const r = selectWinner(
    [clip({ clipId: 'fluke', reach: 1_200, views: 40, avgWatchTimeSeconds: 5 })],
    DEFAULT_POLICY,
    NOW,
  )
  assert.equal(r.kind, 'no-winner')
  assert.equal(r.eligible, 0, 'gated out, not merely outranked')
})

test('the bound bites hard below the gate and lightly above it', () => {
  // Honest account of the division of labour: the Hoeffding penalty is large
  // for tiny samples but only ~0.055 at the 500-view floor, so the gate is the
  // primary protection and the bound is a graded safety net just above it.
  const penalty = (n) => 1 - hoeffdingLowerBound(1, n, DEFAULT_POLICY.delta)
  assert.ok(penalty(10) > 0.35, `n=10 penalty ${penalty(10).toFixed(3)}`)
  assert.ok(penalty(100) > 0.1, `n=100 penalty ${penalty(100).toFixed(3)}`)
  const atFloor = penalty(DEFAULT_POLICY.minViews)
  assert.ok(atFloor > 0.04 && atFloor < 0.07, `at the floor the penalty is small: ${atFloor.toFixed(3)}`)
  assert.ok(penalty(80_000) < 0.01, 'negligible at scale')
})

test('a thin but eligible clip may legitimately outrank a broader one', () => {
  // Not a bug: 520 views at 100% watch is a well-sampled estimate, and the
  // module ranks retention. Reach is a gate, not part of the score.
  const thin = clip({ clipId: 'thin', reach: 1_000, views: 520, avgWatchTimeSeconds: 5 })
  const broad = clip({ clipId: 'broad', reach: 60_000, views: 80_000, avgWatchTimeSeconds: 4 })
  const r = selectWinner([thin, broad], DEFAULT_POLICY, NOW)
  assert.equal(r.clip.clipId, 'thin')
})

test('a marginal winner earns fewer variants than a strong one', () => {
  const marginal = selectWinner([clip({ avgWatchTimeSeconds: 2.1 })], DEFAULT_POLICY, NOW)
  const strong = selectWinner([clip({ avgWatchTimeSeconds: 4.8 })], DEFAULT_POLICY, NOW)
  assert.equal(marginal.kind, 'winner')
  assert.equal(strong.kind, 'winner')
  assert.ok(marginal.variants < strong.variants,
    `marginal ${marginal.variants} should be < strong ${strong.variants}`)
})

test('selection is deterministic regardless of input order', () => {
  const a = clip({ clipId: 'bbb' }), b = clip({ clipId: 'aaa' })
  const first = selectWinner([a, b], DEFAULT_POLICY, NOW)
  const second = selectWinner([b, a], DEFAULT_POLICY, NOW)
  assert.equal(first.clip.clipId, second.clip.clipId)
  assert.equal(first.clip.clipId, 'aaa', 'ties break on clipId')
})

test('a zero-duration clip cannot divide by zero', () => {
  const r = selectWinner([clip({ durationSeconds: 0 })], DEFAULT_POLICY, NOW)
  assert.equal(r.kind, 'no-winner')
  assert.equal(r.eligible, 0)
})

test('an invalid timestamp is rejected loudly, not silently skipped', () => {
  assert.throws(() => selectWinner([clip({ postedAt: 'whenever' })], DEFAULT_POLICY, NOW), RangeError)
})

test('scoreEligible exposes the raw mean alongside the conservative score', () => {
  const scored = scoreEligible([clip(), clip({ clipId: 'c2', reach: 5 })], DEFAULT_POLICY, NOW)
  assert.equal(scored.length, 1, 'only the eligible clip is scored')
  assert.equal(scored[0].rawWatchFraction, 0.7, '3.5s of a 5s reel')
  assert.ok(scored[0].score < scored[0].rawWatchFraction, 'the bound is conservative')
})

test('wilsonLowerBound is retained and correct for true proportions', () => {
  // Kept for platforms that report completion counts, e.g. TikTok.
  assert.ok(wilsonLowerBound(2, 2, 1.96) < wilsonLowerBound(800, 1000, 1.96))
  assert.equal(wilsonLowerBound(0, 0, 1.96), 0)
  assert.throws(() => wilsonLowerBound(5, 2, 1.96), RangeError)
})
