/**
 * Human-approval queue for verified renders.
 *
 * Two invariants, both enforced rather than documented:
 *
 *  1. Only a *verified* render can be queued. `enqueue` accepts the ok:true
 *     branch of a Verification, so an unverified file cannot reach the queue
 *     through the type system at all.
 *  2. Nothing is approved without a rights *record*. Every entry carries a
 *     `RightsBasis` naming how the footage is cleared, and `approve` validates
 *     it. A boolean can be ticked without being true; a basis has to point at
 *     something — a licensor and license reference, or a named subject and a
 *     reference to their signed release. Publishing a likeness of an
 *     identifiable person without consent is the largest standing risk in this
 *     pipeline, so the evidence lives on the queue entry.
 *
 * State is a fold over an append-only JSONL log, so the history of who
 * approved what, and when, survives as evidence.
 */
import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { RenderFacts, Verification } from './verify-render.ts'

export type VerifiedRender = Extract<Verification, { ok: true }>
export type QueueStatus = 'pending' | 'approved' | 'rejected' | 'posted'

/**
 * How the source footage is cleared for publication.
 *
 * `subject-consent` is the case that matters for avatar work: when a real,
 * identifiable person's likeness appears, a name and a pointer to their signed
 * release are required. `consentRef` is that pointer — a file path, document id
 * or URL for the release on file. It is deliberately not a free-text note.
 */
export type RightsBasis =
  | { kind: 'own-footage'; note?: string }
  | { kind: 'licensed'; licensor: string; licenseRef: string; note?: string }
  | {
      kind: 'subject-consent'
      /** The identifiable person whose likeness appears. */
      subject: string
      /** Pointer to the signed release on file. */
      consentRef: string
      /** ISO-8601 date the consent was obtained. */
      obtainedAt: string
      note?: string
    }

/**
 * Validate a rights basis. Returns null when valid, else why it is not.
 * Kept separate from the queue so a UI can check before enqueueing.
 */
export function validateRightsBasis(basis: RightsBasis | undefined): string | null {
  if (!basis) return 'no rights basis supplied'
  if (basis.kind === 'own-footage') return null
  if (basis.kind === 'licensed') {
    if (!basis.licensor?.trim()) return 'licensed footage requires a licensor'
    if (!basis.licenseRef?.trim()) return 'licensed footage requires a licenseRef'
    return null
  }
  if (basis.kind === 'subject-consent') {
    if (!basis.subject?.trim()) {
      return 'subject-consent requires the name of the person depicted'
    }
    if (!basis.consentRef?.trim()) {
      return 'subject-consent requires a consentRef pointing at the signed release'
    }
    if (!basis.obtainedAt?.trim() || Number.isNaN(Date.parse(basis.obtainedAt))) {
      return 'subject-consent requires a valid obtainedAt date'
    }
    return null
  }
  return `unknown rights basis: ${JSON.stringify(basis)}`
}

export interface QueueEntry {
  /** The render's sha256. Identity is content, so a re-render is a new entry. */
  id: string
  at: string
  status: QueueStatus
  facts: RenderFacts
  provider: string
  model: string
  /**
   * How the source footage is cleared. Required; an invalid or absent basis
   * blocks approval.
   */
  rights: RightsBasis
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
    meta: { provider: string; model: string; rights: RightsBasis; note?: string },
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
      rights: meta.rights,
      ...(meta.note !== undefined ? { note: meta.note } : {}),
    }
    await this.append({ kind: 'enqueue', entry })
    return entry
  }

  /**
   * Resolve a full id or unambiguous prefix to a full id, git-style.
   * The queue prints short prefixes, so every id-taking operation accepts one.
   */
  async resolveId(idOrPrefix: string): Promise<string> {
    const state = await this.state()
    if (state.has(idOrPrefix)) return idOrPrefix
    const matches = [...state.keys()].filter((k) => k.startsWith(idOrPrefix))
    if (matches.length === 1) return matches[0]!
    if (matches.length === 0) throw new Error(`no queued render with id ${idOrPrefix}`)
    throw new Error(
      `id prefix ${idOrPrefix} is ambiguous (${matches.length} matches); use more characters`,
    )
  }

  async listPending(): Promise<QueueEntry[]> {
    return [...(await this.state()).values()].filter((e) => e.status === 'pending')
  }

  /** Accepts a full id or an unambiguous prefix. */
  async get(idOrPrefix: string): Promise<QueueEntry | undefined> {
    const state = await this.state()
    if (state.has(idOrPrefix)) return state.get(idOrPrefix)
    const matches = [...state.keys()].filter((k) => k.startsWith(idOrPrefix))
    return matches.length === 1 ? state.get(matches[0]!) : undefined
  }

  /** Approve for posting. Refuses unless rights were confirmed at enqueue. */
  async approve(idOrPrefix: string, by: string): Promise<QueueEntry> {
    const id = await this.resolveId(idOrPrefix)
    const entry = (await this.state()).get(id)
    if (!entry) throw new Error(`no queued render with id ${id}`)
    if (entry.status === 'rejected') {
      throw new Error(`render ${id} was rejected; re-render rather than approving`)
    }
    const invalid = validateRightsBasis(entry.rights)
    if (invalid !== null) {
      throw new Error(
        `render ${id} cannot be approved: ${invalid}. ` +
          `Re-enqueue with a complete rights basis.`,
      )
    }
    await this.append({ kind: 'approve', id, at: new Date().toISOString(), by })
    return (await this.state()).get(id)!
  }

  async reject(idOrPrefix: string, reason: string): Promise<QueueEntry> {
    const id = await this.resolveId(idOrPrefix)
    const entry = (await this.state()).get(id)
    if (!entry) throw new Error(`no queued render with id ${id}`)
    await this.append({ kind: 'reject', id, at: new Date().toISOString(), reason })
    return (await this.state()).get(id)!
  }

  /** Mark as posted. Only an approved render may be posted. */
  async markPosted(idOrPrefix: string): Promise<QueueEntry> {
    const id = await this.resolveId(idOrPrefix)
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
