import { readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { describe, expect, it } from 'vitest'

// #358 — hosted-only code (Stripe, wallet, per-user keys, admin metrics)
// lives in src/hosted/. The open-source export deletes that directory and
// drops in a stub src/hosted/index.ts, so shared code may import ONLY that
// index. Anything else would break the export's build.

const ROOT = resolve(__dirname, '..')
const HOSTED = join(ROOT, 'src', 'hosted')
const ALLOWED = join(HOSTED, 'index')
const SKIP = [HOSTED, join(ROOT, 'src', 'transport', 'web', 'app')]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (SKIP.includes(path) || name === 'node_modules') return []
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|mts|mjs|js)$/.test(name) ? [path] : []
  })
}

const SPECIFIER = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]|\bvi\.mock\(\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g

function hostedImports(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const bad: string[] = []
  for (const m of src.matchAll(SPECIFIER)) {
    const spec = m.slice(1).find(Boolean)!
    if (!spec.startsWith('.')) continue
    const target = resolve(dirname(file), spec).replace(/\.(ts|js|mjs|tsx)$/, '')
    if ((target === HOSTED || target.startsWith(HOSTED + sep)) && target !== ALLOWED) bad.push(spec)
  }
  return bad
}

describe('hosted boundary', () => {
  it('shared code (src/ and scripts/) imports src/hosted/ only through its index', () => {
    const files = [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'scripts'))]
    expect(files.length).toBeGreaterThan(100)
    const violations = files.flatMap(f => hostedImports(f).map(spec => `${relative(ROOT, f)} → ${spec}`))
    expect(violations).toEqual([])
  })

  it('src/billing/ holds no code', () => {
    let files: string[] = []
    try { files = readdirSync(join(ROOT, 'src', 'billing')) } catch { /* gone */ }
    expect(files).toEqual([])
  })

  it('the scan catches a deep import', () => {
    const file = join(ROOT, 'src', 'transport', 'web', 'server.ts')
    const src = "import x from '../../hosted/billing/wallet.js'\nimport y from '../../hosted/index.js'"
    const matches = [...src.matchAll(SPECIFIER)].map(m => m.slice(1).find(Boolean)!)
      .filter(spec => {
        const target = resolve(dirname(file), spec).replace(/\.(ts|js|mjs|tsx)$/, '')
        return target.startsWith(HOSTED + sep) && target !== ALLOWED
      })
    expect(matches).toEqual(['../../hosted/billing/wallet.js'])
  })
})
