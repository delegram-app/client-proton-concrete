const { Pool } = require('pg')
require('dotenv').config()

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

async function migrate() {
  const fs = require('fs')
  const path = require('path')
  const dir = path.join(__dirname, 'migrations')
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()

  await pool.query(`CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY,
    filename TEXT UNIQUE NOT NULL,
    ran_at TIMESTAMPTZ DEFAULT NOW()
  )`)

  for (const file of files) {
    const ran = await pool.query('SELECT id FROM migrations WHERE filename = $1', [file])
    if (ran.rows.length > 0) continue
    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
    await pool.query(sql)
    await pool.query('INSERT INTO migrations (filename) VALUES ($1)', [file])
    console.log('Ran migration:', file)
  }
  await pool.end()
  console.log('Migrations complete.')
}

migrate().catch(e => { console.error(e); process.exit(1) })
