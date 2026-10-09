import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The ledger resolves its path from process.cwd() at import time, so run these
// in a scratch directory to avoid touching the repo's real ledger.
const dir = await mkdtemp(join(tmpdir(), 'ledger-'))
const originalCwd = process.cwd()
process.chdir(dir)
const { record, creditsToUsd, RUNWAY_USD_PER_CREDIT } = await import(
  '../lib/cost-ledger.ts'
)

test('creditsToUsd uses the published developer-portal rate', () => {
  assert.equal(RUNWAY_USD_PER_CREDIT, 0.01)
  assert.equal(creditsToUsd(40), 0.4) // h3_max 768p, 5s = 40 credits
  assert.equal(creditsToUsd(0), 0)
})

test('record appends one parseable JSON line carrying the real cost', async () => {
  await record({
    provider: 'runway',
    model: 'h3_max',
    credits: 40,
    usd: creditsToUsd(40),
    requestId: 'task_test_1',
    status: 'SUCCEEDED',
    durationSeconds: 5,
    resolution: '768p',
  })
  const lines = (await readFile(join(dir, '.cost-ledger.jsonl'), 'utf8'))
    .trim()
    .split('\n')
  assert.equal(lines.length, 1)
  const entry = JSON.parse(lines[0])
  assert.equal(entry.provider, 'runway')
  assert.equal(entry.model, 'h3_max')
  assert.equal(entry.credits, 40)
  assert.equal(entry.usd, 0.4)
  assert.equal(entry.status, 'SUCCEEDED')
  assert.ok(Date.parse(entry.at) > 0, 'timestamp is parseable')
})

test('record keeps credits null when a provider reports no cost', async () => {
  await record({
    provider: 'higgsfield',
    model: 'bytedance/seedance-2.5/text-to-video',
    credits: null,
    usd: null,
    requestId: 'req_test_2',
    status: 'completed',
  })
  const lines = (await readFile(join(dir, '.cost-ledger.jsonl'), 'utf8'))
    .trim()
    .split('\n')
  assert.equal(lines.length, 2, 'appends rather than overwrites')
  const entry = JSON.parse(lines[1])
  assert.equal(entry.credits, null, 'no fabricated cost')
  assert.equal(entry.usd, null)
})

test('a ledger write failure never throws into the caller', async () => {
  // Point the ledger at an unwritable path by removing the cwd it resolved.
  const gone = await mkdtemp(join(tmpdir(), 'ledger-gone-'))
  process.chdir(gone)
  await rm(gone, { recursive: true, force: true })
  await record({
    provider: 'runway',
    model: 'h3_max',
    credits: 1,
    usd: 0.01,
    requestId: null,
    status: 'SUCCEEDED',
  })
  process.chdir(dir)
})

test.after(async () => {
  process.chdir(originalCwd)
  await rm(dir, { recursive: true, force: true })
})
