require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const db = require('./db');
const storage = require('./storage');

// One-time move of the orders that were taken while the shop ran on the counter
// machine. Safe to run twice: orders already carried across are skipped by code.
const SQLITE_PATH = path.join(__dirname, 'printshop.db');
const LOCAL_UPLOADS = path.join(__dirname, 'uploads');

async function run() {
  if (!fs.existsSync(SQLITE_PATH)) {
    console.log('No printshop.db here — nothing to migrate.');
    return;
  }

  await db.init();
  await storage.ready();

  const old = new Database(SQLITE_PATH, { readonly: true });
  const orders = old.prepare('SELECT * FROM orders ORDER BY id').all();
  const filesFor = old.prepare('SELECT * FROM order_files WHERE order_id = ? ORDER BY position');

  let moved = 0;
  let skipped = 0;
  let missingFiles = 0;

  for (const order of orders) {
    const already = await db.one('SELECT 1 FROM orders WHERE code = $1', [order.code]);
    if (already) {
      skipped += 1;
      continue;
    }

    const files = filesFor.all(order.id);

    for (const file of files) {
      const source = path.join(LOCAL_UPLOADS, file.stored_name);
      if (!fs.existsSync(source)) {
        missingFiles += 1;
        continue;
      }
      await storage.save(file.stored_name, await fs.promises.readFile(source));
    }

    await db.transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO orders
          (code, student_name, phone, notes, price, quote_needed, status,
           payment_status, payment_method, payment_ref, payment_order_id,
           paid_amount, paid_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [
          order.code,
          order.student_name,
          order.phone,
          order.notes,
          order.price,
          Boolean(order.quote_needed),
          order.status,
          order.payment_status || 'unpaid',
          order.payment_method,
          order.payment_ref,
          order.payment_order_id,
          order.paid_amount,
          order.paid_at ? `${order.paid_at} UTC` : null,
          order.created_at ? `${order.created_at} UTC` : null,
        ]
      );

      for (const file of files) {
        await client.query(
          `INSERT INTO order_files
            (order_id, position, original_name, stored_name, kind, size_bytes, pages,
             copies, color, duplex, price)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            rows[0].id,
            file.position,
            file.original_name,
            file.stored_name,
            file.kind,
            file.size_bytes,
            file.pages,
            file.copies,
            Boolean(file.color),
            Boolean(file.duplex),
            file.price,
          ]
        );
      }
    });

    moved += 1;
  }

  old.close();
  await db.pool.end();

  console.log(`Moved ${moved} order(s), skipped ${skipped} already present.`);
  if (missingFiles > 0) {
    console.log(`${missingFiles} file(s) had no copy on disk; their orders moved without them.`);
  }
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
