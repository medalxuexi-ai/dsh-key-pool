import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeConfig } from '../src/config.js'
import {
  budgetFor,
  createRotationState,
  rotateToNextKey,
  serializeByProvider,
} from '../src/rotation.js'

function credentials(initial) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    writes: [],
    async resolve(ref) {
      const value = values.get(ref)
      return value === undefined ? undefined : { value, source: 'test' }
    },
    async set(ref, value) {
      this.writes.push([ref, value])
      values.set(ref, value)
    },
  }
}

function poolFrom(raw) {
  return normalizeConfig({ pools: { p: raw } }).pools.get('p')
}

test('rotation advances to the next configured key and commits it to apiKeyEnv', async () => {
  const creds = credentials({ ACTIVE: 'k1', KEY_1: 'k1', KEY_2: 'k2', KEY_3: 'k3' })
  const pool = poolFrom({ apiKeyEnv: 'ACTIVE', keys: ['KEY_1', 'KEY_2', 'KEY_3'] })
  const outcome = await rotateToNextKey(creds, pool, 'k1')
  assert.deepEqual(outcome, { rotated: true, external: false, index: 1 })
  assert.equal(creds.values.get('ACTIVE'), 'k2')
})

test('rotation wraps around and skips the active value', async () => {
  const creds = credentials({ ACTIVE: 'k3', KEY_1: 'k1', KEY_2: 'k2', KEY_3: 'k3' })
  const pool = poolFrom({ apiKeyEnv: 'ACTIVE', keys: ['KEY_1', 'KEY_2', 'KEY_3'] })
  const outcome = await rotateToNextKey(creds, pool, 'k3')
  assert.deepEqual(outcome, { rotated: true, external: false, index: 0 })
  assert.equal(creds.values.get('ACTIVE'), 'k1')
})

test('rotation skips unconfigured pool slots and duplicate values', async () => {
  const creds = credentials({ ACTIVE: 'k1', KEY_1: 'k1', KEY_2: 'k1', KEY_4: 'k4' })
  const pool = poolFrom({
    apiKeyEnv: 'ACTIVE',
    keys: ['KEY_1', 'KEY_2', 'KEY_3', 'KEY_4'],
  })
  const outcome = await rotateToNextKey(creds, pool, 'k1')
  assert.deepEqual(outcome, { rotated: true, external: false, index: 3 })
  assert.equal(creds.values.get('ACTIVE'), 'k4')
})

test('an unset active reference starts from the first usable pool slot', async () => {
  const creds = credentials({ KEY_2: 'k2' })
  const pool = poolFrom({ apiKeyEnv: 'ACTIVE', keys: ['KEY_1', 'KEY_2'] })
  const outcome = await rotateToNextKey(creds, pool, undefined)
  assert.deepEqual(outcome, { rotated: true, external: false, index: 1 })
  assert.equal(creds.values.get('ACTIVE'), 'k2')
})

test('a pool with no usable alternative reports no rotation', async () => {
  const creds = credentials({ ACTIVE: 'k1', KEY_1: 'k1' })
  const pool = poolFrom({ apiKeyEnv: 'ACTIVE', keys: ['KEY_1', 'KEY_2'] })
  const outcome = await rotateToNextKey(creds, pool, 'k1')
  assert.deepEqual(outcome, { rotated: false })
  assert.equal(creds.writes.length, 0)
})

test('an already-switched active value is reported as external, not rotated twice', async () => {
  const creds = credentials({ ACTIVE: 'k2', KEY_1: 'k1', KEY_2: 'k2' })
  const pool = poolFrom({ apiKeyEnv: 'ACTIVE', keys: ['KEY_1', 'KEY_2'] })
  const outcome = await rotateToNextKey(creds, pool, 'k1')
  assert.deepEqual(outcome, { rotated: true, external: true, index: -1 })
  assert.equal(creds.writes.length, 0)
})

test('serialized tasks see each other and only the first rotates', async () => {
  const state = createRotationState()
  const creds = credentials({ ACTIVE: 'k1', KEY_1: 'k1', KEY_2: 'k2', KEY_3: 'k3' })
  const pool = poolFrom({ apiKeyEnv: 'ACTIVE', keys: ['KEY_1', 'KEY_2', 'KEY_3'] })
  const [first, second] = await Promise.all([
    serializeByProvider(state.queues, 'p', () => rotateToNextKey(creds, pool, 'k1')),
    serializeByProvider(state.queues, 'p', () => rotateToNextKey(creds, pool, 'k1')),
  ])
  assert.equal(first.rotated, true)
  assert.equal(second.rotated, true)
  assert.equal(second.external, true)
  assert.equal(creds.writes.length, 1)
  assert.equal(creds.values.get('ACTIVE'), 'k2')
})

test('a rejected task does not poison the provider queue', async () => {
  const state = createRotationState()
  await assert.rejects(
    serializeByProvider(state.queues, 'p', () => {
      throw new Error('boom')
    }),
  )
  const result = await serializeByProvider(state.queues, 'p', async () => 'ok')
  assert.equal(result, 'ok')
})

test('the step budget resets when the step changes and is per Agent', () => {
  const state = createRotationState()
  const agentA = {}
  const agentB = {}
  const first = budgetFor(state.budgets, agentA, 'p', 1, 1)
  first.count = 2
  assert.equal(budgetFor(state.budgets, agentA, 'p', 1, 1).count, 2)
  assert.equal(budgetFor(state.budgets, agentA, 'p', 1, 2).count, 0)
  assert.equal(budgetFor(state.budgets, agentB, 'p', 1, 1).count, 0)
  const anonymous = budgetFor(state.budgets, undefined, 'p', 1, 1)
  anonymous.count = 1
  assert.equal(budgetFor(state.budgets, undefined, 'p', 1, 1).count, 1)
})