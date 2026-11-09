import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_ROTATE_ON_CODES,
  MAX_RETRY_DELAY_MS,
  normalizeConfig,
} from '../src/config.js'

test('an absent config is valid and dormant', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.enabled, true)
  assert.equal(config.pools.size, 0)
  assert.deepEqual([...config.rotateOnCodes], [...DEFAULT_ROTATE_ON_CODES])
  assert.equal(config.retryDelayMs, DEFAULT_RETRY_DELAY_MS)
})

test('a pool inherits global defaults and computes its rotation budget', () => {
  const config = normalizeConfig({
    retryDelayMs: 25,
    rotateOnCodes: ['QUOTA', 'AUTH'],
    pools: {
      'mn-shared1': {
        apiKeyEnv: 'MN_SHARED1_API_KEY',
        keys: ['MN_SHARED1_API_KEY', 'MN_SHARED1_API_KEY_2', 'MN_SHARED1_API_KEY_3'],
      },
    },
  })
  const pool = config.pools.get('mn-shared1')
  assert.equal(pool.apiKeyEnv, 'MN_SHARED1_API_KEY')
  assert.deepEqual(pool.keys, [
    'MN_SHARED1_API_KEY',
    'MN_SHARED1_API_KEY_2',
    'MN_SHARED1_API_KEY_3',
  ])
  assert.deepEqual([...pool.rotateOnCodes], ['QUOTA', 'AUTH'])
  assert.equal(pool.maxRotationsPerStep, 2)
  assert.equal(pool.retryDelayMs, 25)
})

test('a pool can override codes, delay, and rotation budget', () => {
  const config = normalizeConfig({
    retryDelayMs: 25,
    rotateOnCodes: ['QUOTA', 'AUTH'],
    pools: {
      'mn-shared1': {
        apiKeyEnv: 'MN_SHARED1_API_KEY',
        keys: ['MN_SHARED1_API_KEY', 'MN_SHARED1_API_KEY_2'],
        rotateOnCodes: ['RATE_LIMIT'],
        retryDelayMs: 0,
        maxRotationsPerStep: 7,
      },
    },
  })
  const pool = config.pools.get('mn-shared1')
  assert.deepEqual([...pool.rotateOnCodes], ['RATE_LIMIT'])
  assert.equal(pool.retryDelayMs, 0)
  assert.equal(pool.maxRotationsPerStep, 7)
})

test('a one-key pool still allows one recovery attempt', () => {
  const config = normalizeConfig({
    pools: { p: { apiKeyEnv: 'P_KEY', keys: ['P_KEY'] } },
  })
  assert.equal(config.pools.get('p').maxRotationsPerStep, 1)
})

test('a default provider/model selection is parsed and optional', () => {
  const configured = normalizeConfig({
    defaultModel: { provider: 'mn-shared1', model: 'deepseek-v4.1-flash' },
    pools: {},
  })
  assert.deepEqual(configured.defaultModel, {
    provider: 'mn-shared1',
    model: 'deepseek-v4.1-flash',
  })

  const withEffort = normalizeConfig({
    defaultModel: {
      provider: 'mn-shared1',
      model: 'deepseek-v4.1-flash',
      reasoningEffort: 'high',
    },
    pools: {},
  })
  assert.deepEqual(withEffort.defaultModel, {
    provider: 'mn-shared1',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'high',
  })

  assert.equal(normalizeConfig({ pools: {} }).defaultModel, undefined)
})

test('malformed default model configs fail loudly', () => {
  const cases = [
    [{ defaultModel: [] }, /defaultModel must be a mapping/],
    [{ defaultModel: {} }, /defaultModel\.provider/],
    [{ defaultModel: { provider: '' } }, /defaultModel\.provider/],
    [{ defaultModel: { provider: 'p', model: '  ' } }, /defaultModel\.model/],
    [
      { defaultModel: { provider: 'p', model: 'm', thinking: 'high' } },
      /defaultModel has unknown key "thinking"/,
    ],
    [
      { defaultModel: { provider: 'p', model: 'm', reasoningEffort: '' } },
      /defaultModel\.reasoningEffort/,
    ],
  ]
  for (const [raw, expected] of cases) {
    assert.throws(() => normalizeConfig(raw), expected)
  }
})

test('malformed configs fail loudly', () => {
  const cases = [
    [{ floop: true }, /unknown config key "floop"/],
    [{ enabled: 'yes' }, /enabled must be a boolean/],
    [{ pools: [] }, /pools must be a mapping/],
    [{ pools: { p: null } }, /pools\.p must be a mapping/],
    [{ pools: { p: { keys: ['A'] } } }, /pools\.p\.apiKeyEnv/],
    [{ pools: { p: { apiKeyEnv: 'bad-name', keys: ['A'] } } }, /pools\.p\.apiKeyEnv/],
    [{ pools: { p: { apiKeyEnv: 'A' } } }, /pools\.p\.keys must be a non-empty array/],
    [{ pools: { p: { apiKeyEnv: 'A', keys: [] } } }, /pools\.p\.keys must be a non-empty array/],
    [{ pools: { p: { apiKeyEnv: 'A', keys: ['A', 'A'] } } }, /lists "A" more than once/],
    [{ pools: { p: { apiKeyEnv: 'A', keys: ['A'], rotatedOn: [] } } }, /unknown key "rotatedOn"/],
    [{ pools: { p: { apiKeyEnv: 'A', keys: ['A'], rotateOnCodes: [] } } }, /non-empty array/],
    [{ pools: { p: { apiKeyEnv: 'A', keys: ['A'], maxRotationsPerStep: 0 } } }, /maxRotationsPerStep/],
    [{ pools: { p: { apiKeyEnv: 'A', keys: ['A'], retryDelayMs: -1 } } }, /retryDelayMs/],
    [{ retryDelayMs: MAX_RETRY_DELAY_MS + 1 }, /retryDelayMs/],
    [{ rotateOnCodes: ['QUOTA', 7] }, /rotateOnCodes\[1\]/],
  ]
  for (const [raw, expected] of cases) {
    assert.throws(() => normalizeConfig(raw), expected)
  }
})

test('global pools and code lists are not shared between configs', () => {
  const first = normalizeConfig({ pools: {} })
  const second = normalizeConfig({ pools: {} })
  assert.notEqual(first.rotateOnCodes, second.rotateOnCodes)
  assert.notEqual(first.rotateOnCodes, DEFAULT_ROTATE_ON_CODES)
})