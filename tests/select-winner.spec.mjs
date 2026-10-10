import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  selectWinner,
  scoreEligible,
  wilsonLowerBound,
  DEFAULT_POLICY,
} from '../lib/select-winner.ts'

const NOW = new Date('2026-10-10T12:00:00Z')
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

/** A clip that comfortably clears every gate. */
const clip = (over = {}) => ({
  clipId: 'c1',
  postedAt: hoursAgo(24),
  impressions: 50_000,
  views: 10_000,
  completions: 5_000,
  engagements: 500,
  ...over,
})

test('wilsonLowerBound penalises small samples', () => {
  const tiny = wilsonLowerBound(2, 2, 1.96) // perfect, n=2
  const large = wilsonLowerBound(800, 1000, 1.96) // 80%, n=1000
  assert.ok(
    tiny < large,
    `2/2 (${tiny.toFixed(3)}) must not outrank 800/1000 (${large.toFixed(3)})`,
  )
})

test('wilsonLowerBound stays within [0,1] and handles edges', () => {
  assert.equal(wilsonLowerBound(0, 0, 1.96), 0, 'no data scores 0')
  assert.equal(wilsonLowerBound(0, 100, 1.96), 0, 'zero successes scores 0')
  const perfect = wilsonLowerBound(1000, 1000, 1.96)
  assert.ok(perfect > 0.99 && perfect <= 1, `got ${perfect}`)
  assert.throws(() => wilsonLowerBound(5, 2, 1.96), RangeError)
})

test('a higher z makes the bound stricter', () => {
  assert.ok(wilsonLowerBound(80, 100, 2.58) < wilsonLowerBound(80, 100, 1.96))
})

test('no data means no winner and no spend', () => {
  const result = selectWinner([], DEFAULT_POLICY, NOW)
  assert.equal(result.kind, 'no-winner')
  assert.equal(result.evaluated, 0)
  assert.match(result.reason, /no performance data/)
})

test('under-exposed clips are not eligible', () => {
  const result = selectWinner([clip({ impressions: 10, views: 5, completions: 5 })], DEFAULT_POLICY, NOW)
  assert.equal(result.kind, 'no-winner')
  assert.equal(result.eligible, 0)
  assert.match(result.reason, /impressions/)
})

test('clips that are too young or too stale are not eligible', () => {
  const young = selectWinner([clip({ postedAt: hoursAgo(1) })], DEFAULT_POLICY, NOW)
  assert.equal(young.kind, 'no-winner', 'a 1h-old clip has immature metrics')
  const stale = selectWinner([clip({ postedAt: hoursAgo(500) })], DEFAULT_POLICY, NOW)
  assert.equal(stale.kind, 'no-winner', 'a 500h-old clip is past its window')
})

test('a well-exposed low-retention clip is refused, not amplified', () => {
  // 5% retention over 10k views: plenty of data, genuinely bad.
  const result = selectWinner([clip({ completions: 500 })], DEFAULT_POLICY, NOW)
  assert.equal(result.kind, 'no-winner')
  assert.equal(result.eligible, 1, 'it was evaluated, then rejected on quality')
  assert.match(result.reason, /not amplifying noise/)
})

test('a genuine winner is selected with a bounded variant count', () => {
  const result = selectWinner([clip()], DEFAULT_POLICY, NOW)
  assert.equal(result.kind, 'winner')
  assert.equal(result.clip.clipId, 'c1')
  assert.ok(result.score > 0.25, `score ${result.score}`)
  assert.ok(result.variants >= 1 && result.variants <= DEFAULT_POLICY.maxVariants)
  assert.match(result.reason, /confident retention/)
})

test('the large confident sample beats the tiny perfect one end to end', () => {
  // This is the exact failure `generated_videos[0]` produced: a fluke clip
  // with 3/3 completions getting a ten-variant budget.
  const fluke = clip({ clipId: 'fluke', impressions: 1_200, views: 3, completions: 3 })
  const real = clip({ clipId: 'real', impressions: 80_000, views: 20_000, completions: 12_000 })
  const result = selectWinner([fluke, real], DEFAULT_POLICY, NOW)
  assert.equal(result.kind, 'winner')
  assert.equal(result.clip.clipId, 'real', 'must not pick the 3-view fluke')
})

test('a tiny-sample fluke alone is declined, not amplified', () => {
  // Regression: this clip has 1,100 impressions (clears minImpressions) but
  // only 4 views, so the Wilson denominator was tiny. Its bound of ~0.51
  // cleared the 0.25 floor and it was selected as a winner.
  const fluke = clip({ clipId: 'fluke', impressions: 1_100, views: 4, completions: 4 })
  const result = selectWinner([fluke], DEFAULT_POLICY, NOW)
  assert.equal(result.kind, 'no-winner', 'a 4-view clip must never be a winner')
  assert.equal(result.eligible, 0, 'it must not even be scored')
  assert.match(result.reason, /views/)
})

test('a clip served widely but barely watched is not eligible', () => {
  const result = selectWinner(
    [clip({ impressions: 100_000, views: 50, completions: 40 })],
    DEFAULT_POLICY,
    NOW,
  )
  assert.equal(result.kind, 'no-winner')
  assert.equal(result.eligible, 0)
})

test('a marginal winner earns fewer variants than a strong one', () => {
  const marginal = selectWinner([clip({ completions: 3_000 })], DEFAULT_POLICY, NOW)
  const strong = selectWinner([clip({ completions: 9_000 })], DEFAULT_POLICY, NOW)
  assert.equal(marginal.kind, 'winner')
  assert.equal(strong.kind, 'winner')
  assert.ok(
    marginal.variants < strong.variants,
    `marginal ${marginal.variants} should be < strong ${strong.variants}`,
  )
})

test('selection is deterministic for identical scores', () => {
  const a = clip({ clipId: 'bbb' })
  const b = clip({ clipId: 'aaa' })
  const first = selectWinner([a, b], DEFAULT_POLICY, NOW)
  const second = selectWinner([b, a], DEFAULT_POLICY, NOW)
  assert.equal(first.kind, 'winner')
  assert.equal(first.clip.clipId, second.clip.clipId, 'order must not change the pick')
  assert.equal(first.clip.clipId, 'aaa', 'ties break on clipId')
})

test('zero-view clips cannot divide by zero', () => {
  const result = selectWinner([clip({ views: 0, completions: 0 })], DEFAULT_POLICY, NOW)
  assert.equal(result.kind, 'no-winner')
  assert.ok(Number.isFinite(result.eligible))
})

test('an invalid timestamp is rejected loudly, not silently skipped', () => {
  assert.throws(
    () => selectWinner([clip({ postedAt: 'not-a-date' })], DEFAULT_POLICY, NOW),
    RangeError,
  )
})

test('scoreEligible exposes why a cycle declined', () => {
  const scored = scoreEligible([clip(), clip({ clipId: 'c2', impressions: 5 })], DEFAULT_POLICY, NOW)
  assert.equal(scored.length, 1, 'only the eligible clip is scored')
  assert.equal(scored[0].clip.clipId, 'c1')
  assert.ok(scored[0].score < scored[0].rawRetention, 'the bound is conservative')
})
