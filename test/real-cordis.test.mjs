import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import * as keyPool from '../src/index.js'

// This optional check exercises the real Cordis runtime (fiber lifecycle,
// service injection, waterfall dispatch) when a DSH installation is available.
// The dependency-free suite already covers the rotation logic and the plugin's
// listener contract, so this test skips on a bare checkout.
const dshRoot = process.env.DSH_PACKAGE_ROOT

test(
  'the plugin activates on a real Cordis context and disposes its listener',
  { skip: dshRoot === undefined ? 'set DSH_PACKAGE_ROOT to the @deepseek-ai/dsh package directory' : false },
  async () => {
    const cordis = await import(
      pathToFileURL(join(dshRoot, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href
    )
    const { Context, Service } = cordis

    class TestCredentials extends Service {
      constructor(ctx) {
        super(ctx, 'credentials')
        this.values = new Map([
          ['ACTIVE', 'k1'],
          ['KEY_1', 'k1'],
          ['KEY_2', 'k2'],
        ])
        this.writes = []
      }

      async resolve(ref) {
        const value = this.values.get(ref)
        return value === undefined ? undefined : { value, source: 'test' }
      }

      async set(ref, value) {
        this.writes.push([ref, value])
        this.values.set(ref, value)
      }
    }

    const root = new Context()
    try {
      await root.plugin(TestCredentials)
      await root.plugin(keyPool, {
        pools: {
          p: {
            apiKeyEnv: 'ACTIVE',
            keys: ['KEY_1', 'KEY_2'],
            retryDelayMs: 0,
          },
        },
      })

      const agent = { id: 'agent-1' }
      const payload = {
        agent,
        turn: 1,
        step: 1,
        provider: 'p',
        failure: { code: 'QUOTA', message: 'quota exhausted' },
        signal: new AbortController().signal,
      }
      const action = await root.waterfall('agent/request-error', payload, () =>
        Promise.resolve(undefined),
      )
      assert.deepEqual(action, { kind: 'retry' })
      assert.equal(root.credentials.values.get('ACTIVE'), 'k2')
      assert.deepEqual(root.credentials.writes, [['ACTIVE', 'k2']])
    } finally {
      await root.fiber.dispose()
    }
  },
)