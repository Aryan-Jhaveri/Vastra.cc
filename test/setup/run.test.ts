import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkGeminiKey, checkOpenRouter, checkResendKey, checkVertexCredentials } from '../../src/setup/apiChecks.js'
import { runSetup, type SetupIO } from '../../src/setup/run.js'
import { parseEnvFile } from '../../src/setup/envFile.js'
import type { CheckResult } from '../../src/ai/connectionChecks.js'

// #315 Phase 2 — the `make setup` flow driven by scripted answers. No network:
// fetch and the model-server checks are injected.

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vastra-setup-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** Answers in prompt order; `choose` takes the option value. */
function scripted(answers: Array<string | boolean>) {
  const queue = [...answers]
  const printed: string[] = []
  const asked: string[] = []
  const next = (q: string) => {
    asked.push(q)
    if (!queue.length) throw new Error(`no scripted answer for: ${q}`)
    return queue.shift()!
  }
  const io: SetupIO = {
    choose: async (q, options, fallback) => {
      const a = next(q)
      if (a === '') return fallback
      if (!options.some(o => o.value === a)) throw new Error(`"${a}" is not an option for: ${q}`)
      return a as never
    },
    ask: async (q, fallback) => { const a = String(next(q)); return a || fallback || '' },
    secret: async q => String(next(q)),
    confirm: async (q, fallback) => { const a = next(q); return a === '' ? fallback : a === true },
    print: line => { printed.push(line ?? '') },
  }
  return { io, printed, asked, remaining: queue }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const okCheck = (): Promise<CheckResult> => Promise.resolve({ status: 200, body: { ok: true, checks: { chat: { ok: true }, vision: { ok: true } } } })

describe('make setup flow', () => {
  it('Docker + Ollama on the Mac: checks the server via localhost, then writes a 0600 .env', async () => {
    const seen: Record<string, string | undefined> = {}
    const checkLocal = vi.fn(async () => {
      seen.url = process.env.OPENAI_COMPAT_BASE_URL
      seen.hosted = process.env.HOSTED_MODE
      return okCheck()
    })
    const before = process.env.OPENAI_COMPAT_BASE_URL
    const { io, remaining } = scripted([
      'docker', 'me', '', 'none', 'local', '', '', 'qwen3-vl:8b', 'llm', false, true, 'me@example.test',
    ])
    const envPath = join(dir, '.env')

    const result = await runSetup(io, { envPath }, {
      checkLocal, checkDecisions: okCheck, generateVapid: () => ({ publicKey: 'PUB', privateKey: 'PRIV' }),
      now: () => new Date('2026-09-28T12:00:00Z'),
    })

    expect(remaining).toEqual([])
    expect(result?.written).toBe(envPath)
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
    const env = Object.fromEntries(parseEnvFile(readFileSync(envPath, 'utf8')))
    expect(env).toMatchObject({
      OPENAI_COMPAT_BASE_URL: 'http://host.docker.internal:11434/v1', TEXT_MODEL: 'local/qwen3-vl:8b',
      ALLOW_SIGNUPS: 'false', VAPID_PUBLIC_KEY: 'PUB', VAPID_EMAIL: 'mailto:me@example.test',
    })
    // The check ran on the host, so host.docker.internal became localhost, and never as hosted.
    expect(seen).toEqual({ url: 'http://localhost:11434/v1', hosted: undefined })
    // The caller's env is untouched afterwards.
    expect(process.env.OPENAI_COMPAT_BASE_URL).toBe(before)
  })

  it('inside the container (install.sh), host.docker.internal is checked as-is', async () => {
    let seen: string | undefined
    const checkLocal = vi.fn(async () => { seen = process.env.OPENAI_COMPAT_BASE_URL; return okCheck() })
    const { io } = scripted(['docker', 'me', '', 'none', 'local', '', '', 'qwen3-vl:8b', 'none', false, false])
    await runSetup(io, { envPath: join(dir, '.env'), inContainer: true }, { checkLocal })
    expect(seen).toBe('http://host.docker.internal:11434/v1')
  })

  it('an existing file is backed up (0600) and its unmanaged keys are kept', async () => {
    const envPath = join(dir, '.env')
    writeFileSync(envPath, 'QWEN_IMAGE_GPU_UTIL=0.40\nGEMINI_API_KEY=old\n', { mode: 0o644 })
    const fetchFn = vi.fn(async () => json(200, { models: [] }))
    const { io } = scripted(['node', 'me', '', 'gemini', 'AIza-new', 'google', false, 'none', false, false])

    const result = await runSetup(io, { envPath }, { fetch: fetchFn as unknown as typeof fetch, now: () => new Date('2026-09-28T12:00:00Z') })

    expect(result?.backup).toBeDefined()
    expect(readFileSync(result!.backup!, 'utf8')).toBe('QWEN_IMAGE_GPU_UTIL=0.40\nGEMINI_API_KEY=old\n')
    expect(statSync(result!.backup!).mode & 0o777).toBe(0o600)
    const env = parseEnvFile(readFileSync(envPath, 'utf8'))
    expect(env.get('GEMINI_API_KEY')).toBe('AIza-new')
    expect(env.get('QWEN_IMAGE_GPU_UTIL')).toBe('0.40')
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
    // The key went in a header, never the URL.
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).not.toContain('AIza-new')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-new')
  })

  it('a failed check can be declined: nothing is written', async () => {
    const envPath = join(dir, '.env')
    const fetchFn = vi.fn(async () => json(400, { error: { message: 'API key not valid' } }))
    const { io, printed } = scripted(['node', 'me', '', 'gemini', 'bad-key', 'google', false, 'none', false, false, false])

    const result = await runSetup(io, { envPath }, { fetch: fetchFn as unknown as typeof fetch })

    expect(existsSync(envPath)).toBe(false)
    expect(result?.written).toBeUndefined()
    expect(printed.join('\n')).toContain('✗ Gemini API key: HTTP 400: API key not valid')
    expect(printed.join('\n')).toContain('Nothing written.')
  })

  it('Render prints a paste block and writes no file', async () => {
    const { io, printed } = scripted(['me', 'https://me.onrender.com', 'none', 'none', 'none', false, false])
    const result = await runSetup(io, { envPath: join(dir, '.env'), target: 'render' })
    expect(readdirSync(dir)).toEqual([])
    expect(result?.pasted).toContain('WEB_APP_URL=https://me.onrender.com')
    expect(printed.join('\n')).toContain('Paste these into Render')
    expect(printed.join('\n')).toContain('Render Shell: node src/transport/web/admin/admin.mjs create-admin')
  })

  it('stops before any check when the answers are unusable', async () => {
    const checkLocal = vi.fn(okCheck)
    const { io, printed } = scripted(['node', 'me', 'not a url', 'none', 'none', 'none', false, false])
    const result = await runSetup(io, { envPath: join(dir, '.env') }, { checkLocal })
    expect(result).toBeNull()
    expect(printed.join('\n')).toContain('App URL is not a valid URL')
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('API checks', () => {
  it('OpenRouter: a bad key is reported with the key redacted', async () => {
    const f = vi.fn(async () => json(401, { error: { message: 'Invalid key sk-or-secret' } }))
    const r = await checkOpenRouter('sk-or-secret', undefined, f as unknown as typeof fetch)
    expect(r).toEqual({ name: 'OpenRouter key', ok: false, detail: 'HTTP 401: Invalid key [redacted]' })
  })

  it('OpenRouter: a working key with a model id that does not exist fails', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json(200, { data: {} }))
      .mockResolvedValueOnce(json(200, { data: [{ id: 'mistralai/mistral-small-3.2-24b-instruct' }] }))
    const r = await checkOpenRouter('k', 'vendor/nope', f as unknown as typeof fetch)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('no model "vendor/nope"')
  })

  it('Gemini: a network error never leaks the key', async () => {
    const f = vi.fn(async () => { throw new Error('connect ECONNREFUSED for AIza-leak') })
    const r = await checkGeminiKey('AIza-leak', f as unknown as typeof fetch)
    expect(r.ok).toBe(false)
    expect(r.detail).not.toContain('AIza-leak')
  })

  it('Resend: a sending-only key counts as valid', async () => {
    const f = vi.fn(async () => json(401, { name: 'restricted_api_key', message: 'This API key is restricted to only send emails' }))
    expect(await checkResendKey('re_x', f as unknown as typeof fetch)).toMatchObject({ ok: true, detail: 'sending-only key' })
  })

  it('Vertex: checks the service-account file without the network', () => {
    const good = join(dir, 'sa.json')
    writeFileSync(good, JSON.stringify({ type: 'service_account', client_email: 'a@b.iam', private_key: 'x', project_id: 'p1' }))
    expect(checkVertexCredentials(good, 'p1')).toEqual({ name: 'Vertex service account', ok: true })
    expect(checkVertexCredentials(good, 'p2').detail).toContain('key is from project p1')
    expect(checkVertexCredentials(join(dir, 'missing.json'), 'p1')).toMatchObject({ ok: false, detail: expect.stringContaining('no file') })
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, JSON.stringify({ type: 'authorized_user' }))
    expect(checkVertexCredentials(bad, 'p1').ok).toBe(false)
  })
})
