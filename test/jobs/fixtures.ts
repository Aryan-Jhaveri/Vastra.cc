import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../src/db/schema.js'

// Explicit schema contract for the parent-owned scheduler migration.
export function createJobDatabase(path = ':memory:') {
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      type TEXT NOT NULL, schedule TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, created_at INTEGER NOT NULL,
      next_run_at INTEGER, claim_token TEXT, claim_expires_at INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0, retry_at INTEGER,
      run_state TEXT NOT NULL DEFAULT 'idle', last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS job_runs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, job_id TEXT NOT NULL,
      fired_at INTEGER NOT NULL, status TEXT NOT NULL, result_json TEXT, error TEXT
    );
  `)
  return { db: drizzle(sqlite, { schema }), getSqlite: () => sqlite }
}
