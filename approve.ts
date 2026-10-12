#!/usr/bin/env node
/**
 * Approval CLI — the operator surface for the render queue.
 *
 * This is the verify -> enqueue wiring for a local file, plus the approve and
 * reject decisions. Flags are non-interactive so the whole thing is scriptable
 * and testable; nothing here prompts.
 *
 *   approve.ts list
 *   approve.ts show <id>
 *   approve.ts enqueue <file> --provider runway --model h3_max \
 *       --rights own-footage [--aspect 9:16 --duration 5 --require-audio]
 *   approve.ts enqueue <file> ... --rights licensed --licensor Pond5 --license-ref INV-7781
 *   approve.ts enqueue <file> ... --rights subject-consent --subject "A. Person" \
 *       --consent-ref releases/a-person.pdf --obtained-at 2026-10-01
 *   approve.ts approve <id> --by carmelo
 *   approve.ts reject <id> --reason "face drift on the hook frame"
 *
 * Exits non-zero on any failure, and never prints a success line for work that
 * did not happen.
 */
import { verifyRender } from './lib/verify-render.ts'
import {
  ApprovalQueue,
  validateRightsBasis,
  type RightsBasis,
  type QueueEntry,
} from './lib/approval-queue.ts'

const USAGE = `usage:
  approve.ts list
  approve.ts show <id>
  approve.ts enqueue <file> --provider <p> --model <m> --rights <basis> [checks]
  approve.ts approve <id> --by <name>
  approve.ts reject <id> --reason <text>

  rights bases:
    --rights own-footage
    --rights licensed --licensor <name> --license-ref <ref>
    --rights subject-consent --subject <name> --consent-ref <ref> --obtained-at <date>

  optional checks for enqueue:
    --aspect <w:h>   --duration <seconds>   --require-audio   --min-width <px>`

function die(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

/**
 * Single pass over argv, separating positionals from --key value pairs and
 * bare --flags. Done in one pass by index rather than by value lookup, so an
 * argument that happens to equal a flag's value is still classified correctly
 * (e.g. `approve carmelo --by carmelo`).
 */
function parseArgs(argv: string[]): {
  positional: string[]
  flags: Map<string, string | true>
} {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(key, next)
      i++ // consumed as this flag's value, so it is not a positional
    } else {
      flags.set(key, true)
    }
  }
  return { positional, flags }
}

function str(flags: Map<string, string | true>, key: string): string | undefined {
  const v = flags.get(key)
  return typeof v === 'string' ? v : undefined
}

function buildRights(flags: Map<string, string | true>): RightsBasis {
  const kind = str(flags, 'rights')
  if (kind === undefined) {
    die('--rights is required. One of: own-footage, licensed, subject-consent')
  }
  if (kind === 'own-footage') {
    return { kind: 'own-footage', ...(str(flags, 'note') ? { note: str(flags, 'note')! } : {}) }
  }
  if (kind === 'licensed') {
    return {
      kind: 'licensed',
      licensor: str(flags, 'licensor') ?? '',
      licenseRef: str(flags, 'license-ref') ?? '',
      ...(str(flags, 'note') ? { note: str(flags, 'note')! } : {}),
    }
  }
  if (kind === 'subject-consent') {
    return {
      kind: 'subject-consent',
      subject: str(flags, 'subject') ?? '',
      consentRef: str(flags, 'consent-ref') ?? '',
      obtainedAt: str(flags, 'obtained-at') ?? '',
      ...(str(flags, 'note') ? { note: str(flags, 'note')! } : {}),
    }
  }
  die(`unknown --rights value "${kind}". One of: own-footage, licensed, subject-consent`)
}

function describeRights(r: RightsBasis): string {
  if (r.kind === 'own-footage') return 'own footage'
  if (r.kind === 'licensed') return `licensed from ${r.licensor} (${r.licenseRef})`
  return `consent from ${r.subject}, release ${r.consentRef}, obtained ${r.obtainedAt}`
}

function printEntry(e: QueueEntry): void {
  console.log(`${e.id.slice(0, 12)}  ${e.status.padEnd(8)}  ${e.provider}/${e.model}`)
  console.log(`  ${e.facts.width}x${e.facts.height} (${e.facts.aspectRatio})  ` +
    `${e.facts.durationSeconds.toFixed(2)}s  audio=${e.facts.hasAudio}  ${e.facts.bytes} bytes`)
  console.log(`  rights: ${describeRights(e.rights)}`)
  if (e.note) console.log(`  note: ${e.note}`)
}

const [command, ...rest] = process.argv.slice(2)
const { positional, flags } = parseArgs(rest)
const queue = new ApprovalQueue()

switch (command) {
  case 'list': {
    const pending = await queue.listPending()
    if (pending.length === 0) {
      console.log('no renders pending review')
      break
    }
    console.log(`${pending.length} pending:`)
    for (const e of pending) printEntry(e)
    break
  }

  case 'show': {
    const id = positional[0]
    if (!id) die('show needs an id')
    const entry = await queue.get(id)
    if (!entry) die(`no queued render with id ${id}`)
    printEntry(entry)
    break
  }

  case 'enqueue': {
    const file = positional[0]
    if (!file) die('enqueue needs a file path')
    const provider = str(flags, 'provider')
    const model = str(flags, 'model')
    if (!provider || !model) die('enqueue needs --provider and --model')

    const rights = buildRights(flags)
    // Check the basis before spending time on ffprobe.
    const invalid = validateRightsBasis(rights)
    if (invalid !== null) die(`rights basis incomplete: ${invalid}`)

    const verification = await verifyRender(file, {
      ...(str(flags, 'aspect') ? { expectAspectRatio: str(flags, 'aspect')! } : {}),
      ...(str(flags, 'duration')
        ? { expectDurationSeconds: Number.parseFloat(str(flags, 'duration')!) }
        : {}),
      ...(str(flags, 'min-width')
        ? { minWidth: Number.parseInt(str(flags, 'min-width')!, 10) }
        : {}),
      ...(flags.get('require-audio') === true ? { requireAudio: true } : {}),
    })
    if (!verification.ok) die(`render did not verify — ${verification.reason}`)

    const entry = await queue.enqueue(verification, { provider, model, rights })
    console.log('✓ verified and queued')
    printEntry(entry)
    break
  }

  case 'approve': {
    const id = positional[0]
    if (!id) die('approve needs an id')
    const by = str(flags, 'by')
    if (!by) die('approve needs --by <name>: approvals are attributed')
    try {
      const entry = await queue.approve(id, by)
      console.log(`✓ approved by ${by}`)
      printEntry(entry)
    } catch (error) {
      die(error instanceof Error ? error.message : String(error))
    }
    break
  }

  case 'reject': {
    const id = positional[0]
    if (!id) die('reject needs an id')
    const reason = str(flags, 'reason')
    if (!reason) die('reject needs --reason <text>')
    try {
      const entry = await queue.reject(id, reason)
      console.log('✓ rejected')
      printEntry(entry)
    } catch (error) {
      die(error instanceof Error ? error.message : String(error))
    }
    break
  }

  default:
    console.error(USAGE)
    process.exit(command === undefined ? 1 : 1)
}
