const { Pool } = require('pg');

// Render and Supabase both hand out a connection string. Locally it points at a
// throwaway Postgres; in production it is the Supabase pooler.
const connectionString = process.env.DATABASE_URL || '';

if (!connectionString) {
  console.error('Set DATABASE_URL in .env — the shop needs a database to run.');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  // Managed Postgres presents a certificate the container does not have a root
  // for; the connection is still encrypted.
  ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
  max: 5,
});

const query = (text, params) => pool.query(text, params);

async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

async function all(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      student_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      notes TEXT,
      price INTEGER,
      quote_needed BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'pending',
      payment_status TEXT NOT NULL DEFAULT 'unpaid',
      payment_method TEXT,
      payment_ref TEXT,
      payment_order_id TEXT,
      paid_amount INTEGER,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS order_files (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      pages INTEGER,
      copies INTEGER NOT NULL DEFAULT 1,
      color BOOLEAN NOT NULL DEFAULT FALSE,
      duplex BOOLEAN NOT NULL DEFAULT FALSE,
      price INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, id DESC);
    CREATE INDEX IF NOT EXISTS idx_files_order ON order_files(order_id, position);
  `);

  // A failed upload leaves nothing behind to look at. This records what the
  // phone saw — how far it got, how long it took — so a fault that only happens
  // on someone else's network can still be diagnosed.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS upload_reports (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      outcome TEXT NOT NULL,
      detail TEXT,
      bytes_sent BIGINT,
      bytes_total BIGINT,
      took_ms INTEGER,
      attempt INTEGER,
      agent TEXT
    );
  `);

  // The code is the student's own name now, so the same one comes back every
  // time they send something, and a phone number is theirs to give or not.
  await pool.query(`
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_code_key;
    ALTER TABLE orders ALTER COLUMN phone DROP NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_orders_code ON orders(code, id DESC);
  `);
}

module.exports = { pool, query, one, all, transaction, init };
