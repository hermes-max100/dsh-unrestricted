/**
 * Winner selection for variant amplification, scored on Instagram's metrics.
 *
 * Replaces `winner = generated_videos[0]`, which picked the first item in a
 * list and then paid to amplify it ten times.
 *
 * Scoring note. An earlier version scored completion rate with a Wilson
 * interval. Instagram exposes no completion count, so retention here is
 * `ig_reels_avg_watch_time / clip duration` — a bounded *mean*, not a
 * proportion of successes, which Wilson does not apply to. Instagram also
 * reports the mean without a variance, so no variance-aware interval is
 * computable either. What remains valid is Hoeffding's inequality: for a
 * variable bounded in [0,1] it gives a lower confidence bound on the mean from
 * the mean and the sample size alone. It is deliberately conservative, which is
 * the right direction when the cost of a false positive is paying to amplify
 * noise.
 *
 * Three properties this module guarantees:
 *
 *  1. It can decline. `no-winner` is a first-class outcome, so a cycle with
 *     nothing worth amplifying spends nothing.
 *  2. It will not invent data. Every field comes from measured platform
 *     performance; absent data is absent, never zero.
 *  3. It does not reward small samples. The Hoeffding penalty shrinks the
 *     score toward 0 as views fall, so a 4-view clip cannot win.
 *
 * Where the protection actually comes from. The penalty is 0.387 at 10 views
 * and 0.122 at 100, but only 0.055 at the 500-view floor and 0.004 at 80k. So
 * `minViews` does the real work of excluding flukes, and the bound is a graded
 * safety net just above the floor rather than the main defence. Above it,
 * ranking is close to the raw watch fraction — which is intended: reach is a
 * gate, not part of the score, so a well-sampled clip with better retention
 * outranks a broader one with worse retention.
 */

/** Measured performance for one posted clip, in Instagram's vocabulary. */
export interface ClipPerformance {
  clipId: string
  /** ISO-8601 timestamp of when the clip was posted. */
  postedAt: string
  /** Unique accounts reached (Instagram `reach`). Instagram dropped impressions. */
  reach: number
  /** Total views (Instagram `views`). The sample size for the watch fraction. */
  views: number
  /** Average watch time in seconds (Instagram `ig_reels_avg_watch_time`, ms -> s). */
  avgWatchTimeSeconds: number
  /** The clip's own duration, the denominator of the watch fraction. */
  durationSeconds: number
  /** Likes + comments + shares + saves (Instagram `total_interactions`). */
  interactions: number
}

export interface SelectionPolicy {
  /** Exposure floor: below this the clip has not been tested. */
  minReach: number
  /**
   * Floor on `views`, the sample size the watch fraction is averaged over.
   * Distinct from minReach: a clip can be served widely and barely watched.
   */
  minViews: number
  /**
   * Maturity floor in hours. Instagram insights lag up to 48 hours, so a
   * shorter gate reads incomplete data and calls it mature.
   */
  minAgeHours: number
  /** Staleness ceiling in hours: don't resurrect clips past their trend window. */
  maxAgeHours: number
  /** Quality floor on the *conservative* watch fraction, not the raw mean. */
  minWatchFractionLowerBound: number
  /** Confidence parameter for the Hoeffding bound. 0.05 ~ 95% one-sided. */
  delta: number
  /** Variants to commission per unit of confidence above the floor. */
  maxVariants: number
}

/**
 * Deliberately conservative: when in doubt, spend nothing.
 * Tune against real data rather than treating these as correct.
 */
export const DEFAULT_POLICY: SelectionPolicy = {
  minReach: 1_000,
  minViews: 500,
  minAgeHours: 48,
  maxAgeHours: 168,
  minWatchFractionLowerBound: 0.35,
  delta: 0.05,
  maxVariants: 10,
}

export interface ScoredClip {
  clip: ClipPerformance
  /** Hoeffding lower bound on the watch fraction. The ranking key. */
  score: number
  /**
   * Raw mean watch fraction. May exceed 1: Instagram counts replays in watch
   * time, so a looping clip legitimately watches longer than its duration.
   * That is a strong signal, kept visible here and clamped only for scoring.
   */
  rawWatchFraction: number
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
 * Hoeffding lower confidence bound on the mean of a variable bounded in [0,1].
 *
 * `mean - sqrt(ln(1/delta) / (2n))`, floored at 0. Needs no variance estimate,
 * only boundedness, which is what makes it usable on a reported average. The
 * penalty term falls as 1/sqrt(n), so small samples are pushed toward 0.
 */
export function hoeffdingLowerBound(
  mean: number,
  n: number,
  delta: number,
): number {
  if (n <= 0) return 0
  if (delta <= 0 || delta >= 1) {
    throw new RangeError(`delta must be in (0,1), got ${delta}`)
  }
  const clamped = Math.max(0, Math.min(1, mean))
  const penalty = Math.sqrt(Math.log(1 / delta) / (2 * n))
  return Math.max(0, Math.min(1, clamped - penalty))
}

/**
 * Wilson score interval, lower bound — for a true proportion of successes out
 * of trials. Not used for Instagram watch time (see the scoring note above),
 * kept because platforms that report completion *counts*, such as TikTok, give
 * a genuine binomial and this is the correct bound for them.
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
  return Math.max(0, Math.min(1, (center - margin) / denominator))
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
      if (clip.views <= 0 || clip.durationSeconds <= 0) return false
      if (clip.views < policy.minViews) return false
      if (clip.reach < policy.minReach) return false
      const age = ageHours(clip.postedAt, now)
      return age >= policy.minAgeHours && age <= policy.maxAgeHours
    })
    .map((clip) => {
      const rawWatchFraction = clip.avgWatchTimeSeconds / clip.durationSeconds
      return {
        clip,
        score: hoeffdingLowerBound(rawWatchFraction, clip.views, policy.delta),
        rawWatchFraction,
        ageHours: ageHours(clip.postedAt, now),
      }
    })
    .sort(
      (a, b) =>
        // Ties break on reach, then clipId, so selection is deterministic.
        b.score - a.score ||
        b.clip.reach - a.clip.reach ||
        a.clip.clipId.localeCompare(b.clip.clipId),
    )
}

/**
 * Pick the clip worth amplifying, or decline.
 *
 * Variant count scales with how far the winner's confident watch fraction sits
 * above the floor, so a marginal winner gets a small batch, not a full ten.
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
        `no clip cleared the gates (>= ${policy.minReach} reach, ` +
        `>= ${policy.minViews} views, age ${policy.minAgeHours}-${policy.maxAgeHours}h)`,
      evaluated: clips.length,
      eligible: 0,
    }
  }

  const best = scored[0]!
  if (best.score < policy.minWatchFractionLowerBound) {
    return {
      kind: 'no-winner',
      reason:
        `best confident watch fraction ${best.score.toFixed(3)} is below the ` +
        `${policy.minWatchFractionLowerBound} floor (${best.clip.clipId}, raw ` +
        `${best.rawWatchFraction.toFixed(3)}); not amplifying noise`,
      evaluated: clips.length,
      eligible: scored.length,
    }
  }

  const headroom =
    (best.score - policy.minWatchFractionLowerBound) /
    Math.max(1e-9, 1 - policy.minWatchFractionLowerBound)
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
      `confident watch fraction ${best.score.toFixed(3)} (raw ` +
      `${best.rawWatchFraction.toFixed(3)}) over ${best.clip.views} views, ` +
      `${best.ageHours.toFixed(1)}h old; beat ${scored.length - 1} other eligible clip(s)`,
  }
}
