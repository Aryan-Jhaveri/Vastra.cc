import Database from 'better-sqlite3';
import { existsSync, rmSync, copyFileSync, statSync, writeFileSync, renameSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { scryptSync, randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto';
import { safeImportDatabase, IMPORT_OFFLINE_ENV } from '../../../db/safeImport.mjs';
import { loadHostedAdmin } from './loadHosted.mjs';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';

const DATA_DIR = process.env.CLOSET_DATA_DIR || resolve(homedir(), '.closet');
const DB_PATH = resolve(DATA_DIR, 'closet.db');

const flags = new Set(['--dry-run', '--yes', '-y']);
const rawArgv = process.argv.slice(2);

// Value flags (e.g. --idempotency-key <key> or --idempotency-key=<key>) are
// extracted before positional parsing so they don't pollute [cmd, ...args].
let IDEMPOTENCY_KEY = null;
const argv = [];
for (let i = 0; i < rawArgv.length; i++) {
  const a = rawArgv[i];
  if (a === '--idempotency-key') { IDEMPOTENCY_KEY = rawArgv[++i] ?? null; continue; }
  if (a.startsWith('--idempotency-key=')) { IDEMPOTENCY_KEY = a.slice('--idempotency-key='.length); continue; }
  if (flags.has(a)) continue;
  argv.push(a);
}
const DRY_RUN = rawArgv.includes('--dry-run');
const SKIP_CONFIRM = rawArgv.includes('--yes') || rawArgv.includes('-y');

function log(msg) {
  console.log(`[admin] ${msg}`);
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

if (!existsSync(DB_PATH)) {
  console.error(`DB not found: ${DB_PATH}`);
  process.exit(1);
}

if (argv[0] === 'import-db') {
  const sourcePath = argv[1];
  if (!sourcePath) {
    console.error('Usage: node src/transport/web/admin/admin.mjs import-db <path-to-gz-or-sqlite>');
    process.exit(1);
  }
  try {
    log(`importing ${sourcePath} into ${DB_PATH}`);
    log(`requires ${IMPORT_OFFLINE_ENV}=1 and no live web lockfile`);
    const result = await safeImportDatabase({ sourcePath: resolve(sourcePath), dataDir: DATA_DIR });
    log(`backup written: ${result.backupPath}`);
    log('import complete; PRAGMA integrity_check passed');
    process.exit(0);
  } catch (err) {
    console.error(`[admin] import failed: ${err.message}`);
    process.exit(1);
  }
}

const db = new Database(DB_PATH);
db.pragma('journal_mode=WAL');

if (DRY_RUN) console.log('[DRY RUN] — no changes will be committed\n');

function runInTransaction(fn) {
  const txn = db.transaction(() => {
    fn();
    if (DRY_RUN) {
      throw new Error('DRY_RUN_ROLLBACK');
    }
  });
  try {
    txn();
  } catch (e) {
    if (e.message === 'DRY_RUN_ROLLBACK') {
      log('rolled back (dry run)');
    } else {
      throw e;
    }
  }
}

// ── R2 backup helpers ──────────────────────────────────────────────────

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? ''
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID ?? ''
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY ?? ''
const R2_BACKUP_BUCKET = process.env.R2_BACKUP_BUCKET ?? ''
const BACKUP_ENCRYPTION_SECRET = process.env.BACKUP_ENCRYPTION_SECRET ?? ''

function getR2Client() {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BACKUP_BUCKET) {
    throw new Error('R2 credentials not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BACKUP_BUCKET')
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  })
}

function getBackupBucket() {
  if (!R2_BACKUP_BUCKET) throw new Error('R2_BACKUP_BUCKET is not set')
  return R2_BACKUP_BUCKET
}

function encryptBackup(plain) {
  const key = Buffer.from(BACKUP_ENCRYPTION_SECRET, 'base64')
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_SECRET must decode to exactly 32 bytes')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, encrypted])
}

function decryptBackup(ciphertext) {
  const key = Buffer.from(BACKUP_ENCRYPTION_SECRET, 'base64')
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_SECRET must decode to exactly 32 bytes')
  if (ciphertext.length < 28) throw new Error('Ciphertext too short')
  const iv = ciphertext.subarray(0, 12)
  const authTag = ciphertext.subarray(12, 28)
  const encrypted = ciphertext.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}

async function listBackups(days = 30) {
  const client = getR2Client()
  const result = await client.send(new ListObjectsV2Command({
    Bucket: getBackupBucket(),
    Prefix: 'db/',
    MaxKeys: 1000,
  }))
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const objects = (result.Contents ?? [])
    .map(obj => ({
      key: obj.Key ?? '',
      size: obj.Size ?? 0,
      lastModified: obj.LastModified ?? new Date(0),
    }))
    .filter(obj => obj.lastModified >= cutoff)
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
  return objects
}

async function getBackup(key) {
  const client = getR2Client()
  const result = await client.send(new GetObjectCommand({
    Bucket: getBackupBucket(),
    Key: key,
  }))
  if (!result.Body) throw new Error(`No body for ${key}`)
  const chunks = []
  for await (const chunk of result.Body) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function headBackup(key) {
  const client = getR2Client()
  try {
    const result = await client.send(new HeadObjectCommand({
      Bucket: getBackupBucket(),
      Key: key,
    }))
    return {
      size: result.ContentLength ?? 0,
      lastModified: result.LastModified ?? new Date(),
      metadata: result.Metadata,
    }
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null
    throw err
  }
}

// ── Commands ──────────────────────────────────────────────────────────

async function deleteUser(email) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    console.error(`No user found with email: ${email}`);
    process.exit(1);
  }

  log(`found user: id=${user.id} email=${user.email}`);

  // Hosted: revokes the user's OpenRouter key before any row is deleted.
  if (hosted) await hosted.hooks.beforeUserDelete(user)

  runInTransaction(() => {
    const exec = (sql, params = [user.id]) =>
      db.prepare(sql).run(...[].concat(params));

    // Order: child tables first, then parent

    // 1. share_payloads (3 user columns)
    exec('DELETE FROM share_payloads WHERE user_id = ? OR created_by_user_id = ? OR recipient_user_id = ?', [user.id, user.id, user.id]);

    // 2. collection_outfits (via collections)
    exec('DELETE FROM collection_outfits WHERE collection_id IN (SELECT id FROM collections WHERE user_id = ?)');

    // 3. collections
    exec('DELETE FROM collections WHERE user_id = ?');

    // 4. job_runs
    exec('DELETE FROM job_runs WHERE user_id = ?');

    // 5. scheduled_jobs
    exec('DELETE FROM scheduled_jobs WHERE user_id = ?');

    // 6. push_subscriptions
    exec('DELETE FROM push_subscriptions WHERE user_id = ?');

    // 7. tryon_results
    exec('DELETE FROM tryon_results WHERE user_id = ?');

    // 8. item_images (belt-and-suspenders; items cascade covers too)
    exec('DELETE FROM item_images WHERE user_id = ?');

    // 9. outfits
    exec('DELETE FROM outfits WHERE user_id = ?');

    // 10. items (cascades to item_images via FK)
    exec('DELETE FROM items WHERE user_id = ?');

    // 11. user_photos
    exec('DELETE FROM user_photos WHERE user_id = ?');

    // 12. suggest_events
    exec('DELETE FROM suggest_events WHERE user_id = ?');

    // 13. discover_events
    exec('DELETE FROM discover_events WHERE user_id = ?');

    // 14. embeddings
    exec('DELETE FROM embeddings WHERE user_id = ?');

    // 15. settings
    exec('DELETE FROM settings WHERE user_id = ?');

    // 16. login_tokens (by email)
    exec('DELETE FROM login_tokens WHERE email = ?', [user.email]);

    // 17. users (cascades to sessions + oauth_accounts via FK)
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

    const count = db.prepare("SELECT total_changes() as c").get();
    log(`total changes: ${count.c}`);
  });

  log('user and all associated data deleted');

  // Remove the user's on-disk image directory (DB rows handled above). This was
  // previously missing — deleting a user left orphaned image files behind.
  const userDir = resolve(DATA_DIR, 'users', user.id);
  if (existsSync(userDir)) {
    if (DRY_RUN) {
      log(`[DRY RUN] would rm -rf ${userDir}`);
    } else {
      rmSync(userDir, { recursive: true, force: true });
      log(`removed image directory ${userDir}`);
    }
  }
}

function setPassword(password) {
  if (!password || password.length < 3) {
    console.error('Password must be at least 3 characters');
    process.exit(1);
  }

  runInTransaction(() => {
    db.prepare(
      'INSERT INTO settings (key, user_id, value) VALUES (?, ?, ?) ON CONFLICT(key, user_id) DO UPDATE SET value = ?'
    ).run('password', 'self', password, password);
  });

  log('admin password updated (settings: key=password, user=self)');
}

function setUserPassword(email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    console.error(`No user found: ${email}`);
    process.exit(1);
  }

  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  const passwordHash = `${salt}:${hash}`;

  runInTransaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
  });

  log(`password updated for ${email}`);
}

function listUsers() {
  const users = db.prepare('SELECT id, email, name, created_at, is_admin FROM users ORDER BY created_at DESC').all();
  if (users.length === 0) {
    log('no users found');
    return;
  }
  log(`${users.length} user(s):`);
  for (const u of users) {
    const created = new Date(u.created_at).toISOString();
    const adminFlag = u.is_admin ? ' [admin]' : '';
    console.log(`  ${u.email}  (id=${u.id}, name=${u.name ?? '-'}, created=${created}${adminFlag})`);
  }
}

function setUserAdminFlag(email, isAdmin) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    console.error(`No user found: ${email}`);
    process.exit(1);
  }

  runInTransaction(() => {
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, user.id);
  });

  log(`set is_admin=${isAdmin ? 1 : 0} for ${email}`);
}

function showUser(email) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    console.error(`No user found: ${email}`);
    process.exit(1);
  }
  // Redact encrypted key from display — never log the ciphertext
  const display = { ...user }
  if (display.openrouter_key_encrypted) display.openrouter_key_encrypted = '[REDACTED]'
  if (display.password_hash) display.password_hash = '[REDACTED]'
  console.log(JSON.stringify(display, null, 2));

  // Show row counts per table for this user
  const tables = [
    'items', 'outfits', 'user_photos', 'tryon_results', 'scheduled_jobs',
    'collections', 'item_images', 'job_runs', 'push_subscriptions',
    'share_payloads', 'embeddings', 'suggest_events', 'discover_events',
    'settings', 'sessions', 'login_tokens',
  ];
  console.log('\nrow counts:');
  for (const t of tables) {
    try {
      let count;
      if (t === 'share_payloads') {
        count = db.prepare(
          `SELECT count(*) as c FROM share_payloads WHERE user_id = ? OR created_by_user_id = ? OR recipient_user_id = ?`
        ).get(user.id, user.id, user.id);
      } else if (t === 'login_tokens') {
        count = db.prepare('SELECT count(*) as c FROM login_tokens WHERE email = ?').get(user.email);
      } else {
        count = db.prepare(`SELECT count(*) as c FROM ${t} WHERE user_id = ?`).get(user.id);
      }
      if (count.c > 0) console.log(`  ${t}: ${count.c}`);
    } catch { /* table might not exist */ }
  }
}

// ── Main ──────────────────────────────────────────────────────────────

const SHARED_USAGE = {
  'create-user': '  create-user <email> [name]                   Create a user + print a one-time sign-in link (15 min)',
  'create-admin': '  create-admin <email> [name]                  Create (or promote) an admin + print a one-time sign-in link (15 min)',
  'delete-broken-items': '  delete-broken-items [id]                     Find and delete items with missing image files',
  'delete-broken-tryon': '  delete-broken-tryon [id]                     Find and delete tryon results with missing image files',
  'delete-user': '  delete-user [email]                          Delete user & all data (prompts if missing)',
  'import-db': '  import-db <path>                             Safely import a .db or .db.gz while web is stopped',
  'list-backups': '  list-backups [--days N]                      List DB backups in R2 (default: 30 days)',
  'list-users': '  list-users                                   List all users',
  'normalize-occasions': '  normalize-occasions                          Normalise case in items & outfits occasion (idempotent)',
  'normalize-tags': '  normalize-tags                               Normalise case/dedup in items & outfits tags (idempotent)',
  'restore-db': '  restore-db <key> [--dry-run]                 Restore DB from R2 backup (key from list-backups)',
  'set-admin': '  set-admin [email] [true/false]               Set a user\'s is_admin flag (default: true)',
  'set-password': '  set-password [pw]                            Change admin password (prompts if missing)',
  'set-user-password': '  set-user-password [email] [pw]               Set a user\'s login password',
  'show-user': '  show-user [email]                            Show user details + data counts',
}

function usage() {
  const lines = { ...SHARED_USAGE, ...(hosted?.usage ?? {}) }
  return `Usage: node src/transport/web/admin/admin.mjs <command> [args]

${Object.keys(lines).sort().map(k => lines[k]).join('\n')}

Flags:
  --dry-run                                    Preview destructive commands without committing
  --yes / -y                                   Skip confirmation prompt`
}

// Hosted-only commands (OpenRouter keys, token wallet), when the hosted module is present.
// Hosted commands and hooks (key minting, wallet) only on a hosted instance:
// a self-hosted create-user/create-admin must not try to mint OpenRouter keys.
const hosted = process.env.HOSTED_MODE === 'true'
  ? await loadHostedAdmin({ db, log, prompt, runInTransaction, DRY_RUN, SKIP_CONFIRM, IDEMPOTENCY_KEY })
  : null;

const [cmd, ...args] = argv;

(async () => {
  let email, password;

  if (hosted && Object.hasOwn(hosted.commands, cmd)) {
    await hosted.commands[cmd](args);
  } else switch (cmd) {
    case 'normalize-tags': {
      function normalizeTags(tags) {
        if (!Array.isArray(tags)) return []
        const seen = new Set()
        const out = []
        for (const t of tags) {
          if (typeof t !== 'string') continue
          const n = t.trim().toLowerCase()
          if (!n || seen.has(n)) continue
          seen.add(n)
          out.push(n)
        }
        return out
      }

      runInTransaction(() => {
        const users = db.prepare('SELECT id FROM users').all()
        let itemTotal = 0
        let outfitTotal = 0

        for (const user of users) {
          let itemChanged = 0
          let outfitChanged = 0

          const userItems = db.prepare('SELECT id, tags FROM items WHERE user_id = ?').all(user.id)
          for (const item of userItems) {
            let tags
            try { tags = JSON.parse(item.tags || '[]') } catch { tags = [] }
            const normalized = normalizeTags(tags)
            if (JSON.stringify(normalized) !== JSON.stringify(tags)) {
              db.prepare('UPDATE items SET tags = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(normalized), Date.now(), item.id)
              itemChanged++
            }
          }

          const userOutfits = db.prepare('SELECT id, tags FROM outfits WHERE user_id = ?').all(user.id)
          for (const outfit of userOutfits) {
            let tags
            try { tags = JSON.parse(outfit.tags || '[]') } catch { tags = [] }
            const normalized = normalizeTags(tags)
            if (JSON.stringify(normalized) !== JSON.stringify(tags)) {
              db.prepare('UPDATE outfits SET tags = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(normalized), Date.now(), outfit.id)
              outfitChanged++
            }
          }

          if (itemChanged + outfitChanged > 0) {
            log(`user=${user.id}: ${itemChanged} items, ${outfitChanged} outfits normalised`)
          }
          itemTotal += itemChanged
          outfitTotal += outfitChanged
        }

        log(`total: ${itemTotal} items, ${outfitTotal} outfits normalised`)
      })
      break
    }

    case 'normalize-occasions': {
      function normalizeTags(tags) {
        if (!Array.isArray(tags)) return []
        const seen = new Set()
        const out = []
        for (const t of tags) {
          if (typeof t !== 'string') continue
          const n = t.trim().toLowerCase()
          if (!n || seen.has(n)) continue
          seen.add(n)
          out.push(n)
        }
        return out
      }

      runInTransaction(() => {
        const users = db.prepare('SELECT id FROM users').all()
        let itemTotal = 0
        let outfitTotal = 0

        for (const user of users) {
          let itemChanged = 0
          let outfitChanged = 0

          // items.occasion is a JSON array stored as text
          const userItems = db.prepare('SELECT id, occasion FROM items WHERE user_id = ?').all(user.id)
          for (const item of userItems) {
            let occasions
            try { occasions = JSON.parse(item.occasion || '[]') } catch { occasions = [] }
            const normalized = normalizeTags(occasions)
            if (JSON.stringify(normalized) !== JSON.stringify(occasions)) {
              db.prepare('UPDATE items SET occasion = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(normalized), Date.now(), item.id)
              itemChanged++
            }
          }

          // outfits.occasion is a single string column — trim + lowercase, NULL if empty
          const userOutfits = db.prepare('SELECT id, occasion FROM outfits WHERE user_id = ?').all(user.id)
          for (const outfit of userOutfits) {
            const original = outfit.occasion
            let next
            if (typeof original !== 'string') {
              next = null
            } else {
              const trimmed = original.trim().toLowerCase()
              next = trimmed || null
            }
            if (next !== original) {
              db.prepare('UPDATE outfits SET occasion = ?, updated_at = ? WHERE id = ?').run(next, Date.now(), outfit.id)
              outfitChanged++
            }
          }

          if (itemChanged + outfitChanged > 0) {
            log(`user=${user.id}: ${itemChanged} items, ${outfitChanged} outfits normalised`)
          }
          itemTotal += itemChanged
          outfitTotal += outfitChanged
        }

        log(`total: ${itemTotal} items, ${outfitTotal} outfits normalised`)
      })
      break
    }

    case 'delete-user':
      email = args[0] || await prompt('Email to delete: ');
      if (!email) { console.error('email is required'); process.exit(1); }
      if (!SKIP_CONFIRM && !DRY_RUN) {
        const confirm = await prompt(`Delete user "${email}" and ALL their data? [y/N] `);
        if (confirm.toLowerCase() !== 'y') { console.log('aborted'); process.exit(0); }
      }
      await deleteUser(email);
      break;

    case 'set-password':
      password = args[0] || await prompt('New admin password: ');
      if (!password) { console.error('password is required'); process.exit(1); }
      setPassword(password);
      break;

    case 'set-user-password':
      email = args[0] || await prompt('User email: ');
      if (!email) { console.error('email is required'); process.exit(1); }
      password = args[1] || await prompt('New password: ');
      if (!password) { console.error('password is required'); process.exit(1); }
      setUserPassword(email, password);
      break;

    case 'list-users':
      listUsers();
      break;

    case 'set-admin':
      email = args[0] || await prompt('User email: ');
      if (!email) { console.error('email is required'); process.exit(1); }
      {
        const flagStr = args[1] || 'true';
        const flag = flagStr.toLowerCase() === 'true' || flagStr === '1';
        if (!SKIP_CONFIRM) {
          const confirm = await prompt(`Set is_admin=${flag ? 1 : 0} for "${email}"? [y/N] `);
          if (confirm.toLowerCase() !== 'y') { console.log('aborted'); process.exit(0); }
        }
        setUserAdminFlag(email, flag);
      }
      break;

    case 'show-user':
      email = args[0] || await prompt('Email: ');
      if (!email) { console.error('email is required'); process.exit(1); }
      showUser(email);
      break;

    case 'delete-broken-items': {
      const uid = args[0] || await prompt('User ID: ');
      if (!uid) { console.error('User ID is required'); process.exit(1); }

      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
      if (!user) {
        console.error(`No user found: ${uid}`);
        process.exit(1);
      }

      const allItems = db.prepare('SELECT * FROM items WHERE user_id = ?').all(uid);
      const missingItems = [];

      for (const item of allItems) {
        const perUser = resolve(DATA_DIR, 'users', uid, item.image_uri);
        if (existsSync(perUser)) continue;
        if (uid === 'self') {
          const legacy = resolve(DATA_DIR, item.image_uri);
          if (existsSync(legacy)) continue;
        }
        missingItems.push(item);
      }

      if (missingItems.length === 0) {
        log(`All ${allItems.length} items have their image files on disk. Nothing to delete.`);
        break;
      }

      log(`Found ${missingItems.length} items with missing image files (out of ${allItems.length} total):`);
      for (const item of missingItems) {
        console.log(`  ${item.id}  ${item.image_uri}  name="${(item.ai_description ?? '-').slice(0, 60)}"`);
      }

      if (!SKIP_CONFIRM && !DRY_RUN) {
        const confirm = await prompt(`Delete these ${missingItems.length} items? Type "yes" to confirm: `);
        if (confirm !== 'yes') { console.log('aborted'); process.exit(0); }
      }

      runInTransaction(() => {
        const deleteItem = db.prepare('DELETE FROM items WHERE id = ? AND user_id = ?');
        const deleteEmbeddings = db.prepare("DELETE FROM embeddings WHERE level = 'item' AND ref_id = ?");
        for (const item of missingItems) {
          deleteItem.run(item.id, uid);
          deleteEmbeddings.run(item.id);
        }
        log(`Deleted ${missingItems.length} items with broken image references`);
      });
      break;
    }

    case 'delete-broken-tryon': {
      const uid = args[0] || await prompt('User ID: ');
      if (!uid) { console.error('User ID is required'); process.exit(1); }

      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
      if (!user) {
        console.error(`No user found: ${uid}`);
        process.exit(1);
      }

      const allResults = db.prepare('SELECT * FROM tryon_results WHERE user_id = ?').all(uid);
      const missingResults = [];

      for (const result of allResults) {
        const perUser = resolve(DATA_DIR, 'users', uid, result.result_image_uri);
        if (existsSync(perUser)) continue;
        if (uid === 'self') {
          const legacy = resolve(DATA_DIR, result.result_image_uri);
          if (existsSync(legacy)) continue;
        }
        missingResults.push(result);
      }

      if (missingResults.length === 0) {
        log(`All ${allResults.length} tryon results have their image files on disk. Nothing to delete.`);
        break;
      }

      log(`Found ${missingResults.length} tryon results with missing image files (out of ${allResults.length} total):`);
      for (const result of missingResults) {
        console.log(`  ${result.id}  ${result.result_image_uri}  created=${new Date(result.created_at).toISOString()}`);
      }

      if (!SKIP_CONFIRM && !DRY_RUN) {
        const confirm = await prompt(`Delete these ${missingResults.length} tryon results? Type "yes" to confirm: `);
        if (confirm !== 'yes') { console.log('aborted'); process.exit(0); }
      }

      runInTransaction(() => {
        const deleteResult = db.prepare('DELETE FROM tryon_results WHERE id = ? AND user_id = ?');
        for (const result of missingResults) {
          deleteResult.run(result.id, uid);
        }
        log(`Deleted ${missingResults.length} tryon results with broken image references`);
      });
      break;
    }

    case 'create-user': {
      const rawEmail = args[0] || await prompt('User email: ')
      const name = args[1] || null
      if (!rawEmail) { console.error('email is required'); process.exit(1); }
      const email = rawEmail.toLowerCase()

      const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
      if (existing) {
        console.error(`User with email ${email} already exists`)
        process.exit(1)
      }

      // Use a nanoid-compatible id (URL-safe). The runtime uses nanoid; for the
      // admin script we generate a 21-char hex slug — wide enough that the FK
      // collision space is irrelevant.
      const userId = randomBytes(16).toString('hex').slice(0, 21)
      const loginTokenValue = randomBytes(32).toString('hex')
      const createdAt = Date.now()
      const tokenExpiresAt = createdAt + 15 * 60 * 1000

      if (DRY_RUN) {
        log(`[DRY RUN] would create user ${email} (id=${userId}) + login token (15min)`)
        if (hosted) hosted.hooks.onUserCreateDryRun()
        break
      }

      // Step 1 — user row + login token (atomic).
      runInTransaction(() => {
        db.prepare('INSERT INTO users (id, email, name, created_at, accepted_terms_at, email_verified_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(userId, email, name, createdAt, createdAt, null)
        db.prepare('INSERT INTO login_tokens (id, email, token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
          .run(randomBytes(12).toString('hex'), email, loginTokenValue, createdAt, tokenExpiresAt)
      })

      if (hosted) await hosted.hooks.afterUserCreated({ userId, email })

      const verifyUrl = `${process.env.WEB_APP_URL || 'http://localhost:3000'}/auth/verify?token=${loginTokenValue}`
      log(`Created user ${email} (id=${userId})`)
      log(`One-time sign-in link (expires in 15 min): ${verifyUrl}`)
      break
    }

    // #315 — the first admin on a self-hosted instance. Sign-ups are closed by
    // default there, so this is how the owner gets in: it creates the account
    // (or promotes an existing one) and prints a one-time sign-in link, which
    // works without any email provider.
    case 'create-admin': {
      const rawEmail = args[0] || await prompt('Admin email: ')
      if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) { console.error('a valid email is required'); process.exit(1); }
      const email = rawEmail.toLowerCase()
      const name = args[1] || null
      const now = Date.now()

      const existing = db.prepare('SELECT id, is_admin FROM users WHERE email = ?').get(email)
      const otherAdmins = db.prepare('SELECT email FROM users WHERE is_admin = 1 AND email != ?').all(email)
      if (otherAdmins.length) log(`note: other admins already exist (${otherAdmins.map(a => a.email).join(', ')})`)

      const userId = existing?.id ?? randomBytes(16).toString('hex').slice(0, 21)
      const loginTokenValue = randomBytes(32).toString('hex')

      if (DRY_RUN) {
        log(`[DRY RUN] would ${existing ? 'promote' : 'create'} admin ${email} (id=${userId}) + login token (15min)`)
        break
      }

      runInTransaction(() => {
        if (existing) {
          db.prepare('UPDATE users SET is_admin = 1, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').run(now, userId)
        } else {
          db.prepare('INSERT INTO users (id, email, name, created_at, accepted_terms_at, email_verified_at, is_admin) VALUES (?, ?, ?, ?, ?, ?, 1)')
            .run(userId, email, name, now, now, now)
        }
        db.prepare('INSERT INTO login_tokens (id, email, token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
          .run(randomBytes(12).toString('hex'), email, loginTokenValue, now, now + 15 * 60 * 1000)
      })

      if (!existing && hosted) await hosted.hooks.afterUserCreated({ userId, email })

      const base = process.env.WEB_APP_URL || 'http://localhost:3000'
      log(`${existing ? 'Promoted' : 'Created'} admin ${email} (id=${userId})`)
      log(`One-time sign-in link (expires in 15 min): ${base}/auth/verify?token=${loginTokenValue}`)
      log(`Later sign-ins: enter this email on the sign-in page. Without RESEND_API_KEY the link is printed in the server log.`)
      break
    }

    case 'list-backups': {
      const daysIdx = args.indexOf('--days')
      const days = daysIdx !== -1 && args[daysIdx + 1] ? parseInt(args[daysIdx + 1], 10) : 30
      if (isNaN(days) || days <= 0) { console.error('--days must be a positive integer'); process.exit(1); }
      try {
        const backups = await listBackups(days)
        if (backups.length === 0) {
          log('No backups found')
          break
        }
        log(`${backups.length} backup(s) in the last ${days} days:`)
        console.log('  key                                                   size       last_modified')
        console.log('  ─────────────────────────────────────────────────────────────────────────────────')
        for (const b of backups) {
          const sizeKB = (b.size / 1024).toFixed(1).padStart(7)
          const ts = b.lastModified.toISOString().replace('T', ' ').slice(0, 19)
          console.log(`  ${b.key.padEnd(52)} ${sizeKB} KB   ${ts}`)
        }
      } catch (err) {
        console.error(`[list-backups] ${err.message}`)
        process.exit(1)
      }
      break
    }

    case 'restore-db': {
      let key = args[0]
      if (!key) key = await prompt('Backup key (e.g. db/2024-01-15/closet-030000.db.enc): ')
      if (!key) { console.error('key is required'); process.exit(1); }
      const isDryRun = DRY_RUN || args.includes('--dry-run')

      // Safety check: refuse if WAL exists and was recently written (service-live heuristic)
      const walPath = resolve(DATA_DIR, 'closet.db-wal')
      if (existsSync(walPath)) {
        const stat = statSync(walPath)
        const ageMs = Date.now() - stat.mtimeMs
        if (stat.size > 0 && ageMs < 5000) {
          console.error('[restore-db] WAL file exists with recent writes (last 5s). Scale to zero in Render first.')
          console.error('[restore-db] Render dashboard → service → Manual Deploy → Select branch → Suspend')
          process.exit(1)
        }
      }

      // Confirm key
      if (!SKIP_CONFIRM && !isDryRun) {
        const confirmKey = await prompt(`Type the key again to confirm: "${key}": `)
        if (confirmKey !== key) { console.log('aborted — key mismatch'); process.exit(0); }
      }

      try {
        if (!BACKUP_ENCRYPTION_SECRET) {
          console.error('[restore-db] BACKUP_ENCRYPTION_SECRET not set')
          process.exit(1)
        }

        const head = await headBackup(key)
        if (!head) {
          console.error(`[restore-db] Backup not found: ${key}`)
          process.exit(1)
        }
        const expectedSha256 = head.metadata?.['sha256-plain']
        if (!expectedSha256) {
          console.error(`[restore-db] Backup missing sha256-plain metadata`)
          process.exit(1)
        }

        log(`Downloading ${key} (${(head.size / 1024).toFixed(1)} KB)...`)
        const encrypted = await getBackup(key)
        log('Decrypting...')
        const decrypted = decryptBackup(encrypted)

        log('Verifying SHA-256...')
        const actualSha256 = createHash('sha256').update(decrypted).digest('hex')
        if (actualSha256 !== expectedSha256) {
          console.error(`[restore-db] SHA-256 mismatch! Expected ${expectedSha256}, got ${actualSha256}`)
          console.error('[restore-db] Backup may be corrupted or tampered. Aborting.')
          process.exit(1)
        }
        log(`SHA-256 verified: ${actualSha256.slice(0, 16)}...`)

        if (isDryRun) {
          log('[DRY RUN] would restore to ' + resolve(DATA_DIR, 'closet.db'))
          log(`[DRY RUN] verified checksum, size=${(decrypted.length / 1024).toFixed(1)} KB`)
          break
        }

        const dbPath = resolve(DATA_DIR, 'closet.db')
        const wal = resolve(DATA_DIR, 'closet.db-wal')
        const shm = resolve(DATA_DIR, 'closet.db-shm')
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        const preRestoreCopy = `${dbPath}.pre-restore-${ts}`
        const tmpPath = resolve(DATA_DIR, `closet-restored-${ts}.db`)

        if (existsSync(dbPath)) {
          log(`Creating pre-restore copy: ${preRestoreCopy}`)
          copyFileSync(dbPath, preRestoreCopy)
        }

        log(`Writing restored DB to ${tmpPath}`)
        writeFileSync(tmpPath, decrypted)

        log('Removing WAL/SHM files...')
        if (existsSync(wal)) rmSync(wal)
        if (existsSync(shm)) rmSync(shm)

        log(`Moving ${tmpPath} → ${dbPath}`)
        renameSync(tmpPath, dbPath)

        log('Restore complete!')
        console.log('')
        console.log('  Pre-restore copy: ' + preRestoreCopy)
        console.log('  Restart the service in Render to pick up the new DB.')
        console.log('')
        console.log('  Render dashboard → service → Manual Deploy → Select branch → Deploy')
      } catch (err) {
        console.error(`[restore-db] ${err.message}`)
        if (err.message.includes('Unsupported state') || err.message.includes('auth tag')) {
          console.error('[restore-db] Decryption failed — BACKUP_ENCRYPTION_SECRET may be wrong')
        }
        process.exit(1)
      }
      break
    }

    default:
      console.log(usage());
      process.exit(1);
  }

  db.close();
})();
