import { spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs module, no types
import { loadHostedAdmin } from '../../../../src/transport/web/admin/loadHosted.mjs'

// #358 slice C — admin.mjs keeps the shared commands and reaches hosted code
// only through loadHosted.mjs, which tolerates src/hosted/ being absent (the
// open-source export).

const ROOT = resolve(__dirname, '../../../..')
const ADMIN = join(ROOT, 'src/transport/web/admin/admin.mjs')
const LOADER = join(ROOT, 'src/transport/web/admin/loadHosted.mjs')

let dataDir: string

function run(...args: string[]) {
  return spawnSync(process.execPath, [ADMIN, ...args], {
    env: { ...process.env, CLOSET_DATA_DIR: dataDir },
    encoding: 'utf8',
    timeout: 30_000,
  })
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'admin-shared-'))
  const db = new Database(join(dataDir, 'closet.db'))
  db.exec('CREATE TABLE users (id text, email text, name text, created_at integer, is_admin integer)')
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run('u1', 'ada@example.test', 'Ada', 0, 1)
  db.close()
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('admin.mjs → hosted boundary', () => {
  it('admin.mjs itself names no hosted path; loadHosted.mjs is the single entry point', () => {
    const admin = readFileSync(ADMIN, 'utf8')
    expect(admin).not.toMatch(/hosted\//)
    expect(admin).toContain("from './loadHosted.mjs'")
    const loader = readFileSync(LOADER, 'utf8')
    expect(loader.match(/hosted\//g)).toEqual(['hosted/'])
    expect(loader).toContain("'../../../hosted/admin/commands.mjs'")
  })

  it('loads nothing when the hosted module is absent', async () => {
    const missing = pathToFileURL(join(dataDir, 'no-such-hosted.mjs'))
    await expect(loadHostedAdmin({}, missing)).resolves.toBeNull()
  })

  it('never swallows an error from a hosted module that exists', async () => {
    const broken = join(dataDir, 'broken.mjs')
    writeFileSync(broken, "throw new Error('hosted module broke')\n")
    await expect(loadHostedAdmin({}, pathToFileURL(broken))).rejects.toThrow('hosted module broke')
  })
})

describe('admin.mjs shared commands', () => {
  it('list-users still dispatches', () => {
    const res = run('list-users')
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('[admin] 1 user(s):')
    expect(res.stdout).toContain('ada@example.test  (id=u1, name=Ada')
    expect(res.stdout).toContain('[admin]')
  })

  it('an unknown command prints usage and exits 1', () => {
    const res = run('no-such-command')
    expect(res.status).toBe(1)
    expect(res.stdout).toMatch(/^Usage: node src\/transport\/web\/admin\/admin\.mjs <command> \[args\]/)
    expect(res.stdout).toContain('  list-users ')
    expect(res.stdout).toContain('--yes / -y')
  })
})

describe('admin.mjs create-admin (#315)', () => {
  beforeEach(() => {
    rmSync(join(dataDir, 'closet.db'), { force: true })
    const db = new Database(join(dataDir, 'closet.db'))
    db.exec(`CREATE TABLE users (id text, email text, name text, created_at integer, accepted_terms_at integer,
      email_verified_at integer, is_admin integer NOT NULL DEFAULT 0)`)
    db.exec('CREATE TABLE login_tokens (id text, email text, token text, created_at integer, expires_at integer, used_at integer)')
    db.close()
  })

  function rows() {
    const db = new Database(join(dataDir, 'closet.db'), { readonly: true })
    try {
      return {
        users: db.prepare('SELECT * FROM users').all() as Array<Record<string, unknown>>,
        tokens: db.prepare('SELECT * FROM login_tokens').all() as Array<Record<string, unknown>>,
      }
    } finally { db.close() }
  }

  it('creates a verified admin and prints a one-time sign-in link whose token is stored', () => {
    const res = run('create-admin', 'Owner@Example.test')
    expect(res.status).toBe(0)
    const { users, tokens } = rows()
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ email: 'owner@example.test', is_admin: 1 })
    expect(users[0].email_verified_at).toBeTypeOf('number')
    expect(tokens).toHaveLength(1)
    expect(res.stdout).toContain(`/auth/verify?token=${tokens[0].token}`)
    expect(Number(tokens[0].expires_at) - Number(tokens[0].created_at)).toBe(15 * 60 * 1000)
  })

  it('promotes an existing account instead of duplicating it', () => {
    const db = new Database(join(dataDir, 'closet.db'))
    db.prepare('INSERT INTO users (id, email, created_at, is_admin) VALUES (?, ?, ?, 0)').run('u_existing', 'owner@example.test', 1)
    db.close()
    const res = run('create-admin', 'owner@example.test')
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Promoted admin owner@example.test (id=u_existing)')
    const { users } = rows()
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ id: 'u_existing', is_admin: 1 })
  })

  it('rejects an invalid email without touching the DB', () => {
    const res = run('create-admin', 'not-an-email')
    expect(res.status).toBe(1)
    expect(rows().users).toHaveLength(0)
  })

  it('--dry-run changes nothing', () => {
    const res = run('create-admin', 'owner@example.test', '--dry-run')
    expect(res.status).toBe(0)
    expect(rows()).toEqual({ users: [], tokens: [] })
  })
})
