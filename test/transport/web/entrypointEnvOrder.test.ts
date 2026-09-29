import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// Entry points must load .env before any module that reads env at import
// time: src/db/client.ts computes DATA_DIR on load, so a later dotenv makes a
// local dev server open ~/.closet (an empty closet) instead of CLOSET_DATA_DIR.
const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')

function firstImport(file: string): string | undefined {
  return readFileSync(join(root, file), 'utf8').split('\n').map(l => l.trim()).find(l => l.startsWith('import '))
}

describe('entry points load dotenv first', () => {
  it.each(['src/transport/web/server.ts', 'src/combined.ts'])('%s', file => {
    expect(firstImport(file)).toBe("import 'dotenv/config'")
  })
})
