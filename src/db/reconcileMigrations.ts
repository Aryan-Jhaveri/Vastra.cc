import type Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join } from 'path'

// Drop-in replacement for drizzle's `migrate()` for better-sqlite3.
//
// Why this exists — drizzle's built-in migrator decides what to run by
// comparing each journal entry's `folderMillis` (the `when` field) against
// MAX(created_at) in `__drizzle_migrations`. If a migration ships with a
// `when` value below the current max, it's silently skipped forever. The
// "bump the timestamp" fix then re-runs migrations whose SQL has already
// physically applied → `duplicate column name` / `table already exists`
// or, worse, destructive backfills that fail with UNIQUE constraint after
// already dropping the original table.
//
// This reconciler walks the journal in order, tracks applied state
// per-entry by tag (`hash = entry.tag`; see below), wraps each migration in a
// savepoint so destructive partial runs roll back cleanly, and on
// "already-applied" failures (idempotent-class errors OR a constraint
// failure where the migration's end-state schema is already present)
// records the entry as applied and continues.
//
// Behavioural contract:
// - Same on-disk schema as drizzle's migrator: table `__drizzle_migrations`
//   with `(id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER)`.
// - `hash = entry.tag` is the source of truth for "is this entry applied".
//   We do NOT use `created_at` for identity because journal `when` values
//   get bumped to work around drizzle's max(created_at) bug, and a bumped
//   value can collide with a stale drizzle-inserted row from a prior
//   pre-bump deploy. (Exact bite: 60a701b2 bumped 0025.when to
//   1783600000001, which matched the row drizzle had previously written
//   for old-0026 at the same when — reconciler thought 0025 was applied,
//   accepted_terms_at column never landed, signup 500'd.)
// - Legacy drizzle-written rows with SHA-256 hashes are ignored — they
//   don't block re-evaluation, and the savepoint+probe machinery turns
//   the re-run into a no-op for already-applied migrations.
// - A migration is recorded as applied if EITHER it runs cleanly OR its
//   end-state schema (tables/columns it creates) is observably present
//   after rolling back the failed attempt. Genuine bugs (e.g. typos,
//   missing source tables) still throw.

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

interface Journal {
  version: string
  dialect: string
  entries: JournalEntry[]
}

// SQLite errors that mean "the change you tried to make is already there"
// at the statement level. These are safe to swallow IN ISOLATION.
const STATEMENT_IDEMPOTENT_PATTERNS: RegExp[] = [
  /duplicate column name/i,
  /already exists/i,
  /no such column/i, // dropping a column that was already dropped
  /no such index/i,  // dropping an index that was already dropped
]

// Broader errors that, combined with an end-state schema probe, indicate
// "migration already applied, current run is a re-run on data that has
// drifted." UNIQUE/PK constraint failures during a backfill INSERT are
// the canonical case (see 0015_settings_user_id on a DB with multi-user
// rows). We only swallow these if `isEndStatePresent()` confirms the
// target schema is already in place.
const MIGRATION_REAPPLY_PATTERNS: RegExp[] = [
  ...STATEMENT_IDEMPOTENT_PATTERNS,
  /UNIQUE constraint failed/i,
  /PRIMARY KEY/i,
]

function matchesAny(err: unknown, patterns: RegExp[]): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return patterns.some(rx => rx.test(msg))
}

function splitStatements(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map(s => s.trim())
    .filter(Boolean)
}

// Extract CREATE TABLE / ALTER TABLE ADD targets so we can probe the
// live DB to see whether the migration's end state is already present.
// Skips _temp tables (intermediate state) and PK/FK/CHECK clauses.
interface SchemaTarget {
  table: string
  columns: string[] // declared column names (best-effort, drops constraints)
}

function extractEndStateTargets(statements: string[]): SchemaTarget[] {
  const targets: SchemaTarget[] = []

  for (const stmt of statements) {
    const createMatch = stmt.match(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?`?(\w+)`?\s*\(([\s\S]+)\)\s*;?\s*$/i)
    if (createMatch) {
      const [, table, body] = createMatch
      if (table.endsWith('_temp')) continue
      // The "AS SELECT * FROM ..." form has no column list; skip it.
      if (/^\s*AS\s+SELECT/i.test(body)) continue
      const columns: string[] = []
      // Best-effort: split on commas that aren't inside parens, take the
      // first identifier of each clause, skip constraint keywords.
      let depth = 0
      let current = ''
      const parts: string[] = []
      for (const ch of body) {
        if (ch === '(') depth++
        else if (ch === ')') depth--
        if (ch === ',' && depth === 0) {
          parts.push(current)
          current = ''
        } else {
          current += ch
        }
      }
      if (current.trim()) parts.push(current)
      for (const part of parts) {
        const colMatch = part.trim().match(/^`?(\w+)`?\s+[A-Z]/i)
        if (!colMatch) continue
        const name = colMatch[1].toUpperCase()
        if (['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT'].includes(name)) continue
        columns.push(colMatch[1])
      }
      targets.push({ table, columns })
      continue
    }

    const alterMatch = stmt.match(/ALTER TABLE\s+`?(\w+)`?\s+ADD\s+(?:COLUMN\s+)?`?(\w+)`?/i)
    if (alterMatch) {
      targets.push({ table: alterMatch[1], columns: [alterMatch[2]] })
    }
  }

  return targets
}

function isEndStatePresent(
  sqlite: InstanceType<typeof Database>,
  targets: SchemaTarget[],
): boolean {
  if (targets.length === 0) return false // no schema signal — refuse to assume
  for (const { table, columns } of targets) {
    let liveColumns: string[]
    try {
      liveColumns = sqlite
        .prepare<unknown[], { name: string }>(`PRAGMA table_info(${table})`)
        .all()
        .map(r => r.name)
    } catch {
      return false
    }
    if (liveColumns.length === 0) return false // table missing
    for (const col of columns) {
      if (!liveColumns.includes(col)) return false
    }
  }
  return true
}

export function reconcileMigrations(
  sqlite: InstanceType<typeof Database>,
  migrationsFolder: string,
): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at INTEGER
    )
  `)

  const journalPath = join(migrationsFolder, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal

  const appliedStmt = sqlite.prepare<[string]>(
    'SELECT 1 FROM __drizzle_migrations WHERE hash = ? LIMIT 1',
  )
  const recordStmt = sqlite.prepare<[string, number]>(
    'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
  )

  for (const entry of journal.entries) {
    if (appliedStmt.get(entry.tag)) continue

    const sqlPath = join(migrationsFolder, `${entry.tag}.sql`)
    const sqlContent = readFileSync(sqlPath, 'utf8')
    const statements = splitStatements(sqlContent)

    sqlite.exec('SAVEPOINT reconcile_migration')

    let migrationError: Error | null = null
    let appliedStatements = 0
    let skippedStatements = 0

    try {
      for (const stmt of statements) {
        try {
          sqlite.exec(stmt)
          appliedStatements++
        } catch (err) {
          if (matchesAny(err, STATEMENT_IDEMPOTENT_PATTERNS)) {
            skippedStatements++
            console.warn(
              `[reconcile] ${entry.tag}: statement already applied — ${(err as Error).message}`,
            )
            continue
          }
          throw err
        }
      }
      sqlite.exec('RELEASE SAVEPOINT reconcile_migration')
      recordStmt.run(entry.tag, entry.when)
      console.log(
        `[reconcile] ${entry.tag}: applied ${appliedStatements} stmt(s), ` +
          `skipped ${skippedStatements} as already-applied`,
      )
    } catch (err) {
      migrationError = err as Error
      try {
        sqlite.exec('ROLLBACK TO SAVEPOINT reconcile_migration')
        sqlite.exec('RELEASE SAVEPOINT reconcile_migration')
      } catch {
        // savepoint state lost — connection probably wedged; let the
        // original error surface below
      }
    }

    if (migrationError) {
      const reapplyClass = matchesAny(migrationError, MIGRATION_REAPPLY_PATTERNS)
      const targets = extractEndStateTargets(statements)
      if (reapplyClass && isEndStatePresent(sqlite, targets)) {
        recordStmt.run(entry.tag, entry.when)
        console.warn(
          `[reconcile] ${entry.tag}: rolled back after "${migrationError.message}"; ` +
            `end-state schema already present — recorded as applied`,
        )
        continue
      }
      console.error(`[reconcile] ${entry.tag}: failed`, migrationError.message)
      throw migrationError
    }
  }
}
