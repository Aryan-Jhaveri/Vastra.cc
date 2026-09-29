import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

// #354 — install.sh writes the .env a self-hosted stack boots with. These
// run it in --dry-run mode and feed the result back through the app's own
// config resolution, so the installer and the code can't drift apart.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function install(args: string[], extraEnv: Record<string, string> = {}): { env: Record<string, string>; file: string; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vastra-install-'))
  dirs.push(dir)
  const file = join(dir, '.env')
  const stdout = execFileSync('bash', [join(root, 'install.sh'), ...args, '--yes', '--dry-run', '--env-file', file], {
    env: { PATH: process.env.PATH, HOME: dir, ...extraEnv },
  }).toString()
  const env: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) env[m[1]] = m[2]
  }
  return { env, file, stdout }
}

describe('install.sh', () => {
  it('--gpu writes a 0600 .env whose model config the app accepts end to end', async () => {
    const { env, file, stdout } = install(['--gpu'])
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(stdout).toContain('Would run: docker compose --profile gpu up -d --build')
    expect(env.MODEL_API_KEY).toMatch(/^[0-9a-f]{64}$/)
    expect(env.HOSTED_MODE).toBeUndefined()
    // Every model server authenticates with the same generated key.
    for (const k of ['OPENAI_COMPAT_API_KEY', 'IMAGE_GEN_API_KEY', 'EMBED_API_KEY', 'DECISIONS_API_KEY']) expect(env[k]).toBe(env.MODEL_API_KEY)

    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
    const { modelServerConfig } = await import('../../src/ai/modelServers.js')
    const { decisionsProviderInfo } = await import('../../src/ai/decisions.js')
    const { isLocalImageGen } = await import('../../src/ai/localImage.js')
    const { detectionModel, freeTextModel } = await import('../../src/ai/localModel.js')
    expect(modelServerConfig('chat').baseUrl).toBe('http://qwen-vl:8001/v1')
    expect(modelServerConfig('image').baseUrl).toBe('http://qwen-image:8091/v1')
    expect(modelServerConfig('embed').baseUrl).toBe('http://qwen-embed:8002/v1')
    expect(decisionsProviderInfo()).toMatchObject({ kind: 'typesafe', provider: 'self' })
    expect(isLocalImageGen()).toBe(true)
    expect(detectionModel()).toBe('local/qwen3-vl-8b')
    expect(freeTextModel()).toBe('local/qwen3-vl-8b')
    // CLM's window in the app matches the compose default for clm-serve.
    expect(env.DECISIONS_MAX_TOKENS).toBe('2048')
  })

  it('the URLs it writes name services and ports that docker-compose.yml defines', () => {
    const { env } = install(['--gpu'])
    const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8')
    for (const url of [env.OPENAI_COMPAT_BASE_URL, env.IMAGE_GEN_BASE_URL, env.EMBED_BASE_URL, env.DECISIONS_URL]) {
      const { hostname, port } = new URL(url)
      expect(compose).toMatch(new RegExp(`\\n  ${hostname}:\\n[\\s\\S]*?--port=${port}`))
    }
    // The GPU shares it writes are the compose defaults.
    for (const [k, v] of Object.entries(env).filter(([k]) => k.endsWith('_GPU_UTIL'))) {
      expect(compose).toContain(`\${${k}:-${v}}`)
    }
  })

  it('--gateway adds the gateway profile and its own key', () => {
    const { env, stdout } = install(['--gpu', '--gateway', 'gpu.example.com'])
    expect(stdout).toContain('--profile gpu --profile gateway')
    expect(env.GATEWAY_DOMAIN).toBe('gpu.example.com')
    expect(env.GATEWAY_API_KEY).toMatch(/^[0-9a-f]{64}$/)
    expect(env.GATEWAY_API_KEY).not.toBe(env.MODEL_API_KEY)
  })

  it('--cpu without a key starts in mock mode; with GEMINI_API_KEY it uses it', () => {
    const { env, stdout } = install(['--cpu'])
    expect(stdout).toContain('Would run: docker compose up -d --build')
    expect(env).toMatchObject({ MOCK_AI_IMAGE_GEN: 'true', MOCK_EMBEDDINGS: 'true' })
    expect(env.OPENAI_COMPAT_BASE_URL).toBeUndefined()
    // No admin password: sign-ups are closed and the admin comes from create-admin (#315).
    expect(env.WEB_AUTH_PASSWORD).toBeUndefined()
    expect(env.ALLOW_SIGNUPS).toBe('false')
    expect(readFileSync(install(['--cpu']).file, 'utf8')).toContain('admin.mjs create-admin you@example.com')
    const withKey = install(['--cpu'], { GEMINI_API_KEY: 'AIza-test' }).env
    expect(withKey).toMatchObject({ GEMINI_API_KEY: 'AIza-test', MOCK_AI_IMAGE_GEN: 'false' })
  })

  it('--mac-ollama points chat + vision at Ollama on the host', () => {
    const { env } = install(['--mac-ollama'])
    expect(env.OPENAI_COMPAT_BASE_URL).toBe('http://host.docker.internal:11434/v1')
    expect(env.VISION_MODEL).toBe('local/qwen3-vl:8b')
  })

  it('keeps an existing .env and refuses --gateway without --gpu', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vastra-install-'))
    dirs.push(dir)
    const file = join(dir, '.env')
    writeFileSync(file, 'WEB_AUTH_PASSWORD=mine\n')
    execFileSync('bash', [join(root, 'install.sh'), '--cpu', '--yes', '--dry-run', '--env-file', file], { env: { PATH: process.env.PATH } })
    expect(readFileSync(file, 'utf8')).toBe('WEB_AUTH_PASSWORD=mine\n')
    const bad = spawnSync('bash', [join(root, 'install.sh'), '--cpu', '--gateway', 'x.example', '--yes', '--dry-run', '--env-file', join(dir, 'y')])
    expect(bad.status).toBe(2)
  })
})
