/**
 * Database Migration Runner
 * Source: SRS-CH02 §2.4 (PostgreSQL schema management)
 *
 * Usage:
 *   npm run db:migrate            — run all pending migrations
 *   npm run db:migrate:status     — show migration status
 *   npm run db:migrate:rollback   — placeholder (manual only — no auto-rollback)
 *
 * Migrations are tracked in the `schema_migrations` table.
 * Each migration file is run exactly once, in filename order.
 * Migrations run inside a transaction — if one fails, it rolls back.
 */

import * as fs from 'fs'
import * as path from 'path'
import { Pool, PoolClient } from 'pg'

const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

// ── DB connection ──────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://adaptlearn:adaptlearn@localhost:5432/adaptlearn',
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
})

// ── Bootstrap migrations table ─────────────────────────────────────────────────
async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     VARCHAR(255) PRIMARY KEY,
      filename    VARCHAR(255) NOT NULL,
      applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      checksum    CHAR(64)     NOT NULL
    )
  `)
}

// ── SHA-256 checksum ──────────────────────────────────────────────────────────
async function sha256(content: string): Promise<string> {
  const crypto = await import('crypto')
  return crypto.createHash('sha256').update(content).digest('hex')
}

// ── Get applied migrations ─────────────────────────────────────────────────────
async function getApplied(client: any): Promise<Set<string>> {
  const res = await client.query('SELECT version FROM schema_migrations ORDER BY version')
  return new Set(res.rows.map((r: { version: string }) => r.version))
}

// ── Get migration files ────────────────────────────────────────────────────────
function getMigrationFiles(): Array<{ version: string; filename: string; filepath: string }> {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`Migrations directory not found: ${MIGRATIONS_DIR}`)
    process.exit(1)
  }

  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(filename => {
      // Extract version: "001_initial_schema.sql" → "001"
      const match = filename.match(/^(\d+)/)
      if (!match) throw new Error(`Invalid migration filename: ${filename}`)
      return {
        version: match[1],
        filename,
        filepath: path.join(MIGRATIONS_DIR, filename),
      }
    })
}

// ── Run migrations ─────────────────────────────────────────────────────────────
async function runMigrations(): Promise<void> {
  const client = await pool.connect()

  try {
    await ensureMigrationsTable(client)
    const applied = await getApplied(client)
    const files = getMigrationFiles()
    const pending = files.filter(f => !applied.has(f.version))

    if (pending.length === 0) {
      console.log('✓ All migrations already applied. Database is up to date.')
      return
    }

    console.log(`Found ${pending.length} pending migration(s):`)
    pending.forEach(f => console.log(`  → ${f.filename}`))
    console.log('')

    for (const migration of pending) {
      const sql = fs.readFileSync(migration.filepath, 'utf-8')
      const checksum = await sha256(sql)

      console.log(`Running migration: ${migration.filename}…`)

      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query(
          `INSERT INTO schema_migrations (version, filename, checksum) VALUES ($1, $2, $3)`,
          [migration.version, migration.filename, checksum]
        )
        await client.query('COMMIT')
        console.log(`  ✓ Applied: ${migration.filename}`)
      } catch (err) {
        await client.query('ROLLBACK')
        console.error(`  ✗ FAILED: ${migration.filename}`)
        console.error(`    Error: ${(err as Error).message}`)
        console.error('\nMigration rolled back. Stopping.')
        process.exit(1)
      }
    }

    console.log('\n✓ All migrations applied successfully.')
  } finally {
    client.release()
    await pool.end()
  }
}

// ── Status ─────────────────────────────────────────────────────────────────────
async function showStatus(): Promise<void> {
  const client = await pool.connect()

  try {
    await ensureMigrationsTable(client)
    const applied = await getApplied(client)
    const files = getMigrationFiles()

    console.log('\nMigration Status:')
    console.log('─'.repeat(60))
    for (const f of files) {
      const status = applied.has(f.version) ? '✓ applied' : '○ pending'
      console.log(`  [${status}] ${f.filename}`)
    }
    console.log('─'.repeat(60))
    console.log(`  ${applied.size} applied, ${files.length - applied.size} pending\n`)
  } finally {
    client.release()
    await pool.end()
  }
}

// ── CLI entry ──────────────────────────────────────────────────────────────────
const command = process.argv[2] || 'migrate'

switch (command) {
  case 'status':
    showStatus().catch(err => { console.error(err); process.exit(1) })
    break
  case 'migrate':
  default:
    runMigrations().catch(err => { console.error(err); process.exit(1) })
}
