import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const workflow = readFileSync(join(root, '.github/workflows/test.yml'), 'utf8')

describe('CI workflow', () => {
  it('the core job installs frontend dependencies, because the root suite imports vite.config.ts', () => {
    const core = workflow.slice(workflow.indexOf('test-core:'), workflow.indexOf('test-frontend:'))
    expect(core).toMatch(/working-directory: src\/transport\/web\/app\s+run: npm install/)
    expect(core.indexOf('Install frontend dependencies')).toBeLessThan(core.indexOf('npm test'))
  })
})
