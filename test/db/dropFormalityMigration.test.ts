import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { join } from 'path'
import { reconcileMigrations } from '../../src/db/reconcileMigrations.js'

const migrationsFolder = join(__dirname, '../../src/db/migrations')
const itemColumns = (db: InstanceType<typeof Database>) =>
  (db.prepare('PRAGMA table_info(items)').all() as Array<{ name: string }>).map(c => c.name)

describe('0032_drop_item_formality (#280)', () => {
  it('a fresh install ends without items.formality', () => {
    const db = new Database(':memory:')
    reconcileMigrations(db, migrationsFolder)
    expect(itemColumns(db)).not.toContain('formality')
    expect(itemColumns(db)).toContain('wear_context')
  })

  it('an install that already ran 0031 (prod) drops the column and keeps item rows', () => {
    const db = new Database(':memory:')
    reconcileMigrations(db, migrationsFolder)
    // Rewind to the prod state: 0031 applied, 0032 not yet.
    db.exec('ALTER TABLE items ADD formality integer')
    db.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1783700000004)
    db.prepare(`INSERT INTO users (id, email, created_at) VALUES ('u1', 'u1@example.com', 1)`).run()
    db.prepare(`INSERT INTO items (id, user_id, image_uri, category, formality, created_at, updated_at)
                VALUES ('i1', 'u1', 'images/items/a.jpg', 'top', 3, 1, 1)`).run()

    reconcileMigrations(db, migrationsFolder)

    expect(itemColumns(db)).not.toContain('formality')
    expect(db.prepare('SELECT id, category FROM items').all()).toEqual([{ id: 'i1', category: 'top' }])
  })
})
