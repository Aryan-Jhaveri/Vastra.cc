import { defineConfig } from 'vitest/config'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// One data dir per run, so two overlapping runs never share a DB (#308).
// Reused if already set so the config and workers agree on one dir.
const dataDir = process.env.CLOSET_TEST_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'closet-test-'))
process.env.CLOSET_TEST_DATA_DIR = dataDir

// Self-hosted: HOSTED_MODE stays unset, so no hosted hooks are registered.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    env: {
      CLOSET_DATA_DIR: dataDir,
      GEMINI_API_KEY: 'test-key',
      // Chat tests that switch HOSTED_MODE on need a spend cap: hosted chat
      // fails closed without one (#248). Mirrors the private config.
      CHAT_DAILY_SPEND_CAP_CENTS: '100000',
    },
    setupFiles: ['./test/setup.ts'],
    globalSetup: ['./test/globalSetup.ts'],
    // Tests share one SQLite file under CLOSET_DATA_DIR, so files run one at
    // a time; tests inside a file are sequential too.
    fileParallelism: false,
    clearMocks: false,
  },
})
