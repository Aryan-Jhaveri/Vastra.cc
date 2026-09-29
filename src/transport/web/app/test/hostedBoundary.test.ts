import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { describe, expect, it } from 'vitest'

// #358 — hosted-only (vastra.cc) UI lives under src/hosted/. Shared code may
// import src/hosted/index and nothing else there, so the open-source export can
// swap that one file for a stub.

const SRC = resolve(__dirname, '../src')
const HOSTED = join(SRC, 'hosted')
const INDEX_FILES = ['index.ts', 'index.tsx'].map(f => join(HOSTED, f))

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

const SPECIFIER = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

/** Relative import specifiers of a file, resolved to absolute paths (no extension). */
function relativeImports(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  return [...src.matchAll(SPECIFIER)]
    .map(m => m[1] ?? m[2] ?? m[3])
    .filter(s => s.startsWith('.'))
    .map(s => resolve(dirname(file), s.split('?')[0]))
}

function isHostedIndex(target: string): boolean {
  return target === HOSTED || INDEX_FILES.some(f => f.replace(/\.tsx?$/, '') === target.replace(/\.tsx?$/, ''))
}

describe('frontend hosted boundary', () => {
  it('src/hosted/index exists', () => {
    expect(INDEX_FILES.some(f => existsSync(f))).toBe(true)
  })

  it('shared code imports hosted/ only through its index', () => {
    const shared = walk(SRC).filter(f => /\.(ts|tsx)$/.test(f) && !f.startsWith(HOSTED + '/'))
    const violations = shared.flatMap(file =>
      relativeImports(file)
        .filter(target => (target === HOSTED || target.startsWith(HOSTED + '/')) && !isHostedIndex(target))
        .map(target => `${relative(SRC, file)} → ${relative(SRC, target)}`),
    )
    expect(violations).toEqual([])
  })

  it('the checker catches a deep import', () => {
    const target = resolve(SRC, 'pages', '../hosted/components/WalletCard')
    expect(target.startsWith(HOSTED + '/') && !isHostedIndex(target)).toBe(true)
    expect(isHostedIndex(resolve(SRC, 'pages', '../hosted'))).toBe(true)
  })
})
