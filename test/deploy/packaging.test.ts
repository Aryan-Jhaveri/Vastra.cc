import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

// #315 Phase 3 — the install paths: the self-host Render blueprint behind the
// Deploy button, the GHCR publish workflow, the operator scripts in the image,
// and install.sh offering make setup. Line-based checks (no YAML dependency).

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

function envKeys(yaml: string): Map<string, string | null> {
  const keys = new Map<string, string | null>()
  const lines = yaml.split('\n')
  lines.forEach((line, i) => {
    const m = /^\s+- key: (\S+)/.exec(line)
    if (!m) return
    const next = lines[i + 1] ?? ''
    const v = /^\s+value: "?([^"]*)"?\s*$/.exec(next)
    keys.set(m[1], v ? v[1] : null)
  })
  return keys
}

describe('self-host Render blueprint (deploy/render.selfhost.yaml)', () => {
  const yaml = read('deploy/render.selfhost.yaml')
  const keys = envKeys(yaml)

  it('sets only self-host variables (no hosted mode, billing or admin fallback); sign-ups closed; mock AI', () => {
    expect([...keys.keys()].sort()).toEqual(
      ['ALLOW_SIGNUPS', 'CLOSET_DATA_DIR', 'GEMINI_API_KEY', 'MOCK_AI_IMAGE_GEN', 'MOCK_EMBEDDINGS', 'NODE_ENV', 'WEB_APP_URL'])
    expect(keys.get('ALLOW_SIGNUPS')).toBe('false')
    expect(keys.get('MOCK_AI_IMAGE_GEN')).toBe('true')
    expect(keys.get('MOCK_EMBEDDINGS')).toBe('true')
    expect(keys.get('CLOSET_DATA_DIR')).toBe('/data')
    expect(keys.get('NODE_ENV')).toBe('production')
  })

  it('persists /data on a disk, builds the Dockerfile, and health-checks the real status route', () => {
    expect(yaml).toMatch(/^\s+mountPath: \/data$/m)
    expect(yaml).toMatch(/^\s+dockerfilePath: \.\/Dockerfile$/m)
    expect(yaml).toMatch(/^\s+healthCheckPath: \/api\/auth\/status$/m)
    expect(yaml).not.toMatch(/^\s+branch:/m)
  })

  it('every variable it sets is one the app reads', () => {
    const src = execFileSync('grep', ['-rhoE', '--exclude-dir=node_modules', '--exclude-dir=dist', 'process\\.env\\.[A-Z_]+', join(root, 'src')], { encoding: 'utf8' })
    const known = new Set(src.split('\n').map(l => l.replace('process.env.', '')))
    known.add('NODE_ENV')
    for (const k of keys.keys()) expect(known, k).toContain(k)
  })
})

describe('GHCR publish workflow', () => {
  const wf = read('.github/workflows/docker-publish.yml')

  it('pins every action to a full commit SHA and only runs in the public repo, on version tags', () => {
    const uses = [...wf.matchAll(/uses: (\S+)/g)].map(m => m[1])
    expect(uses.length).toBeGreaterThanOrEqual(5)
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/)
    expect(wf).toContain("if: github.repository == 'Aryan-Jhaveri/Vastra.cc'")
    expect(wf).toContain("tags: ['v*.*.*']")
    expect(wf).toContain('latest=false')
  })
})

describe('operator scripts in the image', () => {
  it('the Dockerfile copies setup, sweep and image-backup, and they exist', () => {
    const line = read('Dockerfile').split('\n').find(l => l.startsWith('COPY scripts/'))!
    for (const s of ['scripts/setup.ts', 'scripts/sweep-images.ts', 'scripts/image-backup.ts']) {
      expect(line).toContain(s)
      expect(existsSync(join(root, s))).toBe(true)
    }
  })
})

describe('install.sh offers make setup', () => {
  function dry(mode: string) {
    const dir = mkdtempSync(join(tmpdir(), 'vastra-install-'))
    try {
      return execFileSync('bash', [join(root, 'install.sh'), mode, '--yes', '--dry-run', '--env-file', join(dir, '.env')], {
        env: { PATH: process.env.PATH, HOME: dir },
      }).toString()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('CPU / Ollama: runs setup inside the container, as the invoking user, writing the same .env', () => {
    const out = dry('--cpu')
    expect(out).toMatch(/Then offer: docker compose run --rm --no-deps --user \d+:\d+ -e VASTRA_IN_CONTAINER=1 -v \S+:\/host closet node --import tsx scripts\/setup\.ts --target docker --out \/host\/\.env/)
    expect(dry('--mac-ollama')).toContain('scripts/setup.ts')
  })

  it('GPU: not offered (the stack is already wired to its own model servers)', () => {
    expect(dry('--gpu')).not.toContain('scripts/setup.ts')
  })
})
