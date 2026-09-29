#!/usr/bin/env node
// #354 — invariants of the self-host compose stack, checked against
// `docker compose config` output for every profile combination:
//   - it renders with no .env at all (plain `docker compose up`)
//   - only Vastra and the gateway publish ports; model servers never do
//   - every vLLM server sets --gpu-memory-utilization, and the shares fit one GPU
//   - every model server has a healthcheck; the gateway refuses empty keys
//   - clm's encoder is reachable only from clm-serve
import { execFileSync } from 'node:child_process'
import { mkdtempSync, cpSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'vastra-compose-'))
const failures = []
const check = (ok, msg) => { if (!ok) failures.push(msg) }

try {
  cpSync(join(root, 'docker-compose.yml'), join(dir, 'docker-compose.yml'))
  mkdirSync(join(dir, 'deploy'), { recursive: true })
  cpSync(join(root, 'deploy'), join(dir, 'deploy'), { recursive: true })
  writeFileSync(join(dir, '.env'), '')

  const render = (profiles, env = {}) => JSON.parse(execFileSync('docker', [
    'compose', ...profiles.flatMap(p => ['--profile', p]), 'config', '--format', 'json',
  ], { cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).toString())

  let base
  try { base = render([]) } catch (err) { failures.push(`plain \`docker compose config\` fails without .env: ${err.stderr}`) }
  if (base) check(Object.keys(base.services).join() === 'closet', `default profile should run only closet, got ${Object.keys(base.services)}`)

  let full
  try { full = render(['gpu', 'gateway', 'tunnel'], { MODEL_API_KEY: 'k', GATEWAY_API_KEY: 'g' }) } catch (err) {
    failures.push(`docker compose config failed: ${String(err.stderr ?? err.message).trim()}`)
    throw new Error('render')
  }
  const services = full.services
  const published = Object.entries(services).filter(([, s]) => (s.ports ?? []).length).map(([n]) => n).sort()
  check(published.join() === 'closet,gateway', `only closet + gateway may publish ports, got ${published}`)

  let util = 0
  for (const [name, svc] of Object.entries(services)) {
    const cmd = (svc.command ?? []).join(' ')
    const isVllm = /--gpu-memory-utilization|--runner|--omni|--model=/.test(cmd)
    if (!isVllm) continue
    const m = cmd.match(/--gpu-memory-utilization=([\d.]+)/)
    check(Boolean(m), `${name}: vLLM server without --gpu-memory-utilization (default 0.9 each)`)
    if (m) util += Number(m[1])
    check(Boolean(svc.healthcheck?.test), `${name}: no healthcheck`)
    check(!(svc.ports ?? []).length, `${name}: model server publishes a port`)
  }
  check(util > 0 && util <= 0.95, `GPU shares sum to ${util.toFixed(2)}; keep them at or under 0.95`)
  check(Boolean(services.clm?.healthcheck?.test), 'clm: no healthcheck')

  const nets = svc => Object.keys(services[svc]?.networks ?? {})
  check(nets('clm-embed').join() === 'clm', `clm-embed must be on the clm network only, got ${nets('clm-embed')}`)
  check(!nets('closet').includes('clm'), 'Vastra must not reach clm-embed directly')

  const gw = (services.gateway?.entrypoint ?? []).join(' ')
  check(gw.includes('GATEWAY_API_KEY') && gw.includes('MODEL_API_KEY') && gw.includes('exit 1'), 'gateway must refuse to start without GATEWAY_API_KEY and MODEL_API_KEY')
} catch (err) {
  if (err.message !== 'render') failures.push(String(err.message))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`compose-check: ${failures.length} problem(s)\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('compose-check: ok')
