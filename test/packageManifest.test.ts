import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const FLOATING_SPECS: readonly string[] = ['latest', '*', 'x', '']

const manifests = [
  { label: 'root', path: join(__dirname, '..', 'package.json') },
  { label: 'frontend', path: join(__dirname, '..', 'src/transport/web/app/package.json') },
]

describe('package manifests', () => {
  it.each(manifests)('declares no floating version specs ($label)', ({ label, path }) => {
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }

    const specs: Array<[string, string]> = [
      ...Object.entries(pkg.dependencies ?? {}),
      ...Object.entries(pkg.devDependencies ?? {}),
    ]

    const floating = specs.filter(([, spec]) => FLOATING_SPECS.includes(spec))
    expect(
      floating.map(([name]) => `${label}: ${name}`).join(', '),
      'floating specs ("latest", "*", "x", "") make installs non-reproducible and let majors slip in silently — pin or use a range (see CLAUDE.md "Dependency policy")'
    ).toBe('')
  })
})
