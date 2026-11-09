/**
 * Config parsing for dsh-key-pool.
 *
 * Configuration stays secret-free: every key is named by a credential
 * reference (an environment-variable-shaped name resolved through
 * `ctx.credentials`), never by its value. Validation is dependency-free and
 * runs when the plugin activates, so a typo fails the profile loudly instead
 * of silently disabling rotation.
 *
 * @module dsh-key-pool/config
 */

/** Failure codes rotated through the pool when a pool does not override them. */
export const DEFAULT_ROTATE_ON_CODES = Object.freeze([
  'QUOTA',
  'RATE_LIMIT',
  'AUTH',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
])

/** Default pause before the request is retried with the switched key. */
export const DEFAULT_RETRY_DELAY_MS = 500

/** Upper bound accepted for a configured pause; longer explicit provider delays are capped too. */
export const MAX_RETRY_DELAY_MS = 300_000

const CONFIG_KEYS = new Set(['enabled', 'defaultModel', 'pools', 'rotateOnCodes', 'retryDelayMs'])
const DEFAULT_MODEL_KEYS = new Set(['provider', 'model', 'reasoningEffort'])
const POOL_KEYS = new Set([
  'apiKeyEnv',
  'keys',
  'rotateOnCodes',
  'maxRotationsPerStep',
  'retryDelayMs',
])
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Reject one malformed config fact with a path-prefixed message. */
function fail(message) {
  throw new TypeError(`key-pool: ${message}`)
}

/** Whether a value is a plain mapping (not an array, not null). */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate one credential reference (the environment-variable-shaped credential grammar). */
function readCredentialRef(value, path) {
  if (typeof value !== 'string' || !CREDENTIAL_REF.test(value)) {
    fail(
      `${path} must be an environment-variable-shaped credential reference ` +
        `(for example MN_SHARED1_API_KEY), got ${JSON.stringify(value)}`,
    )
  }
  return value
}

/** Validate a non-empty failure-code list, preserving order and removing duplicates. */
function readCodeList(value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${path} must be a non-empty array of failure codes`)
  }
  const codes = []
  for (const [index, code] of value.entries()) {
    if (typeof code !== 'string' || code.length === 0) {
      fail(`${path}[${index}] must be a non-empty failure code string`)
    }
    if (!codes.includes(code)) codes.push(code)
  }
  return codes
}

/** Validate one non-empty string setting. */
function readNonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${path} must be a non-empty string`)
  }
  return value
}

/** Validate the optional default provider/model selection applied to new sessions. */
function readDefaultModel(raw) {
  if (!isMapping(raw)) fail('defaultModel must be a mapping')
  for (const key of Object.keys(raw)) {
    if (!DEFAULT_MODEL_KEYS.has(key)) fail(`defaultModel has unknown key "${key}"`)
  }
  const provider = readNonEmptyString(raw.provider, 'defaultModel.provider')
  const model = readNonEmptyString(raw.model, 'defaultModel.model')
  const reasoningEffort =
    raw.reasoningEffort === undefined
      ? undefined
      : readNonEmptyString(raw.reasoningEffort, 'defaultModel.reasoningEffort')
  return Object.freeze({
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  })
}

/** Validate one integer setting. */
function readInteger(value, path, { minimum, maximum, fallback }) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${path} must be an integer between ${minimum} and ${maximum}, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Validate one pool definition and freeze it into the runtime shape. */
function readPool(provider, raw, defaults) {
  const path = `pools.${provider}`
  if (!isMapping(raw)) fail(`${path} must be a mapping`)
  for (const key of Object.keys(raw)) {
    if (!POOL_KEYS.has(key)) fail(`${path} has unknown key "${key}"`)
  }

  const apiKeyEnv = readCredentialRef(raw.apiKeyEnv, `${path}.apiKeyEnv`)

  if (!Array.isArray(raw.keys) || raw.keys.length === 0) {
    fail(`${path}.keys must be a non-empty array of credential references`)
  }
  const keys = raw.keys.map((value, index) => readCredentialRef(value, `${path}.keys[${index}]`))
  for (let index = 0; index < keys.length; index += 1) {
    if (keys.indexOf(keys[index]) !== index) {
      fail(`${path}.keys lists "${keys[index]}" more than once`)
    }
  }

  const codes =
    raw.rotateOnCodes === undefined
      ? defaults.rotateOnCodes
      : readCodeList(raw.rotateOnCodes, `${path}.rotateOnCodes`)

  const maxRotationsPerStep = readInteger(raw.maxRotationsPerStep, `${path}.maxRotationsPerStep`, {
    minimum: 1,
    maximum: 1000,
    // Try every key except the active one at most once per failed step.
    fallback: Math.max(1, keys.length - 1),
  })

  const retryDelayMs = readInteger(raw.retryDelayMs, `${path}.retryDelayMs`, {
    minimum: 0,
    maximum: MAX_RETRY_DELAY_MS,
    fallback: defaults.retryDelayMs,
  })

  return Object.freeze({
    provider,
    apiKeyEnv,
    keys: Object.freeze(keys),
    rotateOnCodes: new Set(codes),
    maxRotationsPerStep,
    retryDelayMs,
  })
}

/**
 * Validate a raw plugin config and fill in defaults.
 *
 * An absent config is valid and dormant. Unknown keys are rejected so a typo
 * cannot silently disable rotation.
 *
 * @param raw - raw Cordis plugin config.
 * @returns normalized runtime config.
 * @throws {TypeError} when the config is malformed.
 */
export function normalizeConfig(raw) {
  const value = raw ?? {}
  if (!isMapping(value)) fail('config must be a mapping')
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) fail(`unknown config key "${key}"`)
  }

  const enabled = value.enabled === undefined ? true : value.enabled
  if (typeof enabled !== 'boolean') fail('enabled must be a boolean')

  const defaultModel = value.defaultModel === undefined ? undefined : readDefaultModel(value.defaultModel)

  const rotateOnCodes =
    value.rotateOnCodes === undefined
      ? [...DEFAULT_ROTATE_ON_CODES]
      : readCodeList(value.rotateOnCodes, 'rotateOnCodes')

  const retryDelayMs = readInteger(value.retryDelayMs, 'retryDelayMs', {
    minimum: 0,
    maximum: MAX_RETRY_DELAY_MS,
    fallback: DEFAULT_RETRY_DELAY_MS,
  })

  const rawPools = value.pools ?? {}
  if (!isMapping(rawPools)) fail('pools must be a mapping of provider route name to pool config')

  const defaults = { rotateOnCodes, retryDelayMs }
  const pools = new Map()
  for (const [provider, pool] of Object.entries(rawPools)) {
    if (provider.length === 0) fail('pool provider route names must be non-empty')
    pools.set(provider, readPool(provider, pool, defaults))
  }

  return Object.freeze({
    enabled,
    defaultModel,
    rotateOnCodes: new Set(rotateOnCodes),
    retryDelayMs,
    pools,
  })
}