/**
 * Key-pool rotation primitives.
 *
 * The credential seam is the only place the switch can happen: an LLM adapter
 * resolves its `apiKeyEnv` reference per request, so writing the next pool
 * key's value into that reference takes effect on the very next attempt with
 * no configuration edit and no restart.
 *
 * @module dsh-key-pool/rotation
 */

/** Per-plugin mutable state: one serialization queue per provider, and step budgets. */
export function createRotationState() {
  return {
    queues: new Map(),
    budgets: {
      /** One budget record per live Agent, garbage-collected with it. */
      agents: new WeakMap(),
      /** Budget records for a dispatch without an Agent (tests, defensive callers). */
      anonymous: new Map(),
    },
  }
}

/**
 * Run one rotation task at a time per provider.
 *
 * Concurrent sessions can fail on the same exhausted key at the same moment.
 * Serializing lets the second caller observe the first caller's committed
 * switch instead of advancing past a key that was never tried.
 *
 * @param queues - per-provider promise chains, mutated in place.
 * @param provider - provider route name.
 * @param task - rotation task.
 * @returns the task's result.
 */
export function serializeByProvider(queues, provider, task) {
  const previous = queues.get(provider) ?? Promise.resolve()
  const run = previous.then(task, task)
  // Keep the chain settled either way so one failure cannot poison later runs.
  queues.set(provider, run.then(() => undefined, () => undefined))
  return run
}

/**
 * Return the rotation budget of one failed step, resetting it when the step or
 * provider changes. The loop re-runs the same open turn/step for a retry, so
 * this counts switches within one failed request only.
 *
 * @param budgets - state budget stores, mutated in place.
 * @param agent - payload Agent, used as the lifetime key when present.
 * @param provider - provider route name.
 * @param turn - open turn number.
 * @param step - step number.
 * @returns a mutable `{ count }` record.
 */
export function budgetFor(budgets, agent, provider, turn, step) {
  const keyed = typeof agent === 'object' && agent !== null
  const store = keyed ? budgets.agents : budgets.anonymous
  const key = keyed ? agent : `${String(turn)}:${String(step)}:${provider}`
  let record = store.get(key)
  if (
    record === undefined ||
    record.provider !== provider ||
    record.turn !== turn ||
    record.step !== step
  ) {
    record = { provider, turn, step, count: 0 }
    store.set(key, record)
    if (!keyed && store.size > 1024) {
      // Defensive bound for the fallback store; a real dispatch always has an Agent.
      const oldest = store.keys().next().value
      if (oldest !== undefined) store.delete(oldest)
    }
  }
  return record
}

/**
 * Switch the active credential reference to the next usable key in the pool.
 *
 * Order is the configured pool order, starting after the key currently behind
 * `apiKeyEnv`. Unconfigured pool slots and slots holding the active value are
 * skipped. The active reference's stored value is the rotation position, so
 * the pool resumes from the same key after a restart.
 *
 * The caller must serialize calls per provider and pass the active value it
 * observed before waiting in the queue: if another caller already switched it,
 * this call reports that external switch instead of rotating again.
 *
 * @param credentials - credential seam (`ctx.credentials`).
 * @param pool - normalized pool config.
 * @param activeValueBefore - value resolved for `apiKeyEnv` before entering the queue.
 * @returns `{ rotated: true, index, external }` or `{ rotated: false }`.
 */
export async function rotateToNextKey(credentials, pool, activeValueBefore) {
  const activeNow = await credentials.resolve(pool.apiKeyEnv)
  const activeNowValue = activeNow === undefined ? undefined : activeNow.value
  if (activeNowValue !== activeValueBefore) {
    return { rotated: true, external: true, index: -1 }
  }

  const values = []
  let activeIndex = -1
  for (const [index, keyRef] of pool.keys.entries()) {
    const hit = await credentials.resolve(keyRef)
    const value = hit === undefined ? undefined : hit.value
    values.push(value)
    if (activeValueBefore !== undefined && value === activeValueBefore) activeIndex = index
  }

  const start = activeIndex === -1 ? 0 : activeIndex + 1
  for (let offset = 0; offset < pool.keys.length; offset += 1) {
    const index = (start + offset) % pool.keys.length
    const value = values[index]
    if (value === undefined || value === activeValueBefore) continue
    await credentials.set(pool.apiKeyEnv, value)
    return { rotated: true, external: false, index }
  }

  return { rotated: false }
}