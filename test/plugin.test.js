import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../src/index.js'

function credentials(initial) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    writes: [],
    failSet: false,
    async resolve(ref) {
      const value = values.get(ref)
      return value === undefined ? undefined : { value, source: 'test' }
    },
    async set(ref, value) {
      if (this.failSet) throw new Error('store is read-only')
      this.writes.push([ref, value])
      values.set(ref, value)
    },
  }
}

function context(creds) {
  const listeners = new Map()
  const logs = []
  const ctx = {
    logger: {
      info(message) {
        logs.push(['info', message])
      },
      warn(message) {
        logs.push(['warn', message])
      },
      error(message) {
        logs.push(['error', message])
      },
    },
    logs,
    get(name) {
      return name === 'credentials' ? creds : undefined
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const index = list.indexOf(listener)
        if (index !== -1) list.splice(index, 1)
        return index !== -1
      }
    },
    listenerCount(event) {
      return (listeners.get(event) ?? []).length
    },
    async dispatch(payload, terminal = async () => undefined) {
      const list = listeners.get('agent/request-error') ?? []
      let next = terminal
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const listener = list[index]
        const inner = next
        next = () => listener(payload, inner)
      }
      return next()
    },
  }
  return ctx
}

function poolConfig(overrides = {}) {
  return {
    pools: {
      'mn-shared1': {
        apiKeyEnv: 'POOL_ACTIVE',
        keys: ['POOL_KEY_1', 'POOL_KEY_2', 'POOL_KEY_3'],
        retryDelayMs: 0,
        ...overrides,
      },
    },
  }
}

let nextStep = 0
function payload(agent, overrides = {}) {
  nextStep += 1
  return {
    agent,
    turn: 1,
    step: nextStep,
    provider: 'mn-shared1',
    failure: { code: 'QUOTA', message: 'quota exhausted' },
    retryPolicy: {
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: ['RATE_LIMIT'],
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    },
    signal: new AbortController().signal,
    ...overrides,
  }
}

test('a quota failure switches keys and asks the loop to retry', async () => {
  const creds = credentials({ POOL_ACTIVE: 'k1', POOL_KEY_1: 'k1', POOL_KEY_2: 'k2' })
  const ctx = context(creds)
  apply(ctx, poolConfig())

  let downstream = 0
  const action = await ctx.dispatch(payload({}), async () => {
    downstream += 1
    return undefined
  })

  assert.deepEqual(action, { kind: 'retry' })
  assert.equal(downstream, 0)
  assert.deepEqual(creds.writes, [['POOL_ACTIVE', 'k2']])
  assert.equal(creds.values.get('POOL_ACTIVE'), 'k2')
  assert.match(ctx.logs.at(-1)[1], /switched to pool key 2\/3/)
})

test('a failure code outside rotateOnCodes delegates unchanged', async () => {
  const creds = credentials({ POOL_ACTIVE: 'k1', POOL_KEY_1: 'k1', POOL_KEY_2: 'k2' })
  const ctx = context(creds)
  apply(ctx, poolConfig())

  let downstream = 0
  const action = await ctx.dispatch(
    payload({}, { failure: { code: 'SERVER', message: '500' } }),
    async () => {
      downstream += 1
      return undefined
    },
  )

  assert.equal(action, undefined)
  assert.equal(downstream, 1)
  assert.equal(creds.writes.length, 0)
})

test('an unconfigured provider delegates unchanged', async () => {
  const creds = credentials({ POOL_ACTIVE: 'k1', POOL_KEY_1: 'k1' })
  const ctx = context(creds)
  apply(ctx, poolConfig())

  let downstream = 0
  const action = await ctx.dispatch(payload({}, { provider: 'other' }), async () => {
    downstream += 1
    return undefined
  })

  assert.equal(action, undefined)
  assert.equal(downstream, 1)
  assert.equal(creds.writes.length, 0)
})

test('a fully exhausted pool delegates instead of looping', async () => {
  const creds = credentials({ POOL_ACTIVE: 'k1', POOL_KEY_1: 'k1', POOL_KEY_2: 'k2' })
  const ctx = context(creds)
  apply(ctx, poolConfig({ keys: ['POOL_KEY_1', 'POOL_KEY_2'] }))

  const agent = {}
  const first = await ctx.dispatch(payload(agent, { step: 1 }))
  assert.deepEqual(first, { kind: 'retry' })
  assert.equal(creds.values.get('POOL_ACTIVE'), 'k2')

  // The retried attempt with k2 also reports quota exhaustion: the step budget is spent.
  let downstream = 0
  const second = await ctx.dispatch(payload(agent, { step: 1 }), async () => {
    downstream += 1
    return undefined
  })
  assert.equal(second, undefined)
  assert.equal(downstream, 1)
  assert.equal(creds.writes.length, 1)
  assert.equal(creds.values.get('POOL_ACTIVE'), 'k2')
})

test('concurrent failures of the same step switch keys only once', async () => {
  const creds = credentials({ POOL_ACTIVE: 'k1', POOL_KEY_1: 'k1', POOL_KEY_2: 'k2', POOL_KEY_3: 'k3' })
  const ctx = context(creds)
  apply(ctx, poolConfig())

  const agent = {}
  const [first, second] = await Promise.all([
    ctx.dispatch(payload(agent, { step: 7 })),
    ctx.dispatch(payload(agent, { step: 7 })),
  ])

  assert.deepEqual(first, { kind: 'retry' })
  assert.deepEqual(second, { kind: 'retry' })
  assert.equal(creds.writes.length, 1)
  assert.equal(creds.values.get('POOL_ACTIVE'), 'k2')
})

test('a read-only credential store delegates and warns', async () => {
  const creds = credentials({ POOL_ACTIVE: 'k1', POOL_KEY_1: 'k1', POOL_KEY_2: 'k2' })
  creds.failSet = true
  const ctx = context(creds)
  apply(ctx, poolConfig())

  let downstream = 0
  const action = await ctx.dispatch(payload({}), async () => {
    downstream += 1
    return undefined
  })

  assert.equal(action, undefined)
  assert.equal(downstream, 1)
  assert.match(ctx.logs.at(-1)[1], /could not switch the key/)
})

test('an aborted turn does not request a retry', async () => {
  const creds = credentials({ POOL_ACTIVE: 'k1', POOL_KEY_1: 'k1', POOL_KEY_2: 'k2' })
  const ctx = context(creds)
  apply(ctx, poolConfig({ retryDelayMs: 500 }))

  const controller = new AbortController()
  const signal = controller.signal
  controller.abort()
  const action = await ctx.dispatch(payload({}, { signal }))
  assert.equal(action, undefined)
})

test('aborting during the retry delay delegates instead of retrying', async () => {
  const creds = credentials({ POOL_ACTIVE: 'k1', POOL_KEY_1: 'k1', POOL_KEY_2: 'k2' })
  const ctx = context(creds)
  apply(ctx, poolConfig({ retryDelayMs: 200 }))

  const controller = new AbortController()
  setTimeout(() => controller.abort(), 10)
  const action = await ctx.dispatch(payload({}, { signal: controller.signal }))
  assert.equal(action, undefined)
})

test('a disabled config installs no listener', () => {
  const ctx = context(credentials({}))
  apply(ctx, { enabled: false, pools: {} })
  assert.equal(ctx.listenerCount('agent/request-error'), 0)
})

test('an empty pool config installs a listener that always delegates', async () => {
  const creds = credentials({})
  const ctx = context(creds)
  apply(ctx, { pools: {} })
  assert.equal(ctx.listenerCount('agent/request-error'), 1)

  let downstream = 0
  const action = await ctx.dispatch(payload({}), async () => {
    downstream += 1
    return undefined
  })
  assert.equal(action, undefined)
  assert.equal(downstream, 1)
})

test('the provider retry-after delay is honored and capped', async () => {
  const creds = credentials({ POOL_ACTIVE: 'k1', POOL_KEY_1: 'k1', POOL_KEY_2: 'k2' })
  const ctx = context(creds)
  apply(ctx, poolConfig({ retryDelayMs: 0 }))

  const started = Date.now()
  const action = await ctx.dispatch(
    payload({}, { failure: { code: 'RATE_LIMIT', message: '429', providerRetryAfterMs: 30 } }),
  )
  assert.deepEqual(action, { kind: 'retry' })
  assert.ok(Date.now() - started >= 25, 'the provider retry-after delay should be awaited')
})