#!/usr/bin/env tsx
/**
 * Dev launcher — one command to rule them all:
 *
 *   1. Start cloudflared quick tunnel → Vite dev server (:5173)
 *   2. Extract the tunnel URL and patch WEB_APP_URL in .env
 *   3. Start Express + Vite dev server  (npm run web:dev)
 *   4. Start Telegram bot              (npm run telegram)
 *
 * Usage:
 *   npm run dev
 *
 * Prerequisites:
 *   cloudflared installed → brew install cloudflare/cloudflare/cloudflared
 *
 * The tunnel points to Vite (:5173) rather than Express (:3000) because:
 *   - Vite serves the React app with HMR in dev
 *   - vite.config.ts allowedHosts includes .trycloudflare.com (accepts tunnel domains)
 *   - Vite proxies /api/* and /images/* back to Express at :3000
 */
import { spawn, execSync, type ChildProcess } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const ENV_FILE = resolve(ROOT, '.env')

// Tunnel targets the Vite dev server. Override with TUNNEL_PORT env var.
const TUNNEL_PORT = parseInt(process.env.TUNNEL_PORT ?? '5173', 10)
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

// ── helpers ──────────────────────────────────────────────────────────────────

function patchDotEnv(key: string, value: string) {
  let content = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
  const re = new RegExp(`^${key}=.*$`, 'm')
  content = re.test(content)
    ? content.replace(re, `${key}=${value}`)
    : `${content.trimEnd()}\n${key}=${value}\n`
  writeFileSync(ENV_FILE, content, 'utf8')
}

const procs: ChildProcess[] = []

function cleanup() {
  for (const p of procs) {
    try { p.kill('SIGTERM') } catch {}
  }
  // npm → concurrently → tsx/vite: grandchildren can outlive the npm parent and
  // keep holding ports.  Kill anything on 3000 or 5173 directly.
  try {
    execSync('lsof -ti :3000 :5173 | xargs kill 2>/dev/null || true', { shell: true })
  } catch { /* ignore */ }
}

process.on('SIGINT', () => { cleanup(); process.exit(0) })
process.on('SIGTERM', () => { cleanup(); process.exit(0) })

// ── cloudflared ───────────────────────────────────────────────────────────────

function waitForTunnelUrl(): Promise<string> {
  return new Promise((resolve, reject) => {
    let resolved = false

    const cf = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${TUNNEL_PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    procs.push(cf)

    const onData = (chunk: Buffer) => {
      const text = chunk.toString()
      for (const line of text.split('\n')) {
        if (line.trim()) process.stdout.write(`[cloudflared] ${line.trim()}\n`)
      }
      if (resolved) return
      const match = text.match(TUNNEL_URL_RE)
      if (match) {
        resolved = true
        resolve(match[0])
      }
    }

    cf.stdout.on('data', onData)
    cf.stderr.on('data', onData)

    cf.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new Error(
          'cloudflared not found.\n  Install it: brew install cloudflare/cloudflare/cloudflared',
        ))
      } else {
        reject(err)
      }
    })

    cf.on('exit', (code) => {
      if (!resolved) reject(new Error(`cloudflared exited early (code ${code})`))
    })
  })
}

// ── service spawner ───────────────────────────────────────────────────────────

function spawnNpmScript(label: string, script: string) {
  const child = spawn('npm', ['run', script], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
  })
  procs.push(child)
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[${label}] exited with code ${code}`)
    }
  })
  return child
}

// ── main ──────────────────────────────────────────────────────────────────────

console.log(`\n[dev] Starting cloudflared quick tunnel → http://localhost:${TUNNEL_PORT}\n`)

let tunnelUrl: string
try {
  tunnelUrl = await waitForTunnelUrl()
} catch (err) {
  console.error('\n[dev] Failed to start tunnel:', err instanceof Error ? err.message : err)
  process.exit(1)
}

console.log(`\n[dev] Tunnel URL: ${tunnelUrl}`)
patchDotEnv('WEB_APP_URL', tunnelUrl)
console.log(`[dev] .env patched: WEB_APP_URL=${tunnelUrl}\n`)

console.log('[dev] Starting Express + Vite dev server…')
spawnNpmScript('web', 'web:dev')

console.log('[dev] Starting Telegram bot…')
spawnNpmScript('bot', 'telegram')

console.log('\n[dev] All services running. Ctrl+C to stop everything.\n')
