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
 * An optional `defaultModel` selection also makes the plugin the declarative
 * source of DSH's default provider/model for new sessions (applied through the
 * standard agent-default-model service, which persists the profile override).
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
 * Activate the plugin: validate config, install the recovery listener, and
 * apply the optional default model selection.
 *
 * @param ctx - owning Cordis context.
 * @param rawConfig - raw plugin config.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return

  const state = createRotationState()
  ctx.on('agent/request-error', (payload, next) => recover(ctx, config, state, payload, next))
  if (config.pools.size > 0) {
    log(ctx, 'info', `key-pool: active for provider pool(s): ${[...config.pools.keys()].sort().join(', ')}`)
  }

  if (config.defaultModel === undefined) return
  if (!config.pools.has(config.defaultModel.provider)) {
    log(
      ctx,
      'warn',
      `key-pool: default model provider "${config.defaultModel.provider}" has no key pool; its quota failures will not rotate keys`,
    )
  }
  ctx.inject(['agentDefaultModel', 'configEditor', 'llm'], (child) => {
    child.effect(() => {
      // Apply after activation: the write reconciles the profile patch and
      // awaits the loader, which must not be re-entered from our own apply().
      const timer = setTimeout(() => {
        void applyDefaultModel(child, config.defaultModel).catch((error) => {
          if (isNestedHmrError(error)) {
            log(
              ctx,
              'info',
              'key-pool: the profile is hot-reloading, so the configured default model will apply on the next start; declare an agent-default-model row to apply it now',
            )
          } else {
            log(ctx, 'warn', `key-pool: could not apply the configured default model: ${messageOf(error)}`)
          }
        })
      }, 0)
      return () => clearTimeout(timer)
    })
  })
}

/**
 * Make the configured selection DSH's default provider/model for new sessions.
 *
 * The selection is validated against a live adapter route and then persisted
 * through `agentDefaultModel.saveSelection()`, the same path the model picker
 * uses. Existing sessions and dsh-superagent role-model selections are not
 * touched. A no-op save is reported rather than treated as an error.
 *
 * @param ctx - context with `agentDefaultModel`, `configEditor`, and optionally `llm`.
 * @param target - validated `{ provider, model, reasoningEffort? }`.
 * @returns an outcome record for diagnostics and tests.
 */
export async function applyDefaultModel(ctx, target) {
  const defaults = ctx.get('agentDefaultModel')
  if (defaults === undefined) {
    log(ctx, 'warn', 'key-pool: defaultModel is configured but the agent-default-model service is unavailable; leaving DSH\'s default unchanged')
    return { applied: false, reason: 'service-unavailable' }
  }
  if (ctx.get('configEditor') === undefined) {
    log(ctx, 'warn', 'key-pool: defaultModel is configured but no configuration editor is mounted; set the agent-default-model row manually')
    return { applied: false, reason: 'editor-unavailable' }
  }

  const current = defaults.currentSelection()
  if (sameSelection(current, target)) return { applied: false, reason: 'unchanged' }

  const llm = ctx.get('llm')
  if (llm !== undefined && typeof llm.resolveCallConfig === 'function') {
    try {
      await llm.resolveCallConfig(target)
    } catch (error) {
      log(
        ctx,
        'warn',
        `key-pool: default model route "${target.provider}/${target.model}" cannot be resolved (${messageOf(error)}); leaving DSH's default unchanged`,
      )
      return { applied: false, reason: 'unresolved' }
    }
  }

  await defaults.saveSelection({ ...target })
  log(
    ctx,
    'info',
    `key-pool: DSH default model for new sessions is now provider "${target.provider}" / model "${target.model}"`,
  )
  return { applied: true }
}

/** Recognize the HMR queue's nested-transaction rejection. */
function isNestedHmrError(error) {
  return error instanceof Error && /HMR transactions cannot be nested/i.test(error.message)
}

/** Compare two agent default selections, treating an absent effort as absent. */
function sameSelection(current, target) {
  if (current === undefined || current === null) return false
  return (
    current.provider === target.provider &&
    current.model === target.model &&
    (current.reasoningEffort ?? undefined) === (target.reasoningEffort ?? undefined)
  )
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