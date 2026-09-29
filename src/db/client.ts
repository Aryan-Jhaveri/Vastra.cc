import { drizzle } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import * as schema from './schema.js'

export const DATA_DIR = process.env.CLOSET_DATA_DIR || `${process.env.HOME ?? process.env.USERPROFILE}/.closet`
const dbPath = `${DATA_DIR}/closet.db`

let _sqlite: InstanceType<typeof Database> | null = null
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!_db) {
    mkdirSync(dirname(dbPath), { recursive: true })
    _sqlite = new Database(dbPath)
    _sqlite.pragma('journal_mode = WAL')
    _sqlite.pragma('foreign_keys = ON')
    _db = drizzle(_sqlite, { schema })
  }
  return _db
}

export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop]
  },
  set(_target, prop, value) {
    ;(getDb() as unknown as Record<string | symbol, unknown>)[prop] = value
    return true
  },
})

export function getSqlite(): InstanceType<typeof Database> {
  getDb()
  return _sqlite!
}

export function resetDbForTesting(): void {
  if (_sqlite) {
    try {
      _sqlite.close()
    } catch {
      // Already closed
    }
  }
  _sqlite = null
  _db = null
}
