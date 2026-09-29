import { rmSync } from 'fs'

// #308 — vitest.config.ts gives every run its own CLOSET_DATA_DIR (a fresh
// temp dir). Remove it when the run ends.
export default function setup() {
  return () => {
    const dir = process.env.CLOSET_TEST_DATA_DIR
    if (dir && dir.includes('closet-test-')) rmSync(dir, { recursive: true, force: true })
  }
}
