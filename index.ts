/**
 * Higgsfield text-to-video example: ByteDance Seedance 2.5.
 *
 * Run with:  pnpm run higgsfield:example
 * (which is: node --env-file=.env.local index.ts)
 *
 * Credentials are read from HF_CREDENTIALS (key-id:key-secret) at runtime and
 * are never printed or logged. Keep them in .env.local, which is gitignored.
 * This SDK is server-side only; the v2 client refuses to run in a browser.
 */
import {
  config,
  higgsfield,
  type V2Response,
  type V2RequestStatus,
} from '@higgsfield/client/v2'
import { record } from './lib/cost-ledger.ts'

const MODEL = 'bytedance/seedance-2.5/text-to-video'

const INPUT = {
  prompt: 'A cinematic scene at sunset',
  duration: 5,
  resolution: '720p',
  aspect_ratio: '16:9',
} as const

/** Exit non-zero so a failed generation can never read as success. */
function fail(message: string, detail?: unknown): never {
  console.error(`✗ ${message}`)
  if (detail !== undefined) console.error(detail)
  process.exit(1)
}

// Presence check only — the value itself is never read into a log or message.
const credentials = process.env.HF_CREDENTIALS
if (!credentials || credentials.trim() === '') {
  fail(
    'HF_CREDENTIALS is not set.\n' +
      '  Add it to .env.local as HF_CREDENTIALS=key-id:key-secret\n' +
      '  (copy .env.local.example). The file is gitignored.',
  )
}

config({ credentials })

console.log(`→ Submitting ${MODEL}`)
console.log(
  `  prompt="${INPUT.prompt}" duration=${INPUT.duration}s ` +
    `resolution=${INPUT.resolution} aspect_ratio=${INPUT.aspect_ratio}`,
)

let result: V2Response
try {
  result = await higgsfield.subscribe(MODEL, {
    input: INPUT,
    withPolling: true,
  })
} catch (error) {
  // SDK error classes carry useful context; surface it without dumping secrets.
  const name = error instanceof Error ? error.constructor.name : 'UnknownError'
  const message = error instanceof Error ? error.message : String(error)
  fail(`Request threw ${name}: ${message}`)
}

const status: V2RequestStatus = result.status
console.log(`  request_id=${result.request_id} status=${status}`)

switch (status) {
  case 'completed': {
    const url = result.video?.url
    if (!url) {
      // Completed but no asset: a success claim here would be false.
      fail('Status is "completed" but no video URL was returned.', result)
    }
    // Higgsfield's v2 response carries no cost field, so credits/usd are
    // recorded as null rather than estimated from a published rate.
    await record({
      provider: 'higgsfield',
      model: MODEL,
      credits: null,
      usd: null,
      requestId: result.request_id,
      status,
      durationSeconds: INPUT.duration,
      resolution: INPUT.resolution,
    })
    console.log('✓ Generation completed')
    console.log(`  video: ${url}`)
    break
  }

  case 'failed':
    await record({
      provider: 'higgsfield',
      model: MODEL,
      credits: null,
      usd: null,
      requestId: result.request_id,
      status,
      note: 'generation failed',
    })
    fail('Generation failed.', result)

  case 'nsfw':
    // 'nsfw' is this API's moderation outcome — a rejection, not a success.
    await record({
      provider: 'higgsfield',
      model: MODEL,
      credits: null,
      usd: null,
      requestId: result.request_id,
      status,
      note: 'rejected by content moderation',
    })
    fail('Generation was rejected by content moderation (status "nsfw").', result)

  case 'queued':
  case 'in_progress':
    // withPolling should resolve only on a terminal state; treat as unresolved.
    fail(`Request is still ${status} after polling returned; not complete.`, result)

  default:
    // Covers any terminal state the SDK's union doesn't name, e.g. cancellation.
    fail(`Unexpected terminal status "${status satisfies never}".`, result)
}
