import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { reconcileMigrations } from '../../src/db/reconcileMigrations.js'

// Build a fake migrations folder layout matching drizzle's on-disk format.
function buildMigrationsFolder(entries: { tag: string; when: number; sql: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-test-'))
  mkdirSync(join(root, 'meta'), { recursive: true })

  for (const { tag, sql } of entries) {
    writeFileSync(join(root, `${tag}.sql`), sql)
  }

  const journal = {
    version: '7',
    dialect: 'sqlite',
    entries: entries.map((e, idx) => ({
      idx,
      version: '6',
      when: e.when,
      tag: e.tag,
      breakpoints: true,
    })),
  }
  writeFileSync(join(root, 'meta', '_journal.json'), JSON.stringify(journal))

  return root
}

let sqlite: InstanceType<typeof Database>
let folder: string

beforeEach(() => {
  sqlite = new Database(':memory:')
})

afterEach(() => {
  sqlite.close()
  if (folder) rmSync(folder, { recursive: true, force: true })
})

describe('reconcileMigrations', () => {
  it('applies all journal entries on a fresh database', () => {
    folder = buildMigrationsFolder([
      { tag: '0000_init', when: 1000, sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY);' },
      { tag: '0001_b', when: 2000, sql: 'CREATE TABLE b (id INTEGER PRIMARY KEY);' },
    ])

    reconcileMigrations(sqlite, folder)

    const tables = sqlite
      .prepare<[], { name: string }>('SELECT name FROM sqlite_master WHERE type=\'table\' ORDER BY name')
      .all()
      .map(r => r.name)
    expect(tables).toContain('a')
    expect(tables).toContain('b')

    const rows = sqlite
      .prepare<[], { created_at: number }>('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')
      .all()
      .map(r => Number(r.created_at))
    expect(rows).toEqual([1000, 2000])
  })

  it('is idempotent on a second call', () => {
    folder = buildMigrationsFolder([
      { tag: '0000_init', when: 1000, sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY);' },
    ])

    reconcileMigrations(sqlite, folder)
    reconcileMigrations(sqlite, folder)

    const count = sqlite.prepare<[], { c: number }>('SELECT COUNT(*) as c FROM __drizzle_migrations').get()!
    expect(count.c).toBe(1)
  })

  it('skips entries already recorded by tag (mid-journal drift)', () => {
    // Reproduces the 0024→0025 / 0025→0026 class: a later entry is recorded
    // but an earlier one is not. The reconciler must apply the earlier entry
    // because it walks in order — drizzle's max(created_at) logic would
    // skip it forever.
    folder = buildMigrationsFolder([
      { tag: '0000_users', when: 1000, sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY);' },
      { tag: '0001_add_col', when: 2000, sql: 'ALTER TABLE users ADD COLUMN email TEXT;' },
      { tag: '0002_add_col2', when: 3000, sql: 'ALTER TABLE users ADD COLUMN name TEXT;' },
    ])

    // Pre-create: users table + 0000 + 0002 recorded as applied; 0001 missing.
    // The "name" column ran but "email" didn't.
    sqlite.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); ALTER TABLE users ADD COLUMN name TEXT;')
    sqlite.exec(
      'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER);' +
        'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (\'0000_users\', 1000);' +
        'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (\'0002_add_col2\', 3000);',
    )

    reconcileMigrations(sqlite, folder)

    const cols = sqlite
      .prepare<[], { name: string }>('PRAGMA table_info(users)')
      .all()
      .map(r => r.name)
    expect(cols).toContain('email')

    const hashes = sqlite
      .prepare<[], { hash: string }>('SELECT hash FROM __drizzle_migrations ORDER BY hash')
      .all()
      .map(r => r.hash)
    expect(hashes).toEqual(['0000_users', '0001_add_col', '0002_add_col2'])
  })

  it('identifies applied migrations by hash (tag), not by created_at — survives stale created_at collisions', () => {
    // Production bite: journal `when` values get bumped to work around
    // drizzle's max(created_at) bug. A bumped `when` can collide with a
    // stale row drizzle wrote for a different migration under that same
    // value before the bump. If we keyed identity off created_at, the
    // current entry would be falsely treated as applied. Identifying by
    // hash (tag) prevents this.
    folder = buildMigrationsFolder([
      {
        tag: '0025_users_accepted_terms',
        when: 1783600000001,
        sql:
          'ALTER TABLE users ADD accepted_terms_at integer;--> statement-breakpoint\n' +
          'UPDATE users SET accepted_terms_at = 1783700000000 WHERE accepted_terms_at IS NULL;',
      },
    ])

    // Stale row from a prior drizzle run that wrote *something else* at
    // created_at=1783600000001 (this was the original-0026 row before
    // 60a701b2 bumped 0026.when past it).
    sqlite.exec(
      'CREATE TABLE users (id INTEGER PRIMARY KEY);' +
        'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER);' +
        'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (\'<some-old-sha-for-original-0026>\', 1783600000001);',
    )

    reconcileMigrations(sqlite, folder)

    const cols = sqlite
      .prepare<[], { name: string }>('PRAGMA table_info(users)')
      .all()
      .map(r => r.name)
    expect(cols).toContain('accepted_terms_at')

    const recorded = sqlite
      .prepare<[], { hash: string }>('SELECT hash FROM __drizzle_migrations ORDER BY hash')
      .all()
      .map(r => r.hash)
    expect(recorded).toContain('0025_users_accepted_terms')
  })

  it('tolerates a migration whose columns are already physically applied (the Render 0026 scenario)', () => {
    // Reproduces the exact production failure: a migration's columns already
    // exist on the DB because the migration was applied under a previous
    // `when` value, but no row in __drizzle_migrations matches the current
    // `when`. drizzle's migrate would crash on duplicate-column-name. We
    // swallow the error and record the entry as applied.
    folder = buildMigrationsFolder([
      {
        tag: '0026_share_inbox_columns',
        when: 1783600000002,
        sql:
          'ALTER TABLE share_payloads ADD intended_action text;--> statement-breakpoint\n' +
          'ALTER TABLE share_payloads ADD claim_token text;',
      },
    ])

    // Pre-create the table WITH both columns already present (as Render's
    // disk currently is).
    sqlite.exec(
      'CREATE TABLE share_payloads (id INTEGER PRIMARY KEY, intended_action TEXT, claim_token TEXT);',
    )

    expect(() => reconcileMigrations(sqlite, folder)).not.toThrow()

    const created = sqlite
      .prepare<[], { created_at: number }>('SELECT created_at FROM __drizzle_migrations')
      .all()
      .map(r => Number(r.created_at))
    expect(created).toEqual([1783600000002])
  })

  it('rolls back a destructive backfill and records when end-state is present (the Render 0015 scenario)', () => {
    // Reproduces 0015_settings_user_id: original schema is `settings(key, value)`,
    // migration recreates as `settings(key, user_id, value)` PK(key, user_id)
    // and back-fills via `INSERT ... SELECT key, 'self', value FROM settings_temp`.
    // After the migration first ran, users were created and the live table
    // now holds multi-user rows. Re-running the migration would copy multi-
    // user data into settings_temp, drop settings, recreate the empty schema,
    // and then crash on the INSERT (UNIQUE collision when folding all rows
    // to user_id='self'). We must roll back and observe that the end-state
    // schema is already present, then record the migration.
    folder = buildMigrationsFolder([
      {
        tag: '0015_settings_user_id',
        when: 1781200000000,
        sql:
          'CREATE TABLE `settings_temp` AS SELECT * FROM `settings`;--> statement-breakpoint\n' +
          'DROP TABLE `settings`;--> statement-breakpoint\n' +
          'CREATE TABLE `settings` (\n' +
          '  `key` text NOT NULL,\n' +
          '  `user_id` text NOT NULL DEFAULT \'self\',\n' +
          '  `value` text NOT NULL,\n' +
          '  PRIMARY KEY (`key`, `user_id`)\n' +
          ');--> statement-breakpoint\n' +
          'INSERT INTO `settings` (`key`, `user_id`, `value`) SELECT `key`, \'self\', `value` FROM `settings_temp`;--> statement-breakpoint\n' +
          'DROP TABLE `settings_temp`;',
      },
    ])

    // Pre-create the END state of 0015 plus multi-user data that will collide
    // on re-run.
    sqlite.exec(
      'CREATE TABLE settings (key TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT \'self\', value TEXT NOT NULL, PRIMARY KEY (key, user_id));' +
        'INSERT INTO settings VALUES (\'navWidth\', \'self\', \'240\');' +
        'INSERT INTO settings VALUES (\'navWidth\', \'user_abc\', \'300\');',
    )

    expect(() => reconcileMigrations(sqlite, folder)).not.toThrow()

    // Original multi-user data must still be intact after rollback.
    const rows = sqlite
      .prepare<[], { key: string; user_id: string }>(
        'SELECT key, user_id FROM settings ORDER BY key, user_id',
      )
      .all()
    expect(rows).toEqual([
      { key: 'navWidth', user_id: 'self' },
      { key: 'navWidth', user_id: 'user_abc' },
    ])

    // No leaked settings_temp from the failed run.
    const temp = sqlite
      .prepare<[], { name: string }>(
        'SELECT name FROM sqlite_master WHERE name=\'settings_temp\'',
      )
      .get()
    expect(temp).toBeUndefined()

    const created = sqlite
      .prepare<[], { created_at: number }>('SELECT created_at FROM __drizzle_migrations')
      .all()
      .map(r => Number(r.created_at))
    expect(created).toEqual([1781200000000])
  })

  it('applies a later-indexed entry whose `when` is LOWER than an already-applied entry (#157)', () => {
    // The exact #157 bite: drizzle's migrator reads MAX(created_at) from
    // __drizzle_migrations once and then only applies entries whose `when`
    // is strictly greater than that max. If a later-indexed entry has a
    // LOWER `when` than an entry already applied, drizzle silently skips
    // it on every boot — the migration never lands. The reconciler walks
    // the journal in order and keys identity off the tag (hash), so a low
    // `when` on an un-recorded entry still gets applied.
    folder = buildMigrationsFolder([
      { tag: '0000_a', when: 1000, sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY);' },
      { tag: '0001_b', when: 3000, sql: 'CREATE TABLE b (id INTEGER PRIMARY KEY);' },
      { tag: '0002_c', when: 1500, sql: 'CREATE TABLE c (id INTEGER PRIMARY KEY);' },
    ])

    // Simulate a prior run that applied 0000 and 0001 but never saw 0002
    // (because 0002.when < max(created_at)=3000 → drizzle skipped it).
    sqlite.exec('CREATE TABLE a (id INTEGER PRIMARY KEY);')
    sqlite.exec('CREATE TABLE b (id INTEGER PRIMARY KEY);')
    sqlite.exec(
      'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER);' +
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('0000_a', 1000);" +
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('0001_b', 3000);",
    )

    reconcileMigrations(sqlite, folder)

    const tables = sqlite
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map(r => r.name)
    expect(tables).toContain('c')

    const hashes = sqlite
      .prepare<[], { hash: string }>('SELECT hash FROM __drizzle_migrations ORDER BY hash')
      .all()
      .map(r => r.hash)
    expect(hashes).toEqual(['0000_a', '0001_b', '0002_c'])
  })

  it('rethrows on non-idempotent SQL errors (genuine bug, not drift)', () => {
    folder = buildMigrationsFolder([
      { tag: '0000_bad', when: 1000, sql: 'SELECT * FROM table_that_does_not_exist;' },
    ])
    expect(() => reconcileMigrations(sqlite, folder)).toThrow(/no such table/i)
  })
})
