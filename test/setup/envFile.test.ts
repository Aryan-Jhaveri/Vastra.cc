import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildEnv, parseEnvFile, renderEnvFile, renderPasteBlock, validateAnswers, type SetupAnswers,
} from '../../src/setup/envFile.js'

// #315 Phase 2 — `make setup` output. The generated file is fed back through
// the app's own config resolution, so setup and the code can't drift apart
// (the same idea as test/deploy/install.test.ts).

const base: SetupAnswers = {
  target: 'node', household: false, appUrl: 'http://localhost:3000',
  google: 'gemini', geminiKey: 'AIza-test-key', chat: 'google', imageGen: false, decisions: 'none',
}

function envOf(a: SetupAnswers): Record<string, string> {
  return Object.fromEntries(parseEnvFile(renderEnvFile(buildEnv(a))))
}

/** Replace the env the app reads with exactly this file (HOSTED_MODE and the test keys cleared). */
function applyOnly(env: Record<string, string>) {
  for (const k of ['HOSTED_MODE', 'GEMINI_API_KEY', 'GCP_PROJECT_ID', 'OPENROUTER_API_KEY', 'OPENAI_COMPAT_BASE_URL',
    'TEXT_MODEL', 'VISION_MODEL', 'AGENT_MODEL', 'DECISIONS_PROVIDER', 'DECISIONS_URL', 'DECISIONS_MODEL',
    'ALLOW_SIGNUPS', 'MOCK_EMBEDDINGS', 'MOCK_AI_IMAGE_GEN', 'CHAT_ENABLED']) vi.stubEnv(k, undefined as unknown as string)
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
}

afterEach(() => { vi.unstubAllEnvs() })

describe('buildEnv → the app accepts it', () => {
  it('Gemini key, just me: chat on, sign-ups closed, text embeddings real, images mocked', async () => {
    const env = envOf(base)
    expect(env).toMatchObject({
      GEMINI_API_KEY: 'AIza-test-key', ALLOW_SIGNUPS: 'false', VISION_MODEL: 'gemini-2.5-flash', TEXT_MODEL: 'gemini-2.5-flash',
      MOCK_AI_IMAGE_GEN: 'true', MOCK_EMBEDDINGS: 'false', TEXT_EMBED_ENABLED: 'true', IMAGE_EMBED_ENABLED: 'false', DECISIONS_PROVIDER: 'none',
    })
    expect(env.HOSTED_MODE).toBeUndefined()
    applyOnly(env)
    const { isChatEnabled } = await import('../../src/agent/chatEnabled.js')
    const { signupsOpen } = await import('../../src/auth/signups.js')
    const { decisionsProviderInfo } = await import('../../src/ai/decisions.js')
    expect(isChatEnabled()).toBe(true)
    expect(signupsOpen()).toBe(false)
    expect(decisionsProviderInfo()).toBeNull()
  })

  it('a local OpenAI-compatible server (Ollama in Docker): local/ ids everywhere, LLM decisions on it', async () => {
    const env = envOf({
      ...base, target: 'docker', household: true, google: 'none', geminiKey: undefined,
      chat: 'local', localUrl: 'http://host.docker.internal:11434/v1/', chatModel: 'qwen3-vl:8b', decisions: 'llm',
    })
    expect(env).toMatchObject({
      OPENAI_COMPAT_BASE_URL: 'http://host.docker.internal:11434/v1', VISION_MODEL: 'local/qwen3-vl:8b',
      TEXT_MODEL: 'local/qwen3-vl:8b', AGENT_MODEL: 'local/qwen3-vl:8b', ALLOW_SIGNUPS: 'true',
      MOCK_EMBEDDINGS: 'true', DECISIONS_PROVIDER: 'llm', DECISIONS_MODEL: 'local/qwen3-vl:8b',
    })
    expect(env.OPENAI_COMPAT_API_KEY).toBeUndefined()
    applyOnly(env)
    const { modelServerConfig } = await import('../../src/ai/modelServers.js')
    const { freeTextModel, detectionModel } = await import('../../src/ai/localModel.js')
    const { isChatEnabled } = await import('../../src/agent/chatEnabled.js')
    const { decisionsProviderInfo } = await import('../../src/ai/decisions.js')
    const { signupsOpen } = await import('../../src/auth/signups.js')
    expect(modelServerConfig('chat').baseUrl).toBe('http://host.docker.internal:11434/v1')
    expect(freeTextModel()).toBe('local/qwen3-vl:8b')
    expect(detectionModel()).toBe('local/qwen3-vl:8b')
    expect(isChatEnabled()).toBe(true)
    expect(decisionsProviderInfo()).toMatchObject({ kind: 'llm', model: 'local/qwen3-vl:8b' })
    expect(signupsOpen()).toBe(true)
  })

  it('OpenRouter chat keeps vision on Google and enables Jev', async () => {
    const env = envOf({ ...base, chat: 'openrouter', openrouterKey: 'sk-or-test', chatModel: 'mistralai/mistral-small-3.2-24b-instruct', decisions: 'jev' })
    expect(env).toMatchObject({
      OPENROUTER_API_KEY: 'sk-or-test', VISION_MODEL: 'gemini-2.5-flash',
      TEXT_MODEL: 'mistralai/mistral-small-3.2-24b-instruct', DECISIONS_PROVIDER: 'openrouter',
    })
    applyOnly(env)
    const { decisionsProviderInfo } = await import('../../src/ai/decisions.js')
    expect(decisionsProviderInfo()).toMatchObject({ kind: 'openrouter' })
  })

  it('Vertex turns on image embeddings and real images; a TypeSafe server is wired with its key', async () => {
    const env = envOf({
      ...base, google: 'vertex', geminiKey: undefined, gcpProject: 'my-proj', gcpCredentials: '/data/sa.json',
      imageGen: true, decisions: 'typesafe', decisionsUrl: 'http://clm:8700/v1/systemone', decisionsKey: 'k1',
    })
    expect(env).toMatchObject({
      GCP_PROJECT_ID: 'my-proj', GCP_LOCATION: 'us-central1', GCP_IMAGE_GEN_LOCATION: 'global',
      GOOGLE_APPLICATION_CREDENTIALS: '/data/sa.json', MOCK_AI_IMAGE_GEN: 'false', IMAGE_EMBED_ENABLED: 'true',
      DECISIONS_PROVIDER: 'typesafe', DECISIONS_URL: 'http://clm:8700/v1/systemone', DECISIONS_API_KEY: 'k1',
    })
    applyOnly(env)
    const { decisionsProviderInfo } = await import('../../src/ai/decisions.js')
    expect(decisionsProviderInfo()).toMatchObject({ kind: 'typesafe', provider: 'self' })
  })

  it('email and push sections only when chosen', () => {
    expect(envOf(base).RESEND_API_KEY).toBeUndefined()
    const env = envOf({ ...base, resendKey: 're_x', mailFrom: 'hi@me.test', vapid: { publicKey: 'PUB', privateKey: 'PRIV', subject: 'mailto:a@b.test' } })
    expect(env).toMatchObject({ RESEND_API_KEY: 're_x', RESEND_FROM_NOREPLY: 'hi@me.test', VAPID_PUBLIC_KEY: 'PUB', VAPID_PRIVATE_KEY: 'PRIV', VAPID_EMAIL: 'mailto:a@b.test' })
  })
})

describe('validateAnswers', () => {
  it.each<[string, Partial<SetupAnswers>, RegExp]>([
    ['bad URL', { appUrl: 'not a url' }, /App URL/],
    ['gemini without key', { geminiKey: undefined }, /Gemini needs an API key/],
    ['google chat with no google', { google: 'none', geminiKey: undefined }, /Chat through Google/],
    ['openrouter without a vendor/model id', { chat: 'openrouter', openrouterKey: 'k', chatModel: 'gpt' }, /vendor\/model/],
    ['local without URL', { chat: 'local', chatModel: 'x' }, /http\(s\) base URL/],
    ['images with no google', { google: 'none', geminiKey: undefined, chat: 'none', imageGen: true }, /Image generation/],
    ['jev without OpenRouter', { decisions: 'jev' }, /Jev decisions/],
    ['email without from', { resendKey: 're_x' }, /from address/],
  ])('%s', (_name, patch, problem) => {
    expect(validateAnswers({ ...base, ...patch }).join('\n')).toMatch(problem)
  })

  it('a complete answer set has no problems', () => {
    expect(validateAnswers(base)).toEqual([])
  })
})

describe('renderEnvFile', () => {
  it('keeps settings setup does not manage, drops the ones it rewrites, and quotes when needed', () => {
    const previous = 'GEMINI_API_KEY=old\nQWEN_IMAGE_GPU_UTIL=0.40\n# comment\nWEB_AUTH_PASSWORD="a b"\n'
    const text = renderEnvFile(buildEnv({ ...base, appUrl: 'http://localhost:3000/' }), { previous, now: new Date('2026-09-28T12:00:00Z') })
    const env = parseEnvFile(text)
    expect(env.get('GEMINI_API_KEY')).toBe('AIza-test-key')
    expect(env.get('QWEN_IMAGE_GPU_UTIL')).toBe('0.40')
    expect(env.get('WEB_AUTH_PASSWORD')).toBe('a b')
    expect(env.get('WEB_APP_URL')).toBe('http://localhost:3000')
    expect(text).toContain('WEB_AUTH_PASSWORD="a b"')
    expect(text.match(/^GEMINI_API_KEY=/gm)).toHaveLength(1)
    expect(text).toContain('# Written by `make setup` on 2026-09-28T12:00:00Z')
    expect(text).toContain('make create-admin EMAIL=you@example.com')
  })

  it('the Docker file tells you the in-container create-admin command', () => {
    expect(renderEnvFile(buildEnv({ ...base, target: 'docker' }))).toContain('docker compose exec closet node src/transport/web/admin/admin.mjs create-admin')
  })

  it('the Render paste block is bare KEY=value lines', () => {
    const block = renderPasteBlock(buildEnv({ ...base, target: 'render', appUrl: 'https://me.onrender.com' }))
    expect(block.split('\n').filter(Boolean).every(l => /^[A-Z0-9_]+=/.test(l))).toBe(true)
    expect(block).toContain('NODE_ENV=production')
    expect(block).toContain('WEB_APP_URL=https://me.onrender.com')
  })
})
