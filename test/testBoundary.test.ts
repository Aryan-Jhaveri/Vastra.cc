import { readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { describe, expect, it } from 'vitest'

// #358 — `make test-selfhost` runs every test outside test/hosted/ with
// HOSTED_MODE unset, and the open-source export runs the same set with
// src/hosted/ replaced by a stub. So a test outside test/hosted/ must not
// import, dynamically import or mock anything under src/hosted/. Hosted cases
// go in test/hosted/ (mirroring the path); shared tests that need to quiet a
// hosted side effect use src/hostedHooks.ts (test/helpers/quietHostedHooks.ts).

const ROOT = resolve(__dirname, '..')
const HOSTED_SRC = join(ROOT, 'src', 'hosted') + sep
const HOSTED_TESTS = join(ROOT, 'test', 'hosted') + sep

// test/setup.ts registers the hosted hooks for the hosted run only (it skips
// the import when HOSTED_MODE is unset), the way server.ts does at boot.
const ALLOWED = new Set([join(ROOT, 'test', 'setup.ts')])

const SPECIFIER = /\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\bvi\.(?:mock|doMock|importActual|importMock)\(\s*['"]([^'"]+)['"]/g

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(path)
  }
  return out
}

function hostedImports(file: string, source: string): string[] {
  const hits: string[] = []
  for (const m of source.matchAll(SPECIFIER)) {
    const spec = m[1] ?? m[2] ?? m[3]
    if (!spec.startsWith('.')) continue
    if ((resolve(dirname(file), spec) + sep).startsWith(HOSTED_SRC)) hits.push(spec)
  }
  return hits
}

describe('test boundary', () => {
  it('tests outside test/hosted/ never import or mock src/hosted/', () => {
    const offenders = walk(join(ROOT, 'test'))
      .filter(f => !f.startsWith(HOSTED_TESTS) && !ALLOWED.has(f))
      .flatMap(f => hostedImports(f, readFileSync(f, 'utf8')).map(spec => `${relative(ROOT, f)} → ${spec}`))
    expect(offenders).toEqual([])
  })

  it('the checker catches imports, dynamic imports and mocks', () => {
    const file = join(ROOT, 'test', 'transport', 'web', 'x.test.ts')
    const source = [
      "import { a } from '../../../src/hosted/billing/wallet.js'",
      "const m = await import('../../../src/hosted/index.js')",
      "vi.mock('../../../src/hosted/routes/billing.js', () => ({}))",
      "import { b } from '../../../src/hostedHooks.js'",
    ].join('\n')
    expect(hostedImports(file, source)).toEqual([
      '../../../src/hosted/billing/wallet.js',
      '../../../src/hosted/index.js',
      '../../../src/hosted/routes/billing.js',
    ])
  })
})
