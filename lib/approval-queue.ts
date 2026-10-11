/**
 * Human-approval queue for verified renders.
 *
 * Two invariants, both enforced rather than documented:
 *
 *  1. Only a *verified* render can be queued. `enqueue` accepts the ok:true
 *     branch of a Verification, so an unverified file cannot reach the queue
 *     through the type system at all.
 *  2. Nothing is approved without an explicit rights confirmation.
 *     `sourceRightsConfirmed` is required on every entry and `approve` refuses
 *     without it. Publishing a likeness of an identifiable person without
 *     consent is the largest standing risk in this pipeline, so it is a gate
 *     in the code, not a note in a README.
 *
 * State is a fold over an append-only JSONL log, so the history of who
 * approved what, and when, survives as evidence.
 */
import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { RenderFacts, Verification } from './verify-render.ts'

export type VerifiedRender = Extract<Verification, { ok: true }>
export type QueueStatus = 'pending' | 'approved' | 'rejected' | 'posted'

export interface QueueEntry {
  /** The render's sha256. Identity is content, so a re-render is a new entry. */
  id: string
  at: string
  status: QueueStatus
  facts: RenderFacts
  provider: string
  model: string
  /**
   * Whether the operator has confirmed rights to the source footage and, where
   * a real person's likeness appears, their consent. Required; blocks approval.
   */
  sourceRightsConfirmed: boolean
  note?: string
}

type Event =
  | { kind: 'enqueue'; entry: QueueEntry }
  | { kind: 'approve'; id: string; at: string; by: string }
  | { kind: 'reject'; id: string; at: string; reason: string }
  | { kind: 'posted'; id: string; at: string }

export class ApprovalQueue {
  readonly logPath: string

  constructor(dir: string = process.cwd()) {
    this.logPath = resolve(dir, '.approval-queue.jsonl')
  }

  private async events(): Promise<Event[]> {
    let raw: string
    try {
      raw = await readFile(this.logPath, 'utf8')
    } catch {
      return [] // No log yet is an empty queue, not an error.
    }
    return raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Event)
  }

  private async append(event: Event): Promise<void> {
    await appendFile(this.logPath, JSON.stringify(event) + '\n', 'utf8')
  }

  /** Fold the log into current state, keyed by render id. */
  async state(): Promise<Map<string, QueueEntry>> {
    const byId = new Map<string, QueueEntry>()
    for (const event of await this.events()) {
      if (event.kind === 'enqueue') {
        // First write wins: re-enqueuing identical content must not reset an
        // existing decision.
        if (!byId.has(event.entry.id)) byId.set(event.entry.id, { ...event.entry })
        continue
      }
      const entry = byId.get(event.id)
      if (!entry) continue
      if (event.kind === 'approve') entry.status = 'approved'
      else if (event.kind === 'reject') {
        entry.status = 'rejected'
        entry.note = event.reason
      } else if (event.kind === 'posted') entry.status = 'posted'
    }
    return byId
  }

  /**
   * Queue a verified render for review.
   * Returns the entry, or the existing one if this exact content is queued.
   */
  async enqueue(
    verified: VerifiedRender,
    meta: { provider: string; model: string; sourceRightsConfirmed: boolean; note?: string },
  ): Promise<QueueEntry> {
    const existing = (await this.state()).get(verified.facts.sha256)
    if (existing) return existing

    const entry: QueueEntry = {
      id: verified.facts.sha256,
      at: new Date().toISOString(),
      status: 'pending',
      facts: verified.facts,
      provider: meta.provider,
      model: meta.model,
      sourceRightsConfirmed: meta.sourceRightsConfirmed,
      ...(meta.note !== undefined ? { note: meta.note } : {}),
    }
    await this.append({ kind: 'enqueue', entry })
    return entry
  }

  async listPending(): Promise<QueueEntry[]> {
    return [...(await this.state()).values()].filter((e) => e.status === 'pending')
  }

  async get(id: string): Promise<QueueEntry | undefined> {
    return (await this.state()).get(id)
  }

  /** Approve for posting. Refuses unless rights were confirmed at enqueue. */
  async approve(id: string, by: string): Promise<QueueEntry> {
    const entry = (await this.state()).get(id)
    if (!entry) throw new Error(`no queued render with id ${id}`)
    if (entry.status === 'rejected') {
      throw new Error(`render ${id} was rejected; re-render rather than approving`)
    }
    if (!entry.sourceRightsConfirmed) {
      throw new Error(
        `render ${id} cannot be approved: source rights / likeness consent ` +
          `were not confirmed. Confirm rights at enqueue time.`,
      )
    }
    await this.append({ kind: 'approve', id, at: new Date().toISOString(), by })
    return (await this.state()).get(id)!
  }

  async reject(id: string, reason: string): Promise<QueueEntry> {
    const entry = (await this.state()).get(id)
    if (!entry) throw new Error(`no queued render with id ${id}`)
    await this.append({ kind: 'reject', id, at: new Date().toISOString(), reason })
    return (await this.state()).get(id)!
  }

  /** Mark as posted. Only an approved render may be posted. */
  async markPosted(id: string): Promise<QueueEntry> {
    const entry = (await this.state()).get(id)
    if (!entry) throw new Error(`no queued render with id ${id}`)
    if (entry.status !== 'approved') {
      throw new Error(
        `render ${id} is ${entry.status}, not approved; nothing posts without approval`,
      )
    }
    await this.append({ kind: 'posted', id, at: new Date().toISOString() })
    return (await this.state()).get(id)!
  }
}
