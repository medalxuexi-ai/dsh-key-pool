#!/usr/bin/env node
/**
 * End-to-end proof that dsh-key-pool switches keys inside a real DSH runtime.
 *
 * The script builds a throwaway DSH home and SDK profile (no network, no
 * installer), points a hand-declared OpenAI-compatible provider at a local mock
 * server, and drives one prompt through the SDK JSON-RPC surface:
 *
 *   1. the mock server rejects the first request with an insufficient-quota
 *      error while the active credential reference holds key #1;
 *   2. dsh-key-pool commits key #2 into that reference and asks the agent loop
 *      to retry the same step;
 *   3. the retried request reaches the mock server with key #2 and succeeds.
 *
 * Run from the package directory:
 *
 *   node test/e2e/sdk-e2e.mjs
 *   DSH_BIN=/path/to/dsh node test/e2e/sdk-e2e.mjs --keep
 *
 * Requires a working `dsh` binary (>= 0.2.1) on PATH or in DSH_BIN.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const DSH_BIN = process.env.DSH_BIN ?? 'dsh'
const PROFILE = 'kp-e2e'
const SESSION_ID = 'kp-e2e-session'
const PROVIDER = 'mock'
const MODEL = 'test-model'
const ACTIVE_REF = 'POOL_ACTIVE'
const KEY_REFS = ['POOL_KEY_1', 'POOL_KEY_2']
const KEY_1 = 'sk-key-one'
const KEY_2 = 'sk-key-two'
const keep = process.argv.includes('--keep')

const root = await mkdtemp(join(tmpdir(), 'dsh-key-pool-e2e-'))
const home = join(root, 'home')
const workspace = join(root, 'workspace')
const profileDir = join(home, 'profiles', PROFILE)
const mockRequests = []
let mockServer
let child
let stderr = ''

class Deadline extends Error {}

function log(message) {
  process.stderr.write(`[e2e] ${message}\n`)
}

async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const proc = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderrText = ''
    proc.stdout.on('data', (chunk) => (stdout += chunk))
    proc.stderr.on('data', (chunk) => (stderrText += chunk))
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr: stderrText })
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stderrText}`))
    })
  })
}

function startMockServer() {
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    const authorization = request.headers.authorization ?? ''
    const key = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''

    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: MODEL }] }))
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }

    mockRequests.push({ key, body })
    if (key === KEY_1) {
      response.writeHead(402, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: {
            message:
              'You exceeded your current quota, please check your plan and billing details.',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        }),
      )
      return
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`
    response.write(
      frame({
        id: 'chatcmpl-e2e',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: MODEL,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: null }],
      }),
    )
    response.write(
      frame({
        id: 'chatcmpl-e2e',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      }),
    )
    response.end('data: [DONE]\n\n')
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

/** Minimal newline-delimited JSON-RPC client over the SDK runtime's stdio. */
function startRuntime(env) {
  const proc = spawn(DSH_BIN, ['--profile', PROFILE], {
    cwd: workspace,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const frames = []
  let nextId = 1
  let buffer = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line === '') continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        log(`ignoring non-JSON stdout line: ${line.slice(0, 200)}`)
        continue
      }
      frames.push(frame)
      if (frame.id !== undefined && pending.has(frame.id)) {
        const { resolve, reject, timer } = pending.get(frame.id)
        pending.delete(frame.id)
        clearTimeout(timer)
        if (frame.error !== undefined) reject(new Error(JSON.stringify(frame.error)))
        else resolve(frame.result)
      }
    }
  })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  proc.on('exit', (code, signal) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(new Error(`dsh exited early (code ${code}, signal ${signal})\n${stderr}`))
    }
    pending.clear()
  })

  function request(method, params, timeoutMs = 90_000) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Deadline(`${method} timed out after ${timeoutMs}ms\n${stderr}`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  return { proc, request, frames }
}

function cleanEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DSH_')) continue
    env[key] = value
  }
  env.DSH_HOME = home
  env.NO_COLOR = '1'
  return env
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForExit(proc, timeoutMs = 15_000) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  await Promise.race([
    new Promise((resolve) => proc.once('exit', resolve)),
    delay(timeoutMs).then(() => {
      proc.kill('SIGKILL')
    }),
  ])
}

try {
  await mkdir(workspace, { recursive: true })
  await mkdir(home, { recursive: true })

  log(`preparing profile under ${home}`)
  await run(DSH_BIN, ['--profile', PROFILE, '--from-default-profile', 'sdk', '--help'], {
    cwd: workspace,
    env: cleanEnv(),
  })

  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const bundles = manifest.dsh.profile.bundles
  if (!bundles.includes('dsh-key-pool')) bundles.push('dsh-key-pool')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  await mkdir(join(profileDir, 'node_modules'), { recursive: true })
  await symlink(PACKAGE_DIR, join(profileDir, 'node_modules', 'dsh-key-pool'), 'dir')

  mockServer = await startMockServer()
  const port = mockServer.address().port

  const credentialsPath = join(home, '.credentials.yaml')
  await writeFile(
    credentialsPath,
    [
      'version: 1',
      'refs:',
      `  ${ACTIVE_REF}: ${KEY_1}`,
      `  ${KEY_REFS[0]}: ${KEY_1}`,
      `  ${KEY_REFS[1]}: ${KEY_2}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
  await chmod(credentialsPath, 0o600)

  await writeFile(
    join(profileDir, 'cordis.patch.yml'),
    [
      `- id: llm-pi-ai`,
      `  config:`,
      `    providers:`,
      `      ${PROVIDER}:`,
      `        apiKeyEnv: ${ACTIVE_REF}`,
      `        api: openai-completions`,
      `        baseURL: http://127.0.0.1:${port}/v1`,
      `        models:`,
      `          - id: ${MODEL}`,
      `            contextWindow: 128000`,
      `            maxTokens: 4096`,
      `- id: key-pool`,
      `  config:`,
      `    pools:`,
      `      ${PROVIDER}:`,
      `        apiKeyEnv: ${ACTIVE_REF}`,
      `        keys: [${KEY_REFS.join(', ')}]`,
      `        retryDelayMs: 0`,
      '',
    ].join('\n'),
  )

  const runtime = startRuntime(cleanEnv())
  child = runtime.proc

  log('initializing the SDK runtime')
  await runtime.request('initialize', {
    cwd: workspace,
    provider: PROVIDER,
    model: MODEL,
  })

  log('sending a prompt; the provider should fail on key #1 and succeed on key #2')
  await runtime.request('session/prompt', {
    sessionId: SESSION_ID,
    contentBlocks: [{ type: 'text', text: 'Reply with pong.' }],
  })
  await runtime.request('session/wait', { sessionId: SESSION_ID }, 120_000)

  await runtime.request('shutdown', {}).catch(() => undefined)
  await waitForExit(child)

  assert.ok(mockRequests.length >= 2, `expected at least two provider requests, got ${mockRequests.length}`)
  assert.equal(mockRequests[0].key, KEY_1, 'the first attempt should use the active key')
  assert.equal(mockRequests[1].key, KEY_2, 'the retried attempt should use the next pool key')
  assert.ok(
    mockRequests.slice(2).every((entry) => entry.key === KEY_2),
    'later attempts must keep using the switched key',
  )

  const credentials = await readFile(credentialsPath, 'utf8')
  assert.match(credentials, new RegExp(`^\\s*${ACTIVE_REF}:\\s*${KEY_2}\\s*$`, 'm'))

  const assistantText = runtime.frames
    .filter((frame) => frame.method === 'session.event')
    .map((frame) => frame.params?.event)
    .filter((event) => event !== undefined && event.type === 'assistant/message')
    .length
  assert.ok(assistantText >= 1, 'the retried request should produce an assistant message')

  log('PASS: quota failure switched POOL_ACTIVE from key #1 to key #2 and the retry succeeded')
  log(`provider requests: ${mockRequests.map((entry) => entry.key).join(' -> ')}`)
} catch (error) {
  process.stderr.write(`\n[e2e] FAILED: ${error instanceof Error ? error.stack : String(error)}\n`)
  if (stderr !== '') process.stderr.write(`\n[e2e] dsh stderr:\n${stderr.slice(-8000)}\n`)
  process.exitCode = 1
} finally {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
  }
  if (mockServer !== undefined) await new Promise((resolve) => mockServer.close(resolve))
  if (keep) log(`kept ${root}`)
  else await rm(root, { recursive: true, force: true })
}