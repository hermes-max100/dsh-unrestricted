/**
 * Winner selection for variant amplification.
 *
 * Replaces `winner = generated_videos[0]`, which picked the first item in a
 * list and then paid to amplify it ten times. At $0.40-1.50 per clip that is
 * the largest avoidable cost in the pipeline: not the per-clip price, but
 * paying it repeatedly for content chosen at random.
 *
 * Three properties this module guarantees:
 *
 *  1. It can decline. `no-winner` is a first-class outcome, so a cycle with
 *     nothing worth amplifying spends nothing.
 *  2. It will not invent data. Every field comes from measured platform
 *     performance. There is no default, placeholder or synthetic clip.
 *  3. It does not reward small samples. Scoring uses the Wilson score lower
 *     bound, so 2 completions out of 2 views ranks below 800 out of 1000.
 *     Raw rates make noise look like a winner; this is the correction.
 */

/** Measured performance for one posted clip. All fields come from the platform. */
export interface ClipPerformance {
  clipId: string
  /** ISO-8601 timestamp of when the clip was posted. */
  postedAt: string
  /** Times the clip was served. The exposure denominator. */
  impressions: number
  /** Counted views. The denominator for retention. */
  views: number
  /** Views that reached the end. The quality signal. */
  completions: number
  /** Likes + comments + shares. */
  engagements: number
}

export interface SelectionPolicy {
  /** Exposure floor: below this the clip has not been tested. */
  minImpressions: number
  /**
   * Floor on `views`, the denominator the retention score is computed over.
   * Distinct from minImpressions and not redundant with it: a clip can be
   * widely served yet barely watched, leaving a tiny scoring sample. Without
   * this, a 4-view clip with 4 completions scores a Wilson bound of ~0.51 and
   * clears a 0.25 floor on nothing but noise.
   */
  minViews: number
  /** Maturity floor in hours: metrics accumulate, so young clips aren't comparable. */
  minAgeHours: number
  /** Staleness ceiling in hours: don't resurrect clips past their trend window. */
  maxAgeHours: number
  /** Quality floor on the *conservative* retention estimate, not the raw rate. */
  minRetentionLowerBound: number
  /** z-score for the Wilson bound. 1.96 = 95% one-sided-ish; higher = stricter. */
  z: number
  /** Variants to commission per unit of confidence above the floor. */
  maxVariants: number
}

/**
 * Defaults are deliberately conservative: when in doubt, spend nothing.
 * Tune against real data rather than treating these as correct.
 */
export const DEFAULT_POLICY: SelectionPolicy = {
  minImpressions: 1_000,
  minViews: 500,
  minAgeHours: 12,
  maxAgeHours: 72,
  minRetentionLowerBound: 0.25,
  z: 1.96,
  maxVariants: 10,
}

export interface ScoredClip {
  clip: ClipPerformance
  /** Wilson lower bound on completion rate. The ranking key. */
  score: number
  /** Raw completions/views, for comparison against the bound. */
  rawRetention: number
  ageHours: number
}

export type Selection =
  | {
      kind: 'winner'
      clip: ClipPerformance
      score: number
      /** How many variants this clip's confidence justifies. Always >= 1. */
      variants: number
      reason: string
    }
  | { kind: 'no-winner'; reason: string; evaluated: number; eligible: number }

/**
 * Wilson score interval, lower bound.
 *
 * The conservative "at least this good" estimate of a success rate given
 * `successes` out of `total`. Shrinks toward 0 as the sample shrinks, which is
 * precisely why a 2/2 clip must not outrank a 800/1000 clip.
 */
export function wilsonLowerBound(
  successes: number,
  total: number,
  z: number,
): number {
  if (total <= 0) return 0
  if (successes < 0 || successes > total) {
    throw new RangeError(
      `successes (${successes}) must be between 0 and total (${total})`,
    )
  }
  const p = successes / total
  const z2 = z * z
  const denominator = 1 + z2 / total
  const center = p + z2 / (2 * total)
  const margin = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))
  const lower = (center - margin) / denominator
  return Math.max(0, Math.min(1, lower))
}

function ageHours(postedAt: string, now: Date): number {
  const posted = Date.parse(postedAt)
  if (Number.isNaN(posted)) {
    throw new RangeError(`postedAt is not a valid timestamp: ${postedAt}`)
  }
  return (now.getTime() - posted) / 3_600_000
}

/**
 * Score every clip that clears the exposure and age gates.
 * Exported so a caller can inspect why a cycle declined.
 */
export function scoreEligible(
  clips: readonly ClipPerformance[],
  policy: SelectionPolicy = DEFAULT_POLICY,
  now: Date = new Date(),
): ScoredClip[] {
  return clips
    .filter((clip) => {
      if (clip.views <= 0) return false
      if (clip.views < policy.minViews) return false
      if (clip.impressions < policy.minImpressions) return false
      const age = ageHours(clip.postedAt, now)
      return age >= policy.minAgeHours && age <= policy.maxAgeHours
    })
    .map((clip) => ({
      clip,
      score: wilsonLowerBound(clip.completions, clip.views, policy.z),
      rawRetention: clip.completions / clip.views,
      ageHours: ageHours(clip.postedAt, now),
    }))
    .sort(
      (a, b) =>
        // Ties break on impressions, then clipId, so selection is deterministic.
        b.score - a.score ||
        b.clip.impressions - a.clip.impressions ||
        a.clip.clipId.localeCompare(b.clip.clipId),
    )
}

/**
 * Pick the clip worth amplifying, or decline.
 *
 * Variant count scales with how far the winner's confident retention sits above
 * the floor, so a marginal winner gets a small batch rather than a full ten.
 */
export function selectWinner(
  clips: readonly ClipPerformance[],
  policy: SelectionPolicy = DEFAULT_POLICY,
  now: Date = new Date(),
): Selection {
  if (clips.length === 0) {
    return {
      kind: 'no-winner',
      reason: 'no performance data supplied; nothing to evaluate',
      evaluated: 0,
      eligible: 0,
    }
  }

  const scored = scoreEligible(clips, policy, now)
  if (scored.length === 0) {
    return {
      kind: 'no-winner',
      reason:
        `no clip cleared the gates (>= ${policy.minImpressions} impressions, ` +
        `>= ${policy.minViews} views, age ${policy.minAgeHours}-${policy.maxAgeHours}h)`,
      evaluated: clips.length,
      eligible: 0,
    }
  }

  const best = scored[0]!
  if (best.score < policy.minRetentionLowerBound) {
    return {
      kind: 'no-winner',
      reason:
        `best confident retention ${best.score.toFixed(3)} is below the ` +
        `${policy.minRetentionLowerBound} floor (${best.clip.clipId}, raw ` +
        `${best.rawRetention.toFixed(3)}); not amplifying noise`,
      evaluated: clips.length,
      eligible: scored.length,
    }
  }

  // Headroom above the floor, as a fraction of the remaining range.
  const headroom =
    (best.score - policy.minRetentionLowerBound) /
    Math.max(1e-9, 1 - policy.minRetentionLowerBound)
  const variants = Math.max(
    1,
    Math.min(policy.maxVariants, Math.round(headroom * policy.maxVariants)),
  )

  return {
    kind: 'winner',
    clip: best.clip,
    score: best.score,
    variants,
    reason:
      `confident retention ${best.score.toFixed(3)} (raw ` +
      `${best.rawRetention.toFixed(3)}) over ${best.clip.views} views, ` +
      `${best.ageHours.toFixed(1)}h old; beat ${scored.length - 1} other eligible clip(s)`,
  }
}
