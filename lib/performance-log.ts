/**
 * Append-only performance log — the selector's data source.
 *
 * Built for manual entry first. Instagram insights need a Meta app and app
 * review, and lag up to 48 hours, so typing four numbers off the Instagram app
 * makes the measure -> select loop work today. The Graph API later replaces the
 * writer without the selector changing: both produce the same ClipPerformance.
 *
 * Two deliberate semantics:
 *
 *  - Metrics grow as a post matures, so a later entry for the same clipId
 *    supersedes the earlier one. The history stays in the log as evidence.
 *  - Absent is absent. A clip with no entry does not exist in the readout; it
 *    is never synthesised as zero, because a fresh clip read as zero views
 *    would look like a flop.
 */
import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ClipPerformance } from './select-winner.ts'

export interface PerformanceEntry extends ClipPerformance {
  /** When this measurement was taken, distinct from when the clip was posted. */
  recordedAt: string
  source: 'manual' | 'instagram-graph'
}

export class PerformanceLog {
  readonly logPath: string

  constructor(dir: string = process.cwd()) {
    this.logPath = resolve(dir, '.performance.jsonl')
  }

  /** Append one measurement. Rejects values that cannot be true. */
  async record(
    entry: ClipPerformance,
    source: PerformanceEntry['source'] = 'manual',
  ): Promise<PerformanceEntry> {
    const invalid = validatePerformance(entry)
    if (invalid !== null) throw new Error(invalid)
    const row: PerformanceEntry = {
      ...entry,
      recordedAt: new Date().toISOString(),
      source,
    }
    await appendFile(this.logPath, JSON.stringify(row) + '\n', 'utf8')
    return row
  }

  /** Every measurement ever written, oldest first. */
  async history(): Promise<PerformanceEntry[]> {
    try {
      const raw = await readFile(this.logPath, 'utf8')
      return raw
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as PerformanceEntry)
    } catch {
      return [] // No log yet means no measurements, not an error.
    }
  }

  /** The latest measurement per clip — what the selector consumes. */
  async latest(): Promise<ClipPerformance[]> {
    const byClip = new Map<string, PerformanceEntry>()
    for (const row of await this.history()) {
      const existing = byClip.get(row.clipId)
      // Later measurement wins; ties keep the later line in file order.
      if (!existing || Date.parse(row.recordedAt) >= Date.parse(existing.recordedAt)) {
        byClip.set(row.clipId, row)
      }
    }
    return [...byClip.values()].map(({ recordedAt: _r, source: _s, ...clip }) => clip)
  }
}

/**
 * Reject impossible measurements at the boundary rather than letting them
 * reach the scorer. Returns null when valid, else why not.
 */
export function validatePerformance(p: ClipPerformance): string | null {
  if (!p.clipId?.trim()) return 'clipId is required'
  if (!p.postedAt?.trim() || Number.isNaN(Date.parse(p.postedAt))) {
    return 'postedAt must be a valid timestamp'
  }
  for (const [name, value] of [
    ['reach', p.reach],
    ['views', p.views],
    ['avgWatchTimeSeconds', p.avgWatchTimeSeconds],
    ['durationSeconds', p.durationSeconds],
    ['interactions', p.interactions],
  ] as const) {
    if (!Number.isFinite(value)) return `${name} must be a finite number`
    if (value < 0) return `${name} cannot be negative`
  }
  if (p.durationSeconds <= 0) return 'durationSeconds must be greater than zero'
  // Views counts plays; reach counts unique accounts. Views below reach would
  // mean an account was reached without the clip playing, which Instagram does
  // not report — a sign of transposed fields.
  if (p.views < p.reach) {
    return `views (${p.views}) below reach (${p.reach}); fields may be transposed`
  }
  return null
}
