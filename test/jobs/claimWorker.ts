import { claimJob } from '../../src/jobs/claims.js'

// Separate OS processes, connections and module state; no AI executors imported.
process.send?.(claimJob(process.argv[2], 'user-a', Number(process.argv[3]))?.token ?? null)
