import { readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { describe, expect, it } from 'vitest'

// #358 — the open-source export drops src/hosted/ (keeping only a stub index)
// and test/hosted/. So a frontend test outside test/hosted/ may reach hosted UI
// only through src/hosted/index, and should mock it with test/helpers/hostedStub
// (the stub's API). Importing or mocking anything deeper belongs in test/hosted/.

const APP = resolve(__dirname, '..')
const HOSTED_SRC = join(APP, 'src', 'hosted')
const HOSTED_TESTS = join(APP, 'test', 'hosted') + sep

const SPECIFIER = /\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\bvi\.(?:mock|doMock|importActual|importMock)\(\s*['"]([^'"]+)['"]/g

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

/** Specifiers in `source` (a file at `file`) that reach past the hosted index. */
function hostedInternals(file: string, source: string): string[] {
  const hits: string[] = []
  for (const m of source.matchAll(SPECIFIER)) {
    const spec = m[1] ?? m[2] ?? m[3]
    if (!spec.startsWith('.')) continue
    const target = resolve(dirname(file), spec.split('?')[0]).replace(/\.(ts|tsx)$/, '')
    const isIndex = target === HOSTED_SRC || target === join(HOSTED_SRC, 'index')
    if (!isIndex && (target + sep).startsWith(HOSTED_SRC + sep)) hits.push(spec)
  }
  return hits
}

describe('frontend test boundary', () => {
  it('tests outside test/hosted/ reach hosted UI only through src/hosted/index', () => {
    const offenders = walk(join(APP, 'test'))
      .filter(f => !f.startsWith(HOSTED_TESTS))
      .flatMap(f => hostedInternals(f, readFileSync(f, 'utf8')).map(spec => `${relative(APP, f)} → ${spec}`))
    expect(offenders).toEqual([])
  })

  it('the checker catches imports, dynamic imports and mocks, and allows the index', () => {
    const file = join(APP, 'test', 'pages', 'x.test.tsx')
    // Built at runtime so this file's own source holds no hosted paths.
    const up = ['..', '..', 'src', 'hosted'].join('/')
    const source = [
      `import { a } from '${up}/components/WalletCard'`,
      `const m = await import('${up}/api/billing')`,
      `vi.mock('${up}/hooks/useBilling', () => ({}))`,
      `vi.mock('${up}', () => import('../helpers/hostedStub'))`,
      `import { b } from '${up}/index'`,
    ].join('\n')
    expect(hostedInternals(file, source)).toEqual([
      `${up}/components/WalletCard`, `${up}/api/billing`, `${up}/hooks/useBilling`,
    ])
  })
})
