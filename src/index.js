/**
 * dsh-key-pool: switch the active provider key through a key pool when the
 * current key is exhausted.
 *
 * Recovery rides the agent loop's `agent/request-error` waterfall. A failed
 * attempt whose provider has a configured pool and whose failure code is
 * rotation-eligible commits the next pool key into the provider's `apiKeyEnv`
 * credential reference and asks the loop to retry the same step. Adapter
 * credential resolution is per request, so the retry authenticates with the
 * new key. Recovery is bounded per failed step so a fully exhausted pool ends
 * the turn instead of looping.
 *
 * @module dsh-key-pool
 */

import { MAX_RETRY_DELAY_MS, normalizeConfig } from './config.js'
import {
  budgetFor,
  createRotationState,
  rotateToNextKey,
  serializeByProvider,
} from './rotation.js'

/** Registered plugin name; also the default Cordis entry name. */
export const name = 'key-pool'

/** Rotation needs the credential seam, so wait for its provider before activating. */
export const inject = ['credentials']

/**
 * Activate the plugin: validate config and install the recovery listener.
 *
 * @param ctx - owning Cordis context.
 * @param rawConfig - raw plugin config.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return
  const state = createRotationState()
  ctx.on('agent/request-error', (payload, next) => recover(ctx, config, state, payload, next))
}

/**
 * Recover one failed model attempt by rotating its provider's key.
 *
 * @param ctx - owning Cordis context.
 * @param config - normalized config.
 * @param state - per-plugin rotation state.
 * @param payload - `agent/request-error` payload.
 * @param next - downstream waterfall continuation.
 * @returns `{ kind: 'retry' }` when the step should retry with a new key, else the downstream decision.
 */
export async function recover(ctx, config, state, payload, next) {
  if (payload === undefined) return next()
  if (payload.signal !== undefined && payload.signal.aborted) return next()

  const pool = config.pools.get(payload.provider)
  if (pool === undefined) return next()

  const code = payload.failure === undefined ? undefined : payload.failure.code
  if (typeof code !== 'string' || !pool.rotateOnCodes.has(code)) return next()

  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    log(ctx, 'warn', 'key-pool: the credentials service is unavailable; cannot rotate keys')
    return next()
  }

  const budget = budgetFor(state.budgets, payload.agent, pool.provider, payload.turn, payload.step)
  if (budget.count >= pool.maxRotationsPerStep) return next()

  let activeBefore
  try {
    const hit = await credentials.resolve(pool.apiKeyEnv)
    activeBefore = hit === undefined ? undefined : hit.value
  } catch (error) {
    log(ctx, 'warn', `key-pool: could not read ${pool.apiKeyEnv} for provider "${pool.provider}": ${messageOf(error)}`)
    return next()
  }

  let outcome
  try {
    outcome = await serializeByProvider(state.queues, pool.provider, () =>
      rotateToNextKey(credentials, pool, activeBefore),
    )
  } catch (error) {
    log(
      ctx,
      'warn',
      `key-pool: could not switch the key for provider "${pool.provider}" after ${code}: ${messageOf(error)}`,
    )
    return next()
  }

  if (!outcome.rotated) {
    log(
      ctx,
      'info',
      `key-pool: provider "${pool.provider}" has no unused key in its pool after ${code}; leaving recovery to the provider policy`,
    )
    return next()
  }

  budget.count += 1
  log(
    ctx,
    'info',
    outcome.external
      ? `key-pool: provider "${pool.provider}" was already switched to another pool key after ${code}; retrying the request`
      : `key-pool: provider "${pool.provider}" switched to pool key ${outcome.index + 1}/${pool.keys.length} after ${code}; retrying the request`,
  )

  const delay = retryDelay(pool, payload.failure)
  if (delay > 0 && !(await waitFor(delay, payload.signal))) return next()
  return { kind: 'retry' }
}

/** Pause before retrying: the provider's own delay when present, else the pool default. */
function retryDelay(pool, failure) {
  const providerDelay = failure === undefined ? undefined : failure.providerRetryAfterMs
  if (typeof providerDelay === 'number' && Number.isFinite(providerDelay) && providerDelay > 0) {
    return Math.min(providerDelay, MAX_RETRY_DELAY_MS)
  }
  return Math.min(pool.retryDelayMs, MAX_RETRY_DELAY_MS)
}

/** Await a delay, resolving false when the turn is aborted meanwhile. */
function waitFor(ms, signal) {
  if (signal !== undefined && signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    let timer
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    timer = setTimeout(() => {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Write one diagnostic through the context logger and stderr, never stdout. */
function log(ctx, level, message) {
  const logger = ctx.logger
  if (logger !== undefined && logger !== null) {
    const write = logger[level]
    if (typeof write === 'function') write.call(logger, message)
  }
  // SDK profiles reserve stdout for JSON-RPC; stderr is the safe diagnostic
  // plane and stays visible in a terminal or the web profile's log file.
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(message)
  }
}

/** Render a caught value for a diagnostic line. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}