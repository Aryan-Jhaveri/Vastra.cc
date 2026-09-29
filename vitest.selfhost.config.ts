import { defineConfig } from 'vitest/config'
import base from './vitest.config'

// #358 — the self-host test run (`make test-selfhost`): HOSTED_MODE unset, no
// hosted hooks registered (test/setup.ts), and test/hosted/** left out. It is
// the suite the open-source export runs, where src/hosted is a stub.
const { HOSTED_MODE: _hosted, ...env } = base.test!.env as Record<string, string>

export default defineConfig({
  test: {
    ...base.test,
    env,
    exclude: [...(base.test!.exclude ?? []), 'test/hosted/**'],
  },
})
