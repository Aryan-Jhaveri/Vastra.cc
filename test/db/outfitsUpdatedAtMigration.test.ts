import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { join } from 'path'
import { reconcileMigrations } from '../../src/db/reconcileMigrations.js'

// #376 — outfits.updated_at, the change marker the embeddings reconciler
// compares against each outfit's text vector.

const migrationsFolder = join(__dirname, '../../src/db/migrations')
const WHEN = 1783700000014

type Col = { name: string; notnull: number; dflt_value: string | null }
const outfitColumn = (db: InstanceType<typeof Database>) =>
  (db.prepare('PRAGMA table_info(outfits)').all() as Col[]).find(c => c.name === 'updated_at')

describe('0042_outfits_updated_at (#376)', () => {
  it('a fresh install has outfits.updated_at NOT NULL DEFAULT 0', () => {
    const db = new Database(':memory:')
    reconcileMigrations(db, migrationsFolder)
    const col = outfitColumn(db)
    expect(col).toMatchObject({ notnull: 1, dflt_value: '0' })
    const applied = db.prepare('SELECT hash FROM __drizzle_migrations WHERE hash = ?').get('0042_outfits_updated_at')
    expect(applied).toBeTruthy()
  })

  it('an existing install gains the column and stamps every outfit with the migration time', () => {
    const db = new Database(':memory:')
    reconcileMigrations(db, migrationsFolder)
    // Rewind to the pre-#376 state: 0041 applied, 0042 not yet.
    db.exec('ALTER TABLE outfits DROP COLUMN updated_at')
    db.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(WHEN)
    db.prepare(`INSERT INTO users (id, email, created_at) VALUES ('u1', 'u1@example.com', 1)`).run()
    db.prepare(`INSERT INTO outfits (id, user_id, name, item_ids, created_at) VALUES ('o1', 'u1', 'O', '[]', 1)`).run()
    const before = Date.now() - 1000

    reconcileMigrations(db, migrationsFolder)

    expect(outfitColumn(db)).toBeTruthy()
    const row = db.prepare('SELECT id, name, updated_at FROM outfits').get() as { id: string; name: string; updated_at: number }
    expect(row).toMatchObject({ id: 'o1', name: 'O' })
    expect(row.updated_at).toBeGreaterThanOrEqual(before)
    expect(row.updated_at).toBeLessThanOrEqual(Date.now() + 1000)

    // Idempotent on the next boot.
    reconcileMigrations(db, migrationsFolder)
    const n = db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations WHERE hash = ?').get('0042_outfits_updated_at') as { n: number }
    expect(n.n).toBe(1)
  })
})
