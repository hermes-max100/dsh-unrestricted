/**
 * Append-only spend ledger, shared by every provider example.
 *
 * Each generation appends one JSON line with the credits/USD actually charged,
 * so spend is auditable after the fact instead of estimated from a rate card.
 * Runway's terminal task reports real credits in `task.cost.credits`; providers
 * that don't report cost record `credits: null` rather than a guess.
 */
import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const LEDGER_PATH = resolve(process.cwd(), '.cost-ledger.jsonl')

/** Runway API credits are $0.01 each, purchased in the developer portal. */
export const RUNWAY_USD_PER_CREDIT = 0.01

export interface LedgerEntry {
  at: string
  provider: 'runway' | 'higgsfield'
  model: string
  /** Credits charged, when the provider reports them. null when unknown. */
  credits: number | null
  /** USD charged or derived. null when the provider doesn't expose a rate. */
  usd: number | null
  requestId: string | null
  status: string
  durationSeconds?: number
  resolution?: string
  note?: string
}

/**
 * Append one entry. A ledger write must never mask or replace the generation
 * result, so failures are reported and swallowed rather than thrown.
 */
export async function record(entry: Omit<LedgerEntry, 'at'>): Promise<void> {
  const line: LedgerEntry = { at: new Date().toISOString(), ...entry }
  try {
    await appendFile(LEDGER_PATH, JSON.stringify(line) + '\n', 'utf8')
    const cost =
      line.usd !== null
        ? `$${line.usd.toFixed(4)}${line.credits !== null ? ` (${line.credits} cr)` : ''}`
        : 'cost not reported by provider'
    console.log(`  ledger: ${line.provider}/${line.model} ${line.status} — ${cost}`)
  } catch (error) {
    console.warn(
      `  ledger: could not write ${LEDGER_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

/** Convert Runway credits to USD at the published developer-portal rate. */
export function creditsToUsd(credits: number): number {
  return credits * RUNWAY_USD_PER_CREDIT
}
