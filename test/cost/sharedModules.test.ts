import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

// ai_calls observability, the price table, the billing errors and the Billing
// seam are shared (self-host and hosted). They must not reach into hosted code;
// the hosted wallet billing is registered through src/hostedHooks.ts instead.
const SHARED = ['src/ai/aiCalls.ts', 'src/cost/tokenTable.ts', 'src/cost/errors.ts', 'src/cost/billing.ts', 'src/hostedHooks.ts']

function importSpecifiers(path: string): string[] {
  const src = readFileSync(resolve(__dirname, '../..', path), 'utf8')
  return [...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1] ?? m[2])
}

describe('shared cost modules', () => {
  it.each(SHARED)('%s imports nothing hosted', path => {
    expect(importSpecifiers(path).filter(s => /(^|\/)(hosted|billing)\//.test(s))).toEqual([])
  })
})
