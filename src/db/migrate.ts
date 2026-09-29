import { DATA_DIR, getSqlite } from './client.js'
import { backfillItemImages } from './queries.js'
import { reconcileMigrations } from './reconcileMigrations.js'
import { mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

mkdirSync(DATA_DIR, { recursive: true })

const migrationsFolder = join(__dirname, 'migrations')

reconcileMigrations(getSqlite(), migrationsFolder)
backfillItemImages()

console.log('Migrations applied successfully')
