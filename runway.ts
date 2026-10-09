/**
 * Runway example: MiniMax H3 Max generation + Act-Two character performance.
 *
 * Run with:  pnpm run runway:example
 * (which is: node --env-file=.env.local runway.ts)
 *
 * Credentials come from RUNWAYML_API_SECRET, which the SDK reads itself; the
 * value is never printed or logged. Note that Runway API credits are a separate
 * balance from a runway.com subscription — a consumer plan does not fund these
 * calls.
 *
 * Modes, chosen by which asset URLs are present in the environment:
 *   - h3_max text-to-video    (default; no assets required)
 *   - h3_max image-to-video   (when RUNWAY_PROMPT_IMAGE is set)
 *   - act_two performance     (when RUNWAY_CHARACTER_IMAGE + RUNWAY_REFERENCE_VIDEO are set)
 *
 * H3 Max exposes no aspect-ratio parameter: image-to-video inherits the source
 * image's ratio, so vertical 9:16 output requires a 9:16 character still.
 */
import RunwayML, { TaskFailedError, TaskTimedOutError } from '@runwayml/sdk'
import { record, creditsToUsd } from './lib/cost-ledger.ts'

const DURATION_SECONDS = 5
const RESOLUTION = '768p' as const
const PROMPT = 'A cinematic scene at sunset'

function fail(message: string, detail?: unknown): never {
  console.error(`✗ ${message}`)
  if (detail !== undefined) console.error(detail)
  process.exit(1)
}

// Presence check only; the secret itself is never read into output.
if (!process.env.RUNWAYML_API_SECRET?.trim()) {
  fail(
    'RUNWAYML_API_SECRET is not set.\n' +
      '  Add it to .env.local (see .env.local.example). The file is gitignored.\n' +
      '  Runway API credits are bought in the developer portal and are separate\n' +
      '  from any runway.com subscription.',
  )
}

const client = new RunwayML()

/** A terminal SUCCEEDED task, as returned by waitForTaskOutput(). */
type Succeeded = Awaited<
  ReturnType<ReturnType<typeof client.textToVideo.create>['waitForTaskOutput']>
>

/**
 * What create() returns: an APIPromise that also carries waitForTaskOutput().
 * Every resource's waitForTaskOutput resolves to the same Succeeded shape.
 */
interface WaitableTask {
  waitForTaskOutput(): Promise<Succeeded>
  catch(onrejected: (reason: unknown) => unknown): unknown
}

/**
 * Start a task, ledger the real cost, and return the output URL.
 * Throws on anything that is not a SUCCEEDED task carrying an asset.
 *
 * Takes a factory rather than a promise so the request is created inside the
 * try block.
 */
async function settle(
  label: string,
  model: string,
  start: () => WaitableTask,
): Promise<string> {
  let result: Succeeded
  try {
    const pending = start()
    // create() returns an APIPromise and waitForTaskOutput() derives a SECOND
    // promise from it. Nothing handles the original, so on a request-level
    // failure (bad key, 4xx) its rejection is unhandled and Node's default
    // --unhandled-rejections=throw kills the process before any catch runs.
    // The documented example has this problem; attaching a no-op handler to
    // the original fixes it. The derived promise still surfaces the real error.
    void pending.catch(() => {})
    result = await pending.waitForTaskOutput()
  } catch (error) {
    // waitForTaskOutput throws TaskFailedError for FAILED *and* CANCELLED.
    if (error instanceof TaskFailedError) {
      const details = error.taskDetails
      await record({
        provider: 'runway',
        model,
        credits: null,
        usd: null,
        requestId: details?.id ?? null,
        status: details?.status ?? 'FAILED',
        note: 'task failed or was cancelled',
      })
      fail(`${label}: task ${details?.status ?? 'FAILED'}.`, details)
    }
    if (error instanceof TaskTimedOutError) {
      fail(`${label}: timed out before completion.`, error.taskDetails)
    }
    const name = error instanceof Error ? error.constructor.name : 'UnknownError'
    const message = error instanceof Error ? error.message : String(error)
    fail(`${label}: ${name}: ${message}`)
  }

  const credits = result.cost?.credits ?? null
  await record({
    provider: 'runway',
    model,
    credits,
    usd: credits === null ? null : creditsToUsd(credits),
    requestId: result.id,
    status: result.status,
    durationSeconds: DURATION_SECONDS,
    resolution: RESOLUTION,
  })

  const url = result.output?.[0]
  if (!url) {
    // SUCCEEDED with no asset is not a success we can hand to a caller.
    fail(`${label}: status SUCCEEDED but no output URL was returned.`, result)
  }
  return url
}

const promptImage = process.env.RUNWAY_PROMPT_IMAGE?.trim()
const characterImage = process.env.RUNWAY_CHARACTER_IMAGE?.trim()
const referenceVideo = process.env.RUNWAY_REFERENCE_VIDEO?.trim()

// ---- Base generation: MiniMax H3 Max (#1 on image-to-video) ----------------
let videoUrl: string

if (promptImage) {
  console.log(`→ h3_max image-to-video @ ${RESOLUTION}, ${DURATION_SECONDS}s`)
  console.log('  (output inherits the source image aspect ratio)')
  videoUrl = await settle(
    'h3_max image-to-video',
    'h3_max',
    () =>
      client.imageToVideo.create({
        model: 'h3_max',
        promptImage,
        promptText: PROMPT,
        duration: DURATION_SECONDS,
        resolution: RESOLUTION,
      }),
  )
} else {
  console.log(`→ h3_max text-to-video @ ${RESOLUTION}, ${DURATION_SECONDS}s`)
  console.log('  (set RUNWAY_PROMPT_IMAGE to use image-to-video instead)')
  videoUrl = await settle(
    'h3_max text-to-video',
    'h3_max',
    () =>
      client.textToVideo.create({
        model: 'h3_max',
        promptText: PROMPT,
        duration: DURATION_SECONDS,
        resolution: RESOLUTION,
      }),
  )
}

console.log('✓ Generation completed')
console.log(`  video: ${videoUrl}`)
console.log('  note: Runway output URLs expire in 24-48h — download to keep them.')

// ---- Character performance: Act-Two ----------------------------------------
if (characterImage && referenceVideo) {
  console.log('\n→ act_two character performance')
  const performanceUrl = await settle(
    'act_two',
    'act_two',
    () =>
      client.characterPerformance.create({
        model: 'act_two',
        character: { type: 'image', uri: characterImage },
        reference: { type: 'video', uri: referenceVideo },
        bodyControl: true,
      }),
  )
  console.log('✓ Performance completed')
  console.log(`  video: ${performanceUrl}`)
} else {
  console.log(
    '\n⊘ act_two skipped: set RUNWAY_CHARACTER_IMAGE and RUNWAY_REFERENCE_VIDEO.',
  )
  console.log('  The reference video must be 3-30 seconds and show a visible face.')
}
